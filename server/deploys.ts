import type { DatabaseSync } from "node:sqlite";
import type { App, Commit, Connection, Deploy, DeployState } from "../shared/types.ts";
import { integrations } from "./integrations/index.ts";
import type { BuildCheck, Integration, ServiceAuth } from "./integrations/types.ts";
import { authFor } from "./keys/secrets.ts";
import * as store from "./store.ts";

// "Is my last push live?" (FR-I4), for any source + host pair:
// - latest: the newest commit on the deploying branch, in the app's paths;
// - live:   the commit of the host's live deploy;
// live if `live` contains `latest`, deploying if a running deploy does,
// otherwise not deployed.

type Picked = { conn: Connection; integration: Integration; auth?: ServiceAuth };

function pick(db: DatabaseSync, app: App, role: "source" | "host"): Picked | undefined {
  const conn = app.connections.find((c) => integrations[c.type]?.role === role);
  if (!conn) return undefined;
  const service = conn.serviceId ? store.getService(db, app.ownerId, conn.serviceId) : undefined;
  return { conn, integration: integrations[conn.type], ...(service ? { auth: authFor(service) } : {}) };
}

export async function deployState(db: DatabaseSync, app: App): Promise<DeployState | undefined> {
  const source = pick(db, app, "source");
  const host = pick(db, app, "host");
  if (!source || !host) return undefined;
  const sa = source.auth;
  const ha = host.auth;
  if (!sa || !ha) return { state: "unknown", detail: "An account this app uses was removed" };
  const { integration: si, conn: sc } = source;
  const { integration: hi, conn: hc } = host;

  try {
    const checkName = hi.buildCheckName?.(hc);
    if (checkName && si.buildChecks) {
      const [latest, checks] = await Promise.all([si.latestCommit!(sc, sa), si.buildChecks(sc, sa, checkName)]);
      const state = fromBuildChecks(latest, checks, (sha) => si.commitUrl?.(sc, sha));
      if (state.state !== "not-deployed" || !latest || !hi.deploys || !si.sameContent) return state;
      const direct = deployedDirectly(checks, await hi.deploys(hc, ha));
      if (!direct || !(await si.sameContent(sc, sa, direct.sha, latest.sha))) return state;
      const url = si.commitUrl?.(sc, direct.sha);
      return {
        state: "live",
        latest,
        live: { sha: direct.sha, message: direct.message, at: direct.at, ...(url ? { url } : {}) },
        detail: "Deployed directly, not by Cloudflare's build",
      };
    }
    const [latest, deploys] = await Promise.all([si.latestCommit!(sc, sa), hi.deploys!(hc, ha)]);
    const liveCommit = deploys.find((d) => d.phase === "live")?.commit;
    const live = liveCommit && { ...liveCommit, ...(si.commitUrl ? { url: si.commitUrl(sc, liveCommit.sha) } : {}) };
    const running = deploys.filter((d) => d.phase === "in-progress");

    if (!latest) return { state: "unknown", ...(live ? { live } : {}), detail: "No commits found on the branch" };
    if (live && (await si.contains!(sc, sa, live.sha, latest.sha))) return { state: "live", latest, live };
    for (const d of running) {
      if (d.commit && (await si.contains!(sc, sa, d.commit.sha, latest.sha))) {
        return { state: "deploying", latest, ...(live ? { live } : {}), detail: `Deploying ${d.commit.sha.slice(0, 7)}` };
      }
    }
    return {
      state: "not-deployed",
      latest,
      ...(live ? { live } : {}),
      detail: running.length ? "A deploy is running, but not of the latest change" : "The latest change isn't live, and no deploy is running",
    };
  } catch (err) {
    return { state: "unknown", detail: (err as Error).message };
  }
}

// A Worker deployed straight from a computer (`wrangler deploy`), say while
// Cloudflare's builds are failing, has no build check to say which commit
// it serves. A deployment made after the newest successful build finished
// can't be that build's (a failed build deploys nothing), so it was deployed
// directly, from the commit that was newest when it was made. That commit is
// returned; the caller counts the latest change live only if it holds the
// same files (an empty commit, or one outside the app's paths).
export function deployedDirectly(checks: BuildCheck[], deploys: Deploy[]): BuildCheck | undefined {
  const live = deploys.find((d) => d.phase === "live");
  if (!live) return undefined;
  const deployedAt = Date.parse(live.startedAt);
  const built = checks.find((c) => c.status === "completed" && c.conclusion === "success");
  if (built && deployedAt <= Date.parse(built.completedAt ?? built.at)) return undefined;
  return checks.find((c) => Date.parse(c.at) <= deployedAt);
}

// How long a pushed commit may go without its build check before that
// counts as "not deployed" rather than "Cloudflare hasn't picked it up yet".
const BUILD_START_GRACE_MS = 10 * 60_000;

// For a host that can't say which commit it serves (a Worker built by
// Workers Builds), the source's build checks answer instead, newest first:
// live is the newest commit whose build succeeded; a newer build still
// going is deploying; a newer one that failed (or was cancelled) means the
// latest change isn't live. A rollback made in the host's dashboard isn't
// visible this way; the host's own deploys show it.
export function fromBuildChecks(latest: Commit | undefined, checks: BuildCheck[], urlOf: (sha: string) => string | undefined): DeployState {
  const commitOf = (c: BuildCheck): Commit => {
    const url = urlOf(c.sha);
    return { sha: c.sha, message: c.message, at: c.at, ...(url ? { url } : {}) };
  };
  const liveAt = checks.findIndex((c) => c.status === "completed" && c.conclusion === "success");
  const live = liveAt >= 0 ? commitOf(checks[liveAt]) : undefined;
  const withLive = live ? { live } : {};
  if (!latest) return { state: "unknown", ...withLive, detail: "No commits found on the branch" };
  const sha = (c: { sha: string }) => c.sha.slice(0, 7);

  // The newest change has no build yet: just pushed, or never picked up.
  if (!checks.some((c) => c.sha === latest.sha)) {
    if (Date.now() - Date.parse(latest.at) < BUILD_START_GRACE_MS) {
      return { state: "deploying", latest, ...withLive, detail: `Waiting for Cloudflare to build ${sha(latest)}` };
    }
    if (!live) return { state: "unknown", latest, detail: "Cloudflare hasn't built any of the latest changes" };
    return { state: "not-deployed", latest, live, detail: `Cloudflare hasn't built ${sha(latest)}` };
  }

  const newer = liveAt >= 0 ? checks.slice(0, liveAt) : checks;
  if (newer.length === 0) return { state: "live", latest, ...withLive };
  const running = newer.find((c) => c.status !== "completed");
  if (running) return { state: "deploying", latest, ...withLive, detail: `Cloudflare is building ${sha(running)}` };
  const [last] = newer; // the newest build, finished without success
  return {
    state: "not-deployed",
    latest,
    ...withLive,
    detail: last.conclusion === "cancelled" || last.conclusion === "skipped"
      ? `Cloudflare's build of ${sha(last)} was ${last.conclusion}`
      : `Cloudflare's build of ${sha(last)} failed`,
  };
}
