import type { CheckResult, Resource } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText, text } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// What an app's OpenAI project spends on the API this month, and a warning
// when that passes the budget set for it: a loop calling a model, a leaked
// key or a bigger model than meant shows up here before the invoice. Reads
// only: costs are only open to an organization's admin key, which could
// also change the organization, so only GET endpoints are used.

const API = "https://api.openai.com/v1";
// The whole organization, for one budget across every project.
export const ORGANIZATION = "organization";
// A budget above this is a typo, not a budget.
export const BUDGET_MAX_USD = 1_000_000;
// Costs come in by the day: the hourly check and the app page share one
// answer for a while, across every project of the account.
const COSTS_TTL_MS = 10 * 60_000;
// Pages read, at most: 31 daily buckets fit in one; grouped results can
// spill over into a few more.
const MAX_PAGES = 10;

type Project = { id: string; name: string; status?: string; archived_at?: number | null; created_at?: number };
type ProjectList = { data: Project[]; has_more?: boolean; last_id?: string };
type CostResult = { amount?: { value?: number; currency?: string }; project_id?: string | null };
type CostPage = { data: { start_time: number; results?: CostResult[] }[]; has_more?: boolean; next_page?: string | null };

const looksAdmin = (key: string) => key.startsWith("sk-admin-");

async function oa<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  const key = await auth.token();
  try {
    return await getJson<T>(`${API}${path}`, { token: key, provider: "OpenAI", ttlMs });
  } catch (err) {
    // A project or user key is refused here: say which key it needs.
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403) && (!looksAdmin(key) || /insufficient permissions|missing scopes|admin/i.test(err.body))) {
      throw new ProviderError(err.status, "Only an OpenAI admin key can read projects and costs. Create one in OpenAI → Organization → Admin keys (it starts with sk-admin-) and choose Change key.");
    }
    throw err;
  }
}

async function projects(auth: ServiceAuth, ttlMs?: number): Promise<Project[]> {
  const out: Project[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await oa<ProjectList>(auth, `/organization/projects?limit=100&include_archived=true${after ? `&after=${encodeURIComponent(after)}` : ""}`, ttlMs);
    out.push(...r.data);
    if (!r.has_more || !r.data.length) break;
    after = r.last_id ?? r.data.at(-1)!.id;
  }
  return out;
}

// The first moment of this month, UTC, in seconds: OpenAI's buckets are
// UTC days, and its invoices calendar months.
export const monthStart = (now = Date.now()) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
};

// This month's spend in dollars, by project id (null: not in a project),
// every page followed.
export async function spendByProject(auth: ServiceAuth, now = Date.now()): Promise<{ byProject: Map<string | null, number>; partial: boolean }> {
  const byProject = new Map<string | null, number>();
  let page: string | undefined;
  for (let n = 0; n < MAX_PAGES; n++) {
    const r = await oa<CostPage>(
      auth,
      `/organization/costs?start_time=${monthStart(now)}&bucket_width=1d&group_by=project_id&limit=31${page ? `&page=${encodeURIComponent(page)}` : ""}`,
      COSTS_TTL_MS,
    );
    for (const bucket of r.data) {
      for (const c of bucket.results ?? []) {
        // Costs are in dollars; anything else would be a different bill.
        if ((c.amount?.currency ?? "usd").toLowerCase() !== "usd") continue;
        const id = c.project_id ?? null;
        byProject.set(id, (byProject.get(id) ?? 0) + (Number(c.amount?.value) || 0));
      }
    }
    if (!r.has_more || !r.next_page) return { byProject, partial: false };
    page = r.next_page;
  }
  return { byProject, partial: true };
}

// "$212", "$3.20", "$0": cents only while they matter.
export function usd(amount: number): string {
  const digits = amount >= 100 || amount === 0 ? 0 : 2;
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

// A monthly budget: dollars, more than 0, rounded to the cent. Empty: none.
export function budgetOf(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "string" ? Number(value.trim().replace(/^\$/, "").replace(/,/g, "")) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > BUDGET_MAX_USD) {
    throw badRequest(`Monthly budget must be an amount in dollars, more than 0 and up to ${BUDGET_MAX_USD.toLocaleString("en")}`);
  }
  return Math.round(n * 100) / 100;
}

// Over the budget, it's down: spend needs attention, the app still serves.
export function spendHealth(spent: number, budget: number | undefined, at: string): CheckResult {
  const link = { url: "https://platform.openai.com/settings/organization/usage", label: "Open OpenAI usage" };
  if (budget !== undefined && spent > budget) {
    const reason = `${usd(spent)} spent this month, over its ${usd(budget)} budget`;
    return { state: "down", at, detail: reason, summary: reason, link };
  }
  return {
    state: "up",
    at,
    summary: budget !== undefined ? `${usd(spent)} spent this month · ${Math.round((spent / budget) * 100)}% of its ${usd(budget)} budget` : `${usd(spent)} spent this month`,
  };
}

export const openai: Integration = {
  ...described("openai"),
  // A month's total doesn't flap: one check over budget is enough.
  confirmFailures: 1,

  parse({ resource, settings }) {
    const id = requiredText(resource, "Project", 100).trim();
    if (id !== ORGANIZATION && !/^proj_[A-Za-z0-9]{6,64}$/.test(id)) throw badRequest("Pick the project from the list (its id looks like proj_abc123)");
    const s = (settings ?? {}) as Record<string, unknown>;
    const name = text(s.name, "Name", { max: 100, optional: true });
    const budgetUsd = budgetOf(s.budgetUsd);
    const out = { ...(name ? { name } : {}), ...(budgetUsd !== undefined ? { budgetUsd } : {}) };
    return { resource: id, ...(Object.keys(out).length ? { settings: out } : {}) };
  },

  async testService(auth) {
    const list = await projects(auth, 0);
    const archived = list.filter((p) => p.status === "archived").length;
    return { message: `Connected: ${list.length} project${list.length === 1 ? "" : "s"}${archived ? `, ${archived} archived` : ""}` };
  },

  async listResources(auth): Promise<Resource[]> {
    const list = await projects(auth);
    return [
      { id: ORGANIZATION, label: "Whole organization", detail: "Every project's spend together" },
      ...list.map((p) => ({ id: p.id, label: p.name, ...(p.status === "archived" ? { detail: "Archived" } : {}), settings: { name: p.name } })),
    ];
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No OpenAI account connected" };
    const budget = typeof conn.settings?.budgetUsd === "number" ? conn.settings.budgetUsd : undefined;
    try {
      const { byProject } = await spendByProject(auth);
      if (conn.resource === ORGANIZATION) return spendHealth([...byProject.values()].reduce((a, b) => a + b, 0), budget, at);
      const spent = byProject.get(conn.resource) ?? 0;
      const project = (await projects(auth)).find((p) => p.id === conn.resource);
      if (!project) return { state: "unknown", at, detail: `This project isn't in the OpenAI organization any more: ${usd(spent)} spent this month` };
      if (project.status === "archived") {
        return { state: "unknown", at, detail: `${project.name} is archived in OpenAI: its keys can't make API calls any more`, summary: `Archived · ${usd(spent)} spent this month` };
      }
      return spendHealth(spent, budget, at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: OpenAI spend is over budget`, body: reason }
      : { title: `${app}: OpenAI spend is within budget again`, body: "This month's spend is under the budget set for it." };
  },
};
