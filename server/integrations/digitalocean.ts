import type { CheckResult, Connection, Deploy } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson, postJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { deployHealth, deployNotice, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// DigitalOcean App Platform as a host: an app's deploys, each with the
// commit it built, so "is my last push live?" and failed-deploy alerts work
// as they do for Render; Redeploy when the account allows actions.

const API = "https://api.digitalocean.com/v2";

type DoComponent = { name?: string; source_commit_hash?: string };
type DoDeployment = {
  id: string;
  phase: string; // PENDING_BUILD, BUILDING, PENDING_DEPLOY, DEPLOYING, ACTIVE, SUPERSEDED, ERROR, CANCELED, UNKNOWN
  cause?: string;
  created_at: string;
  updated_at?: string;
  services?: DoComponent[];
  static_sites?: DoComponent[];
  workers?: DoComponent[];
  jobs?: DoComponent[];
};
type DoApp = {
  id: string;
  spec: { name: string };
  live_url?: string;
  live_domain?: string;
  default_ingress?: string;
  region?: { slug?: string; label?: string };
  active_deployment?: DoDeployment;
  in_progress_deployment?: DoDeployment;
};

async function api<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "DigitalOcean", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const IN_PROGRESS = new Set(["PENDING_BUILD", "BUILDING", "PENDING_DEPLOY", "DEPLOYING"]);
const FAILED = new Set(["ERROR"]);

export function phaseOf(phase: string): Deploy["phase"] {
  if (phase === "ACTIVE") return "live";
  if (IN_PROGRESS.has(phase)) return "in-progress";
  if (FAILED.has(phase)) return "failed";
  return "other"; // SUPERSEDED (was live, replaced), CANCELED, UNKNOWN
}

export const dashboardOf = (conn: Pick<Connection, "resource">) => `https://cloud.digitalocean.com/apps/${encodeURIComponent(conn.resource)}`;

// The commit a deployment built: its components' source commit (they share
// one when the app builds from one repo).
const commitOf = (d: DoDeployment): string | undefined =>
  [...(d.services ?? []), ...(d.static_sites ?? []), ...(d.workers ?? []), ...(d.jobs ?? [])].map((c) => c.source_commit_hash).find((h) => h && /^[0-9a-f]{7,40}$/i.test(h));

export function toDeploy(d: DoDeployment, conn: Pick<Connection, "resource">): Deploy {
  const sha = commitOf(d);
  const phase = phaseOf(d.phase);
  return {
    id: d.id,
    status: d.phase.toLowerCase(),
    phase,
    // DigitalOcean doesn't keep the commit's message: its cause says why it deployed.
    ...(sha ? { commit: { sha, message: (d.cause ?? "").split("\n")[0]!.slice(0, 200) || `commit ${sha.slice(0, 7)}`, at: d.created_at } } : {}),
    startedAt: d.created_at,
    ...(phase !== "in-progress" && d.updated_at ? { finishedAt: d.updated_at } : {}),
    url: `${dashboardOf(conn)}/deployments/${encodeURIComponent(d.id)}`,
  };
}

export const digitalocean: Integration = {
  ...described("digitalocean"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "App", 64);
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw badRequest("Pick the app from the list: a DigitalOcean app id looks like 4f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf");
    const s = (settings ?? {}) as Record<string, unknown>;
    return { resource: id, settings: typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {} };
  },

  async testService(auth) {
    const { account } = await api<{ account: { email?: string; team?: { name?: string } } }>(auth, "/account", 0);
    return { message: `Connected to ${account.team?.name ?? account.email ?? "DigitalOcean"}` };
  },

  async listResources(auth) {
    const { apps } = await api<{ apps?: DoApp[] }>(auth, "/apps?per_page=100");
    if (!apps?.length) throw new Error("This DigitalOcean account has no App Platform apps, or the token can't read them: it needs the app: read scope.");
    return apps.map((a) => ({
      id: a.id,
      label: a.spec.name,
      // The app's own address: a host serving the app's URL is its match.
      detail: [a.live_domain ?? (a.live_url ? new URL(a.live_url).hostname : undefined), a.region?.label ?? a.region?.slug].filter(Boolean).join(" · "),
      settings: { name: a.spec.name },
    }));
  },

  async deploys(conn, auth) {
    const { deployments } = await api<{ deployments?: DoDeployment[] }>(auth, `/apps/${encodeURIComponent(conn.resource)}/deployments?per_page=20`);
    return (deployments ?? []).map((d) => toDeploy(d, conn));
  },

  // Down when the newest deploy failed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No DigitalOcean account connected" };
    try {
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), dashboardOf(conn), "DigitalOcean");
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description: "Starts a new deploy of the app on DigitalOcean App Platform. The live app keeps serving until the new deploy is ready.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`DigitalOcean has no action "${actionId}"`);
    // Never stack a second deploy on one that's already running; look fresh.
    const { deployments } = await api<{ deployments?: DoDeployment[] }>(auth, `/apps/${encodeURIComponent(conn.resource)}/deployments?per_page=5`, 0);
    const running = (deployments ?? []).map((d) => toDeploy(d, conn)).find((d) => d.phase === "in-progress");
    if (running) return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status.replace(/_/g, " ")}). Wait for it to finish.` };
    const created = await postJson<{ deployment?: { id?: string; phase?: string } }>(`${API}/apps/${encodeURIComponent(conn.resource)}/deployments`, { force_build: false }, { token: await auth.token(), provider: "DigitalOcean" });
    const d = created.deployment;
    return { ok: true, message: `Redeploy started${d?.id ? ` (${d.id}${d.phase ? `, ${d.phase.toLowerCase().replace(/_/g, " ")}` : ""})` : ""}. It will show under Deploys.` };
  },

  notice: deployNotice,
};
