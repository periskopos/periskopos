import type { AuditResult, CheckResult, Connection, Deploy, FindingDraft } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson, postJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { deployHealth, deployNotice, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Vercel as a host: a project's production deploys, each with the commit it
// built, so "is my last push live?" and failed-deploy alerts work as they
// do for Render; Redeploy when the account allows actions.

const API = "https://api.vercel.com";

type VDeploy = {
  uid: string;
  state?: string;
  readyState?: string; // QUEUED, INITIALIZING, BUILDING, READY, ERROR, CANCELED, DELETED, BLOCKED
  readySubstate?: string; // when READY: STAGED (never served production), ROLLING, PROMOTED
  created: number;
  buildingAt?: number;
  ready?: number;
  inspectorUrl?: string | null;
  meta?: Record<string, string>;
};
type VProject = { id: string; name: string; targets?: { production?: { alias?: string[] } } };

// A team's projects are read on its behalf: the team travels with the connection.
const scoped = (path: string, teamId: unknown) => (typeof teamId === "string" && teamId ? `${path}${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(teamId)}` : path);

async function api<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Vercel", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const IN_PROGRESS = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);

// The commit a deploy built, whichever Git provider it came from.
function commitOf(d: VDeploy): Deploy["commit"] {
  const m = d.meta ?? {};
  for (const git of ["github", "gitlab", "bitbucket"]) {
    const sha = m[`${git}CommitSha`];
    if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) return { sha, message: firstLine(m[`${git}CommitMessage`] ?? "") || `commit ${sha.slice(0, 7)}`, at: new Date(d.created).toISOString() };
  }
  return undefined;
}

// Vercel keeps every READY deploy READY: the newest one that has served
// production is live, the ones before it were replaced.
export function toDeploys(list: VDeploy[]): Deploy[] {
  let liveSeen = false;
  return list.map((d) => {
    const state = d.readyState ?? d.state ?? "UNKNOWN";
    let phase: Deploy["phase"] = "other";
    let status = state.toLowerCase();
    if (IN_PROGRESS.has(state)) phase = "in-progress";
    else if (state === "ERROR") phase = "failed";
    else if (state === "READY") {
      if (d.readySubstate === "STAGED") status = "staged";
      else if (!liveSeen) {
        liveSeen = true;
        phase = "live";
        status = "live";
      } else status = "superseded";
    }
    const commit = commitOf(d);
    return {
      id: d.uid,
      status,
      phase,
      ...(commit ? { commit } : {}),
      startedAt: new Date(d.created).toISOString(),
      ...(phase !== "in-progress" && d.ready ? { finishedAt: new Date(d.ready).toISOString() } : {}),
      ...(d.inspectorUrl ? { url: d.inspectorUrl } : {}),
    };
  });
}

const dashboardOf = (conn: Connection) => {
  const scope = conn.settings?.scope;
  const name = conn.settings?.name;
  return typeof scope === "string" && typeof name === "string" ? `https://vercel.com/${encodeURIComponent(scope)}/${encodeURIComponent(name)}` : undefined;
};

async function production(conn: Connection, auth: ServiceAuth, limit: number, ttlMs?: number): Promise<{ raw: VDeploy[]; deploys: Deploy[] }> {
  const { deployments } = await api<{ deployments?: VDeploy[] }>(
    auth,
    scoped(`/v7/deployments?projectId=${encodeURIComponent(conn.resource)}&target=production&limit=${limit}`, conn.settings?.teamId),
    ttlMs,
  );
  const raw = deployments ?? [];
  return { raw, deploys: toDeploys(raw) };
}

// The project's settings that matter for configuration checks (GET
// /v9/projects/{idOrName}). Each protection is null when it's off; every
// deploymentType it can have covers preview deploys.
type VProjectSettings = {
  ssoProtection?: { deploymentType?: string } | null;
  passwordProtection?: { deploymentType?: string } | null;
  trustedIps?: { deploymentType?: string } | null;
  gitForkProtection?: boolean;
  link?: { type?: string; productionBranch?: string } | null;
};

// What's set up loosely on the project: previews anyone can open, forks
// that build without asking, deploys that don't come from Git.
export function auditProject(p: VProjectSettings, settingsUrl: string | undefined): FindingDraft[] {
  const link = (path: string, label: string) => (settingsUrl ? { link: { url: `${settingsUrl}/${path}`, label } } : {});
  const out: FindingDraft[] = [];
  if (!p.ssoProtection && !p.passwordProtection && !p.trustedIps) {
    out.push({
      key: "previews-public",
      severity: "medium",
      title: "Preview deploys are open to anyone",
      why: "Anyone with a preview link can open unreleased work, its API routes and whatever data previews connect to. Preview links end up in pull requests, chats and logs.",
      fix: {
        steps: "In Vercel, open the project's Settings → Deployment Protection, turn on Vercel Authentication, choose Standard Protection, and click Save.",
        ...link("deployment-protection", "Open Deployment Protection"),
      },
    });
  }
  if (!p.link) {
    out.push({
      key: "not-linked-to-git",
      severity: "low",
      title: "Not connected to a Git repository",
      why: "Production deploys come from whoever runs the Vercel CLI, so pushes don't deploy and there's no record of which commit is live.",
      fix: { steps: "In Vercel, open the project's Settings → Git, click Connect Git Repository and pick the app's repository.", ...link("git", "Open Git settings") },
    });
  } else if (p.gitForkProtection === false) {
    out.push({
      key: "git-fork-protection-off",
      severity: "medium",
      title: "Pull requests from forks deploy without approval",
      why: "With Git Fork Protection off, a stranger's pull request from a fork of your repository builds on Vercel without anyone approving it, and their code runs with the project's environment variables.",
      fix: { steps: "In Vercel, open the project's Settings → Git and turn on Git Fork Protection.", ...link("git", "Open Git settings") },
    });
  }
  return out;
}

