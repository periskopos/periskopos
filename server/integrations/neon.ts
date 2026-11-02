import type { CheckResult } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Neon, serverless Postgres: is the project's database reachable? Its
// compute on the main branch must not be stuck, turned off or failing to
// start, and the project must not have run into a quota (Neon suspends its
// computes until the billing period resets) or a full branch (writes fail).
// A compute scaled to zero is normal: it starts on the next connection.
// Reads only: Neon keys can't be limited to reading, so only GET is used.

const API = "https://console.neon.tech/api/v2";
const CONSOLE = "https://console.neon.tech/app/projects";

// A compute changing state for longer than this is stuck (starting takes
// seconds).
export const STUCK_MS = 15 * 60_000;
// A failed operation older than this is history, not news.
const RECENT_OPS_MS = 24 * 3_600_000;

type Org = { id: string; name: string };
type ProjectItem = { id: string; name: string; region_id: string; org_name?: string };
type Quota = { active_time_seconds?: number; compute_time_seconds?: number; written_data_bytes?: number; data_transfer_bytes?: number; logical_size_bytes?: number };
export type Project = ProjectItem & {
  active_time_seconds?: number;
  compute_time_seconds?: number;
  written_data_bytes?: number;
  data_transfer_bytes?: number;
  branch_logical_size_limit_bytes?: number;
  consumption_period_end?: string;
  settings?: { quota?: Quota };
};
export type Endpoint = {
  id: string;
  branch_id: string;
  type: string; // read_write | read_only
  current_state: string; // init | active | idle
  pending_state?: string;
  disabled?: boolean;
  updated_at: string;
};
export type Branch = { id: string; name: string; default?: boolean; primary?: boolean; logical_size?: number };
export type Operation = {
  id: string;
  action: string;
  status: string;
  error?: string;
  branch_id?: string;
  endpoint_id?: string;
  created_at: string;
};

async function nn<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  try {
    return await getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Neon", ttlMs });
  } catch (err) {
    if (err instanceof ProviderError && err.status === 401) {
      throw new ProviderError(401, "Neon rejected the API key: it may be mistyped or revoked. Create a new one in Neon (Account settings → API keys) and paste it on the Accounts page.", err.body);
    }
    if (err instanceof ProviderError && err.status === 403) {
      throw new ProviderError(403, "Neon refused this API key access (403). A project-scoped key only sees its one project: use a personal or organization API key to see them all.", err.body);
    }
    throw err;
  }
}

// Every project the key can see. A personal key lists projects per
// organization (Neon requires org_id for it); an organization or project
// key can't list organizations, and lists its own projects without one.
async function allProjects(auth: ServiceAuth, ttlMs = 60_000): Promise<ProjectItem[]> {
  let orgs: Org[] = [];
  try {
    orgs = (await nn<{ organizations: Org[] }>(auth, "/users/me/organizations", ttlMs)).organizations ?? [];
  } catch (err) {
    if (!(err instanceof ProviderError) || ![401, 403, 404].includes(err.status)) throw err;
  }
  const scopes = orgs.length ? orgs.map((o) => `&org_id=${encodeURIComponent(o.id)}`) : [""];
  const lists = await Promise.all(scopes.map((scope) => projectPages(auth, scope, ttlMs)));
  const seen = new Set<string>();
  return lists.flat().filter((p) => !seen.has(p.id) && seen.add(p.id));
}

