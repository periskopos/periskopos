import type { CheckResult, Connection, Deploy } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, postJson, queryJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { deployHealth, deployNotice, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Railway as a host: a service's deploys in one environment (production,
// unless it has none), each with the commit it built, so "is my last push
// live?" and failed or crashed deploy alerts work as they do for Render;
// Redeploy when the account allows actions. Railway's API is GraphQL.

const API = "https://backboard.railway.com/graphql/v2";

type RwDeploy = { id: string; status: string; createdAt: string; meta?: { commitHash?: string; commitMessage?: string } | null };
type Edges<T> = { edges: { node: T }[] };
type RwProject = { id: string; name: string; environments: Edges<{ id: string; name: string }>; services: Edges<{ id: string; name: string }> };

const UUID = /^[0-9a-f-]{36}$/i;

async function query<T>(auth: ServiceAuth, q: string, variables: Record<string, unknown> = {}, ttlMs?: number): Promise<T> {
  return queryJson<T>(API, { query: q, variables }, { token: await auth.token(), provider: "Railway", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const IN_PROGRESS = new Set(["INITIALIZING", "QUEUED", "WAITING", "BUILDING", "DEPLOYING"]);
const FAILED = new Set(["FAILED", "CRASHED"]);

// The newest successful deploy is the one serving (SLEEPING: serving, but
// asleep until a request wakes it); REMOVED ones were replaced.
export function toDeploys(list: RwDeploy[], dashboard: string | undefined): Deploy[] {
  let liveSeen = false;
  return list.map((d) => {
    let phase: Deploy["phase"] = "other";
    let status = d.status.toLowerCase();
    if (IN_PROGRESS.has(d.status)) phase = "in-progress";
    else if (FAILED.has(d.status)) phase = "failed";
    else if (d.status === "SUCCESS" || d.status === "SLEEPING") {
      if (!liveSeen) {
        liveSeen = true;
        phase = "live";
        if (d.status === "SUCCESS") status = "live";
      } else status = "superseded";
    } else if (d.status === "REMOVED") status = "superseded";
    const sha = d.meta?.commitHash && /^[0-9a-f]{7,40}$/i.test(d.meta.commitHash) ? d.meta.commitHash : undefined;
    return {
      id: d.id,
      status,
      phase,
      ...(sha ? { commit: { sha, message: firstLine(d.meta?.commitMessage ?? "") || `commit ${sha.slice(0, 7)}`, at: d.createdAt } } : {}),
      startedAt: d.createdAt,
      ...(dashboard ? { url: `${dashboard}&id=${encodeURIComponent(d.id)}` } : {}),
    };
  });
}

const dashboardOf = (conn: Connection) => {
  const { projectId, environmentId } = conn.settings ?? {};
  if (typeof projectId !== "string" || typeof environmentId !== "string") return undefined;
  return `https://railway.com/project/${encodeURIComponent(projectId)}/service/${encodeURIComponent(conn.resource)}?environmentId=${encodeURIComponent(environmentId)}`;
};

async function deploysOf(conn: Connection, auth: ServiceAuth, first: number, ttlMs?: number): Promise<Deploy[]> {
  const { projectId, environmentId } = conn.settings ?? {};
  const { deployments } = await query<{ deployments: Edges<RwDeploy> }>(
    auth,
    `query deployments($input: DeploymentListInput!, $first: Int) { deployments(input: $input, first: $first) { edges { node { id status createdAt meta } } } }`,
    { input: { projectId, serviceId: conn.resource, environmentId }, first },
    ttlMs,
  );
  return toDeploys(deployments.edges.map((e) => e.node), dashboardOf(conn));
}

export const railway: Integration = {
  ...described("railway"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Railway service", 64);
    const s = (settings ?? {}) as Record<string, unknown>;
    if (!UUID.test(id) || typeof s.projectId !== "string" || !UUID.test(s.projectId) || typeof s.environmentId !== "string" || !UUID.test(s.environmentId)) {
      throw badRequest("Pick the service from the list: Railway needs its project and environment too");
    }
    return { resource: id, settings: { projectId: s.projectId, environmentId: s.environmentId, ...(typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {}) } };
  },

  async testService(auth) {
    const { me } = await query<{ me: { name?: string; email?: string } }>(auth, "query { me { name email } }", {}, 0);
    return { message: `Connected to ${me.name || me.email || "Railway"}` };
  },

  // Every service, in its project's production environment (or its only one).
  async listResources(auth) {
    const { projects } = await query<{ projects: Edges<RwProject> }>(
      auth,
      "query { projects { edges { node { id name environments { edges { node { id name } } } services { edges { node { id name } } } } } } }",
    );
    const out = projects.edges.flatMap(({ node: p }) => {
      const envs = p.environments.edges.map((e) => e.node);
      const env = envs.find((e) => e.name.toLowerCase() === "production") ?? (envs.length === 1 ? envs[0] : undefined);
      if (!env) return [];
      return p.services.edges.map(({ node: s }) => ({
        id: s.id,
        label: s.name,
        detail: `${p.name} · ${env.name}`,
        settings: { name: s.name, projectId: p.id, environmentId: env.id },
      }));
    });
    if (!out.length) throw new Error("This Railway token sees no services with a production environment. A workspace token sees only that workspace.");
    return out;
  },

  async deploys(conn, auth) {
    return deploysOf(conn, auth, 20);
  },

  // Down when the newest deploy failed or crashed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Railway account connected" };
    try {
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), dashboardOf(conn), "Railway");
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description: "Deploys the service's live deploy again on Railway, from the same commit. The live service keeps serving until the new deploy is ready.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`Railway has no action "${actionId}"`);
    // Never stack a second deploy on one that's already running; look fresh.
    const recent = await deploysOf(conn, auth, 10, 0);
    const running = recent.find((d) => d.phase === "in-progress");
    if (running) return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status}). Wait for it to finish.` };
    const live = recent.find((d) => d.phase === "live");
    if (!live) return { ok: false, message: "Nothing is live to redeploy." };
    const r = await postJson<{ data?: { deploymentRedeploy?: { id?: string; status?: string } }; errors?: { message?: string }[] }>(
      API,
      { query: "mutation deploymentRedeploy($id: String!) { deploymentRedeploy(id: $id) { id status } }", variables: { id: live.id } },
      { token: await auth.token(), provider: "Railway" },
    );
    if (r.errors?.length) throw new ProviderError(200, `Railway: ${r.errors.map((e) => e.message ?? "error").join("; ")}`);
    const d = r.data?.deploymentRedeploy;
    return { ok: true, message: `Redeploy started${d?.id ? ` (${d.id}${d.status ? `, ${d.status.toLowerCase()}` : ""})` : ""}. It will show under Deploys.` };
  },

  notice: deployNotice,
};
