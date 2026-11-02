import type { AuditResult, CheckResult, FindingDraft, FindingSeverity } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Supabase project health (PRD §7.4): is the project running (free
// projects get paused), and are its services healthy? Reads only: the
// access token can't be limited to read-only, so only GET endpoints are used.

const API = "https://api.supabase.com/v1";

type Project = { id: string; ref?: string; name: string; region?: string; status: string };
type Health = { name: string; healthy: boolean; status?: string; error?: string };

async function sb<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Supabase", ttlMs });
}

const refOf = (p: Project) => p.ref ?? p.id;

// Statuses that mean the project isn't serving.
const NOT_RUNNING = new Set(["INACTIVE", "PAUSED", "PAUSING", "REMOVED", "INIT_FAILED", "ACTIVE_UNHEALTHY"]);
const STARTING = new Set(["COMING_UP", "RESTORING", "UPGRADING", "RESTARTING", "GOING_DOWN", "RESIZING"]);

export function describeStatus(status: string): { state: "up" | "down" | "unknown"; text: string } {
  if (status === "ACTIVE_HEALTHY") return { state: "up", text: "Running" };
  if (NOT_RUNNING.has(status)) {
    return { state: "down", text: status === "INACTIVE" || status === "PAUSED" || status === "PAUSING" ? "Project is paused" : `Project status: ${status.toLowerCase().replace(/_/g, " ")}` };
  }
  if (STARTING.has(status)) return { state: "unknown", text: `Project is ${status.toLowerCase().replace(/_/g, " ")}` };
  return { state: "unknown", text: `Project status: ${status}` };
}

export function unhealthyServices(list: Health[]): string[] {
  return list.filter((s) => !s.healthy).map((s) => (s.error ? `${s.name} (${s.error})` : s.name));
}

// One of Supabase's security advisors' findings (GET
// /v1/projects/{ref}/advisors/security): its `remediation` is a link to the
// lint's page in Supabase's docs.
export type Lint = {
  name: string;
  title: string;
  level: "ERROR" | "WARN" | "INFO";
  categories?: string[];
  description: string;
  detail: string;
  remediation: string;
  metadata?: { schema?: string; name?: string; entity?: string; type?: string };
  cache_key: string;
};

const SEVERITY: Record<Lint["level"], FindingSeverity> = { ERROR: "high", WARN: "medium", INFO: "low" };