export const vercel: Integration = {
  ...described("vercel"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Vercel project", 100);
    if (!/^prj_[A-Za-z0-9]+$/.test(id)) throw badRequest("Pick the project from the list: a Vercel project id looks like prj_abc123");
    const s = (settings ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === "string" && /^[\w.-]{1,100}$/.test(v) ? v : undefined);
    const name = text(s.name);
    const scope = text(s.scope);
    const teamId = typeof s.teamId === "string" && /^team_[A-Za-z0-9]+$/.test(s.teamId) ? s.teamId : undefined;
    return { resource: id, settings: { ...(name ? { name } : {}), ...(scope ? { scope } : {}), ...(teamId ? { teamId } : {}) } };
  },

  async testService(auth) {
    const { user } = await api<{ user: { username?: string; email?: string } }>(auth, "/v2/user", 0);
    return { message: `Connected to ${user.username ?? user.email ?? "Vercel"}` };
  },

  // Personal projects, and every team's the token can see.
  async listResources(auth) {
    const [{ user }, { teams }] = await Promise.all([
      api<{ user: { username: string } }>(auth, "/v2/user"),
      api<{ teams?: { id: string; slug: string }[] }>(auth, "/v2/teams?limit=50").catch(() => ({ teams: [] })),
    ]);
    const scopes: { teamId?: string; scope: string }[] = [{ scope: user.username }, ...(teams ?? []).map((t) => ({ teamId: t.id, scope: t.slug }))];
    const lists = await Promise.all(
      scopes.map(async (sc) => {
        const { projects } = await api<{ projects?: VProject[] }>(auth, scoped("/v9/projects?limit=100", sc.teamId)).catch(() => ({ projects: [] as VProject[] }));
        return (projects ?? []).map((p) => ({
          id: p.id,
          label: p.name,
          // Its production addresses: a host serving the app's URL is its match.
          detail: [...(p.targets?.production?.alias ?? []).slice(0, 3), sc.scope].join(" · "),
          settings: { name: p.name, scope: sc.scope, ...(sc.teamId ? { teamId: sc.teamId } : {}) },
        }));
      }),
    );
    const all = lists.flat();
    if (!all.length) throw new Error("This Vercel token sees no projects. Check its scope: a token made for one team sees only that team's projects.");
    return all;
  },

  async deploys(conn, auth) {
    return (await production(conn, auth, 20)).deploys;
  },

  // Down when the newest deploy failed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Vercel account connected" };
    try {
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), dashboardOf(conn), "Vercel");
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description: "Builds the live production deploy again on Vercel, from the same commit. The live site keeps serving until the new deploy is ready.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`Vercel has no action "${actionId}"`);
    // Never stack a second deploy on one that's already running; look fresh.
    const { raw, deploys } = await production(conn, auth, 10, 0);
    const running = deploys.find((d) => d.phase === "in-progress");
    if (running) return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status}). Wait for it to finish.` };
    const liveAt = deploys.findIndex((d) => d.phase === "live");
    if (liveAt < 0) return { ok: false, message: "Nothing is live on production to redeploy." };
    const created = await postJson<{ id?: string; readyState?: string }>(
      `${API}${scoped("/v13/deployments", conn.settings?.teamId)}`,
      { name: String(conn.settings?.name ?? conn.resource), deploymentId: raw[liveAt]!.uid, target: "production" },
      { token: await auth.token(), provider: "Vercel" },
    );
    return { ok: true, message: `Redeploy started${created.id ? ` (${created.id}${created.readyState ? `, ${created.readyState.toLowerCase()}` : ""})` : ""}. It will show under Deploys.` };
  },

  async audit(conn, auth): Promise<AuditResult> {
    if (!auth) return { findings: [], notes: ["No Vercel account connected"] };
    let project: VProjectSettings;
    try {
      project = await api<VProjectSettings>(auth, scoped(`/v9/projects/${encodeURIComponent(conn.resource)}`, conn.settings?.teamId));
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) return { findings: [], notes: ["The Vercel token can't read this project's settings, so its protection and Git settings weren't checked."] };
      throw err;
    }
    const dashboard = dashboardOf(conn);
    return { findings: auditProject(project, dashboard ? `${dashboard}/settings` : undefined) };
  },

  notice: deployNotice,
};