async function projectPages(auth: ServiceAuth, scope: string, ttlMs: number): Promise<ProjectItem[]> {
  const out: ProjectItem[] = [];
  let cursor = "";
  for (let page = 0; page < 5; page++) {
    const r = await nn<{ projects: ProjectItem[]; pagination?: { cursor?: string } }>(auth, `/projects?limit=400${scope}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, ttlMs);
    out.push(...r.projects);
    if (r.projects.length < 400 || !r.pagination?.cursor) break;
    cursor = r.pagination.cursor;
  }
  return out;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function bytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 10 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const day = (iso: string | undefined) => (iso ? iso.slice(0, 10) : undefined);

// Quotas Neon enforces per project (0 or missing means unlimited): past
// one, every compute is suspended until the billing period resets.
export function quotaHit(p: Project): string | undefined {
  const q = p.settings?.quota ?? {};
  const over = (limit: number | undefined, used: number | undefined) => !!limit && limit > 0 && (used ?? 0) >= limit;
  const hit = over(q.compute_time_seconds, p.compute_time_seconds)
    ? "compute time"
    : over(q.active_time_seconds, p.active_time_seconds)
      ? "active time"
      : over(q.data_transfer_bytes, p.data_transfer_bytes)
        ? "data transfer"
        : over(q.written_data_bytes, p.written_data_bytes)
          ? "written data"
          : undefined;
  if (!hit) return undefined;
  const until = day(p.consumption_period_end);
  return `The project used up its ${hit} quota: Neon suspended its computes${until ? ` until ${until}` : " until the billing period resets"}`;
}

// The main branch past its size limit: computes still start, writes fail.
export function branchFull(p: Project, b: Branch | undefined): string | undefined {
  if (!b || b.logical_size === undefined) return undefined;
  const limit = (p.settings?.quota?.logical_size_bytes ?? 0) > 0 ? p.settings!.quota!.logical_size_bytes! : (p.branch_logical_size_limit_bytes ?? 0);
  if (limit <= 0 || b.logical_size < limit) return undefined;
  return `Its ${b.name} branch is full (${bytes(b.logical_size)} of ${bytes(limit)}): writes to it fail`;
}

// A compute that's turned off, or changing state for too long.
export function computeProblem(e: Endpoint, now = Date.now()): string | undefined {
  if (e.disabled) return "Connections to its compute are turned off in Neon";
  const since = now - Date.parse(e.updated_at);
  if ((e.pending_state || e.current_state === "init") && since > STUCK_MS) {
    const to = e.pending_state ?? "active";
    return `Its compute has been stuck going from ${e.current_state} to ${to} for ${Math.round(since / 60_000)} min`;
  }
  return undefined;
}

const ACTIONS: Record<string, string> = {
  start_compute: "start its compute",
  create_compute: "create its compute",
  apply_config: "apply its compute settings",
  start_reserved_compute: "start its compute",
  check_availability: "confirm it's available",
};

// Operations whose newest attempt failed recently, on the main branch (or
// the whole project). Scaling to zero failing doesn't stop the database,
// and a later success of the same action means it's fixed.
export function failedOperations(ops: Operation[], mainBranch: string | undefined, now = Date.now()): string[] {
  const newest = new Map<string, Operation>();
  for (const op of [...ops].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (op.action === "suspend_compute") continue;
    if (mainBranch && op.branch_id && op.branch_id !== mainBranch) continue;
    const key = `${op.action}\n${op.endpoint_id ?? op.branch_id ?? ""}`;
    if (!newest.has(key)) newest.set(key, op);
  }
  return [...newest.values()]
    .filter((op) => (op.status === "failed" || op.status === "error") && now - Date.parse(op.created_at) < RECENT_OPS_MS)
    .map((op) => `Neon couldn't ${ACTIONS[op.action] ?? op.action.replace(/_/g, " ")}${op.error ? `: ${op.error}` : ""}`);
}

export const neon: Integration = {
  ...described("neon"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Project", 60);
    if (!/^[a-z0-9-]{1,60}$/.test(id)) throw badRequest("A Neon project ID looks like shiny-wind-028834");
    const s = (settings ?? {}) as Record<string, unknown>;
    return { resource: id, settings: typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {} };
  },

  async testService(auth) {
    const projects = await allProjects(auth, 0);
    return { message: `Connected: ${plural(projects.length, "project")} visible` };
  },

  async listResources(auth) {
    const projects = await allProjects(auth);
    if (projects.length === 0) throw new Error("This Neon key can't see any projects. Create one in Neon, or use a key from the account or organization that has them.");
    return projects.map((p) => ({
      id: p.id,
      label: p.name,
      detail: [p.org_name, p.region_id].filter(Boolean).join(" · "),
      settings: { name: p.name },
    }));
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Neon account connected" };
    const id = encodeURIComponent(conn.resource);
    const link = { url: `${CONSOLE}/${id}`, label: "Open the project in Neon" };
    try {
      const { project } = await nn<{ project: Project }>(auth, `/projects/${id}`);
      const [{ endpoints }, { branches }, { operations }] = await Promise.all([
        nn<{ endpoints: Endpoint[] }>(auth, `/projects/${id}/endpoints`, 30_000),
        nn<{ branches: Branch[] }>(auth, `/projects/${id}/branches`),
        nn<{ operations: Operation[] }>(auth, `/projects/${id}/operations?limit=50`, 30_000),
      ]);
      const main = branches.find((b) => b.default) ?? branches.find((b) => b.primary);
      const computes = endpoints.filter((e) => !main || e.branch_id === main.id);
      const compute = computes.find((e) => e.type === "read_write") ?? computes[0];
      const where = [main ? `${main.name} branch` : undefined, project.region_id].filter(Boolean).join(" · ");

      const problems = [
        quotaHit(project),
        ...computes.map((e) => computeProblem(e)),
        ...failedOperations(operations, main?.id),
        branchFull(project, main),
      ].filter((x): x is string => !!x);
      if (problems.length) {
        const detail = [...new Set(problems)].join(". ");
        return { state: "down", at, detail, summary: detail, link };
      }
      if (!compute) return { state: "unknown", at, detail: "Its main branch has no compute, so nothing can connect to it", summary: "No compute on the main branch", link };

      // Idle is scaled to zero: normal, it wakes on the next connection.
      const state = compute.pending_state
        ? `Compute going from ${compute.current_state} to ${compute.pending_state}`
        : compute.current_state === "idle"
          ? "Scaled to zero (wakes on the next connection)"
          : compute.current_state === "init"
            ? "Compute starting"
            : "Compute active";
      return { state: "up", at, summary: [state, where].filter(Boolean).join(" · ") };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return { state: "down", at, detail: `The Neon project ${conn.resource} isn't in this account any more (deleted, or a key for another account?)`, link };
      }
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: Neon database`, body: reason }
      : { title: `${app}: the Neon database is fine again`, body: "Its compute is healthy and the project is within its limits." };
  },
};