// A name as SQL writes it: quoted only when it has to be.
const ident = (s: string) => (/^[a-z_][a-z0-9_$]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

type Words = { title: string; why: string; steps: string; code?: string; dashboard?: string };

// Plain words for the lints people meet most; the rest keep Supabase's own.
function wordsFor(l: Lint, obj: string | undefined, sql: string | undefined, ref: string): Words | undefined {
  const emailSettings = `https://supabase.com/dashboard/project/${encodeURIComponent(ref)}/auth/providers?provider=Email`;
  switch (l.name) {
    case "rls_disabled_in_public":
      return {
        title: `Row Level Security is off on ${obj ?? "a public table"}: anyone with your anon key can read and change every row`,
        why: "Tables in the public schema are served by Supabase's API, and the anon key ships in your site's code. Without Row Level Security, that key reads, edits and deletes every row.",
        steps: "Turn on Row Level Security for the table (in the SQL editor, or Table Editor → the table → RLS disabled → Enable RLS), then add a policy for each thing your app does with it. With RLS on and no policies, the API returns nothing, so add the policies straight after.",
        ...(sql ? { code: `alter table ${sql} enable row level security;\n-- Then add policies, for example:\n-- create policy "Owners read their rows" on ${sql} for select to authenticated using ((select auth.uid()) = user_id);` } : {}),
      };
    case "policy_exists_rls_disabled":
      return {
        title: `${obj ?? "A table"} has policies, but Row Level Security is off, so they do nothing`,
        why: "Policies only apply once Row Level Security is on. Until then the table is open to anyone with your anon key, whatever the policies say.",
        steps: "Turn on Row Level Security for the table in the SQL editor (or Table Editor → the table → Enable RLS). Its existing policies take effect at once.",
        ...(sql ? { code: `alter table ${sql} enable row level security;` } : {}),
      };
    case "rls_enabled_no_policy":
      return {
        title: `${obj ?? "A table"} has Row Level Security on but no policies, so the API can't reach it`,
        why: "With no policies, Supabase's API returns no rows and refuses every change. That's safe, but if the app reads this table through the API it gets nothing.",
        steps: "If the app uses this table through the API, add policies for what it does (Authentication → Policies). If only your server touches it with the service key, this is fine and can be ignored.",
      };
    case "security_definer_view":
      return {
        title: `The view ${obj ?? "in the public schema"} ignores Row Level Security`,
        why: "The view runs with its creator's rights, not the visitor's, so anyone with your anon key sees every row of the tables behind it, whatever their policies say.",
        steps: "Make the view run with the visitor's rights (Postgres 15 or later) in the SQL editor, or move it out of the public schema.",
        ...(sql ? { code: `alter view ${sql} set (security_invoker = on);` } : {}),
      };
    case "function_search_path_mutable":
      return {
        title: `The function ${obj ?? "in the database"} has no fixed search path`,
        why: "A function without a fixed search_path finds tables and functions by whatever schema search path the caller has, so someone able to create objects could make it run theirs instead.",
        steps: "Fix the function's search path in the SQL editor, and refer to tables inside it by full name (public.orders). If several functions share the name, add the argument types after it.",
        ...(sql ? { code: `alter function ${sql} set search_path = '';` } : {}),
      };
    case "auth_users_exposed":
      return {
        title: `${obj ?? "A view"} exposes your users' details through the API`,
        why: "It shows rows from auth.users (emails, phone numbers, sign-in details) to Supabase's API, where your anon key can read them.",
        steps: "Drop the view or move it out of the public schema, or make it run with the visitor's rights and filter it to their own row.",
      };
    case "auth_leaked_password_protection":
      return {
        title: "Leaked password protection is off",
        why: "People can sign up with, or change to, a password that's already in public breach lists, which attackers try first.",
        steps: "In Supabase, open Authentication → Sign In / Providers → Email and turn on leaked password protection (it checks passwords against HaveIBeenPwned), then save. It needs the Pro plan or higher.",
        dashboard: emailSettings,
      };
    case "auth_otp_long_expiry":
      return {
        title: "Email sign-in codes and links stay valid too long",
        why: "A sign-in link or code that lasts more than an hour gives anyone who gets hold of the email that much longer to use it.",
        steps: "In Supabase, open Authentication → Sign In / Providers → Email and set Email OTP Expiration to 3600 seconds or less, then save.",
        dashboard: emailSettings,
      };
    case "extension_in_public":
      return {
        title: `The extension ${l.metadata?.name ?? ""} is installed in the public schema`.replace("  ", " "),
        why: "Its functions and tables sit in the schema Supabase's API serves, where they can be called with your anon key.",
        steps: "Move the extension to the extensions schema in the SQL editor. Some extensions can't be moved, and have to be dropped and created again there.",
        ...(l.metadata?.name ? { code: `alter extension ${ident(l.metadata.name)} set schema extensions;` } : {}),
      };
    case "materialized_view_in_api":
    case "foreign_table_in_api":
      return {
        title: `${obj ?? "A table"} is readable through the API without Row Level Security`,
        why: `${l.name === "foreign_table_in_api" ? "Foreign tables" : "Materialized views"} can't have Row Level Security, so anyone with your anon key can read all of it.`,
        steps: "Move it out of the public schema, or revoke access from the anon and authenticated roles in the SQL editor.",
        ...(sql ? { code: `revoke select on ${sql} from anon, authenticated;` } : {}),
      };
    case "vulnerable_postgres_version":
      return {
        title: "The database's Postgres has security patches waiting",
        why: "The project runs a Postgres version with known security fixes available in a newer one.",
        steps: "In Supabase, open Project Settings → Infrastructure and upgrade the project. Plan a few minutes of downtime.",
      };
  }
  return undefined;
}

// Each lint as a finding; the same lint on the same object keeps its key.
export function findingsFromLints(lints: Lint[], ref: string): { findings: FindingDraft[]; notes: string[] } {
  const findings = new Map<string, FindingDraft>();
  const notes: string[] = [];
  for (const l of lints) {
    // The project's health is the health check's business.
    if (l.categories?.length && !l.categories.includes("SECURITY")) continue;
    if (l.name === "advisor_check_unavailable" || l.name === "project_not_active") {
      notes.push(l.detail || l.description || l.title);
      continue;
    }
    const m = l.metadata ?? {};
    const obj = m.schema && m.name ? `${m.schema}.${m.name}` : undefined;
    const sql = m.schema && m.name ? `${ident(m.schema)}.${ident(m.name)}` : undefined;
    const key = `${l.name}${obj ? `:${obj}` : m.entity ? `:${m.entity}` : ""}`;
    if (findings.has(key)) continue; // overloaded functions: one finding for the name
    const words = wordsFor(l, obj, sql, ref) ?? {
      title: obj ? `${l.title}: ${obj}` : l.title,
      why: l.description,
      steps: l.detail ? `${l.detail.replace(/\s+$/, "")}${/[.!?]$/.test(l.detail.trim()) ? "" : "."} Supabase's guide for this check says how to fix it.` : "Supabase's guide for this check says how to fix it.",
    };
    const link = words.dashboard
      ? { url: words.dashboard, label: "Open Email sign-in settings" }
      : /^https:\/\/supabase\.com\//.test(l.remediation)
      ? { url: l.remediation, label: "Supabase's guide" }
      : { url: `https://supabase.com/dashboard/project/${encodeURIComponent(ref)}/advisors/security`, label: "Open Security Advisor" };
    findings.set(key, { key, severity: SEVERITY[l.level] ?? "low", title: words.title, why: words.why, fix: { steps: words.steps, link, ...(words.code ? { code: words.code } : {}) } });
  }
  return { findings: [...findings.values()], notes };
}

export const supabase: Integration = {
  ...described("supabase"),

  parse({ resource, settings }) {
    const ref = requiredText(resource, "Project", 60);
    if (!/^[a-z0-9]{10,40}$/i.test(ref)) throw badRequest("A Supabase project reference looks like abcdefghijklmnopqrst");
    const s = (settings ?? {}) as Record<string, unknown>;
    return { resource: ref, settings: typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {} };
  },

  async testService(auth) {
    const projects = await sb<Project[]>(auth, "/projects");
    return { message: `Connected: ${projects.length} project${projects.length === 1 ? "" : "s"} visible` };
  },

  async listResources(auth) {
    const projects = await sb<Project[]>(auth, "/projects");
    return projects.map((p) => ({
      id: refOf(p),
      label: p.name,
      detail: [p.region, p.status.toLowerCase().replace(/_/g, " ")].filter(Boolean).join(" · "),
      settings: { name: p.name },
    }));
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Supabase service connected" };
    try {
      const projects = await sb<Project[]>(auth, "/projects");
      const project = projects.find((p) => refOf(p) === conn.resource);
      if (!project) return { state: "unknown", at, detail: "This token can't see that project (removed, or a different account?)" };

      const status = describeStatus(project.status);
      if (status.state !== "up") return { state: status.state, at, detail: status.text, summary: status.text };

      const services = async (list: string) =>
        sb<Health[]>(auth, `/projects/${encodeURIComponent(conn.resource)}/health?services=${list}`, 30_000);
      let health: Health[];
      try {
        health = await services("auth,db,rest,realtime,storage");
      } catch (err) {
        if (!(err instanceof ProviderError) || err.status !== 400) throw err;
        health = await services("auth,db,rest"); // an older API without some services
      }
      const bad = unhealthyServices(health);
      if (bad.length) return { state: "down", at, detail: `Unhealthy: ${bad.join(", ")}`, summary: `Unhealthy: ${bad.join(", ")}` };
      return { state: "up", at, summary: `Running · ${health.map((h) => h.name).join(", ")} healthy` };
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  // Supabase's security advisors for the project. A paused project can't be
  // checked: that's a throw, so the findings from before stay.
  async audit(conn, auth): Promise<AuditResult> {
    if (!auth) return { findings: [], notes: ["No Supabase account connected"] };
    const projects = await sb<Project[]>(auth, "/projects");
    const project = projects.find((p) => refOf(p) === conn.resource);
    if (!project) throw new Error("this token can't see the project (removed, or a different account?)");
    const status = describeStatus(project.status);
    if (status.state !== "up") throw new Error(`${status.text.toLowerCase()}, so its security advisors can't run`);
    let lints: Lint[];
    try {
      ({ lints } = await sb<{ lints: Lint[] }>(auth, `/projects/${encodeURIComponent(conn.resource)}/advisors/security`));
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) {
        return { findings: [], notes: ["The Supabase token can't read the project's security advisors (it needs the advisors_read permission), so they weren't checked."] };
      }
      throw err;
    }
    return findingsFromLints(lints ?? [], conn.resource);
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: Supabase`, body: reason }
      : { title: `${app}: Supabase is healthy again`, body: "The project is running and its services are healthy." };
  },
};
