import { duration } from "../../shared/format.ts";
import type { CheckResult, Connection, Deploy, Resource, UsageMeter } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson, postJson, ProviderError, queryJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { deployHealth, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, KeyTest, ServiceAuth } from "./types.ts";

const API = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = { success?: boolean; result: T; errors?: { message?: string }[] };
type CfStage = { name: string; status: string; started_on?: string | null; ended_on?: string | null };
type CfDeployment = {
  id: string;
  created_on: string;
  environment?: string;
  latest_stage?: CfStage;
  deployment_trigger?: { metadata?: { commit_hash?: string; commit_message?: string } };
};
type CfProject = { name: string; subdomain?: string; domains?: string[]; production_branch?: string };
type CfAccount = { id: string; name: string };

// Workers. Their deployments say which version serves, never which commit:
// Workers Builds records that on GitHub instead (see buildCheckName).
type CfWorker = { id: string; has_assets?: boolean };
type CfWorkerDeployment = {
  id: string;
  created_on: string;
  source?: string;
  annotations?: Record<string, string>;
  versions: { version_id: string; percentage: number }[];
};
type CfWorkerVersion = { id: string; number?: number };
type CfWorkerDomain = { hostname: string; service: string; environment?: string };

// A connection is a Pages project or a Worker. Connections made before
// Workers were supported have no kind: they are Pages projects.
export type CloudflareKind = "pages" | "worker";
export const kindOf = (conn: Pick<Connection, "settings">): CloudflareKind => (conn.settings?.kind === "worker" ? "worker" : "pages");

// In the picker a Worker and a Pages project may share a name (a site moved
// from one to the other), so a Worker's id carries a prefix; the connection
// itself stores the plain name.
const WORKER_ID = "worker:";

const NEEDS_WORKERS_READ = "add Account → Workers Scripts → Read to the token in Cloudflare → My Profile → API Tokens";
const NEEDS_CI_READ = "add Account → Workers Builds Configuration → Read to the token in Cloudflare → My Profile → API Tokens, or open the build on Cloudflare";

// A Workers Build's page, as its GitHub check links it:
// dash.cloudflare.com/<account>/workers/services/view/<worker>/<environment>/builds/<build>
const BUILD_PAGE = /^https:\/\/dash\.cloudflare\.com\/([a-f0-9]{32})\/workers\/services\/view\/([^/]+)\/[^/]+\/builds\/([a-f0-9-]{36})$/i;
// The end of a build's log is where it says why it failed; as many lines as
// GitHub job logs get. A finished build's log never changes.
const BUILD_LOG_LINES = 150;
const BUILD_LOG_PAGES = 20;
const BUILD_LOG_TTL_MS = 60 * 60_000;
type CfBuildLog = { lines?: (number | string)[][]; cursor?: string; truncated?: boolean };

// One line as the dashboard shows it: its time, then the message. Times
// come in seconds or milliseconds since 1970.
export const buildLogLine = (line: (number | string)[]) => {
  const at = line.find((x): x is number => typeof x === "number");
  const text = line.filter((x) => typeof x === "string").join(" ");
  return at === undefined ? text : `${new Date(at < 1e12 ? at * 1000 : at).toISOString()}\t${text}`;
};

export function phaseOf(d: Pick<CfDeployment, "latest_stage">): Deploy["phase"] {
  const stage = d.latest_stage;
  if (!stage) return "in-progress";
  if (stage.status === "failure") return "failed";
  if (stage.name === "deploy" && stage.status === "success") return "live";
  if (stage.status === "canceled" || stage.status === "skipped") return "other";
  return "in-progress"; // queued, cloning, building, or deploying
}

async function cf<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  const body = await getJson<CfEnvelope<T>>(`${API}${path}`, {
    token: await auth.token(),
    provider: "Cloudflare",
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  if (body.success === false) throw new Error(`Cloudflare: ${body.errors?.[0]?.message ?? "the request failed"}`);
  return body.result;
}

const accountOf = (conn: Connection) => {
  const id = conn.settings?.accountId;
  return typeof id === "string" && /^[a-f0-9]{32}$/i.test(id) ? id : undefined;
};

const dashboardOf = (conn: Connection) => {
  const account = accountOf(conn);
  if (!account) return undefined;
  const name = encodeURIComponent(conn.resource);
  return kindOf(conn) === "worker"
    ? `https://dash.cloudflare.com/${account}/workers/services/view/${name}/production`
    : `https://dash.cloudflare.com/${account}/pages/view/${name}`;
};

const pagesPath = (conn: Connection) => {
  const account = accountOf(conn);
  if (!account) throw new Error("This Pages project has no Cloudflare account id; connect it again from the list");
  return `/accounts/${account}/pages/projects/${encodeURIComponent(conn.resource)}`;
};

const workerPath = (conn: Connection) => {
  const account = accountOf(conn);
  if (!account) throw new Error("This Worker has no Cloudflare account id; connect it again from the list");
  return `/accounts/${account}/workers/scripts/${encodeURIComponent(conn.resource)}`;
};

const toDeploy = (d: CfDeployment, dashboard?: string): Deploy => {
  const phase = phaseOf(d);
  const stage = d.latest_stage;
  const meta = d.deployment_trigger?.metadata;
  const finishedAt = phase === "in-progress" ? undefined : stage?.ended_on;
  return {
    id: d.id,
    status: phase === "live" ? "live" : phase === "failed" ? `${stage?.name ?? "build"}_failed` : phase === "in-progress" ? (stage?.name ?? "queued") : (stage?.status ?? "other"),
    phase,
    ...(meta?.commit_hash ? { commit: { sha: meta.commit_hash, message: firstLine(meta.commit_message ?? ""), at: d.created_on } } : {}),
    startedAt: d.created_on,
    ...(finishedAt ? { finishedAt } : {}),
    ...(dashboard ? { url: `${dashboard}/${d.id}` } : {}),
  };
};

// A 403 from the Workers API means the token lacks one permission: name it.
async function workersCall<T>(auth: ServiceAuth, path: string): Promise<T> {
  try {
    return await cf<T>(auth, path);
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) throw new Error(`Cloudflare refused to show this Worker (403): ${NEEDS_WORKERS_READ}`);
    throw err;
  }
}

// Newest first; the first deployment is the one serving.
async function workerDeployments(conn: Connection, auth: ServiceAuth): Promise<CfWorkerDeployment[]> {
  const { deployments } = await workersCall<{ deployments?: CfWorkerDeployment[] }>(auth, `${workerPath(conn)}/deployments`);
  return deployments ?? [];
}

const toWorkerDeploy = (d: CfWorkerDeployment, serving: boolean, dashboard?: string): Deploy => ({
  id: d.id,
  status: serving ? "live" : "superseded",
  phase: serving ? "live" : "other",
  startedAt: d.created_on,
  finishedAt: d.created_on, // a Worker deployment switches over at once
  ...(dashboard ? { url: `${dashboard}/deployments` } : {}),
});

// The version serving most of the traffic (all of it, unless a gradual
// rollout is under way).
const mainVersion = (d: CfWorkerDeployment) => [...d.versions].sort((a, b) => b.percentage - a.percentage)[0];

async function workerHealth(conn: Connection, auth: ServiceAuth, at: string): Promise<CheckResult> {
  const live = (await workerDeployments(conn, auth))[0];
  if (!live) return { state: "up", at, summary: "No deploys yet" };
  const version = mainVersion(live);
  // The version number is a nicety; never fail the check over it.
  const number = version
    ? await workersCall<CfWorkerVersion>(auth, `${workerPath(conn)}/versions/${encodeURIComponent(version.version_id)}`)
        .then((v) => v.number)
        .catch(() => undefined)
    : undefined;
  const parts = [
    `Live since ${duration(Date.now() - Date.parse(live.created_on))} ago`,
    number !== undefined && `version ${number}`,
    live.versions.length > 1 && `rolling out across ${live.versions.length} versions`,
  ];
  return { state: "up", at, summary: parts.filter(Boolean).join(" · ") };
}

// An account's Workers, or that the token may not list them. A token made
// for Pages alone gets a 403 here: its Pages projects are still worth listing.
async function listWorkers(auth: ServiceAuth, account: CfAccount): Promise<{ workers: CfWorker[]; domains: CfWorkerDomain[]; refused: boolean }> {
  try {
    const workers = await cf<CfWorker[]>(auth, `/accounts/${account.id}/workers/scripts`);
    // Custom domains are one call per account; without them the list still works.
    const domains = workers.length ? await cf<CfWorkerDomain[]>(auth, `/accounts/${account.id}/workers/domains`).catch((): CfWorkerDomain[] => []) : [];
    return { workers, domains, refused: false };
  } catch (err) {
    if (err instanceof ProviderError && err.status === 403) return { workers: [], domains: [], refused: true };
    throw err;
  }
}

// Workers Free allows 100,000 requests a day, Workers and Pages Functions
// together, counted from midnight UTC. Past it, requests fail (or skip the
// Worker) until the day turns.
export const WORKERS_FREE_DAILY = 100_000;

export async function workersRequestsToday(auth: ServiceAuth, now = Date.now()): Promise<UsageMeter[]> {
  const accounts = await cf<CfAccount[]>(auth, "/accounts?per_page=20");
  const day = new Date(now);
  const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const resetsAt = new Date(start.getTime() + 86_400_000).toISOString();
  return Promise.all(
    accounts.map(async (a) => {
      const data = await queryJson<{ viewer: { accounts: { workersInvocationsAdaptive?: { sum?: { requests?: number } }[] }[] } }>(
        `${API}/graphql`,
        {
          query:
            "query ($accountTag: string!, $start: Time!, $end: Time!) { viewer { accounts(filter: { accountTag: $accountTag }) { workersInvocationsAdaptive(limit: 10000, filter: { datetime_geq: $start, datetime_leq: $end }) { sum { requests } } } } }",
          variables: { accountTag: a.id, start: start.toISOString(), end: new Date(now).toISOString() },
        },
        { token: await auth.token(), provider: "Cloudflare", ttlMs: 60_000 },
      );
      const rows = data.viewer.accounts[0]?.workersInvocationsAdaptive ?? [];
      const used = rows.reduce((n, r) => n + (r.sum?.requests ?? 0), 0);
      return { label: accounts.length > 1 ? `Workers requests today · ${a.name}` : "Workers requests today", used, limit: WORKERS_FREE_DAILY, resetsAt };
    }),
  );
}

export const cloudflareIntegration: Integration = {
  ...described("cloudflare"),

  planUsage: (auth) => workersRequestsToday(auth),

  // Cloudflare's status page lists Workers and Pages apart: an incident in
  // one isn't the other's.
  statusParts: (conn) => (kindOf(conn) === "worker" ? ["Workers", "Workers Assets", "Workers Builds", "Wrangler"] : ["Pages"]),
  resourceName: (r) => r.id.replace(WORKER_ID, ""),

  // settings: { kind: "pages" | "worker", accountId, name }; no kind = Pages.
  parse({ resource, settings }) {
    const raw = requiredText(resource, "Pages project or Worker", 70);
    const s = (settings ?? {}) as Record<string, unknown>;
    const kind: CloudflareKind = s.kind === "worker" || raw.startsWith(WORKER_ID) ? "worker" : "pages";
    const name = raw.startsWith(WORKER_ID) ? raw.slice(WORKER_ID.length) : raw;
    if (kind === "pages" && (name.length > 58 || !/^[a-z0-9][a-z0-9-]*$/i.test(name))) {
      throw badRequest("A Pages project name has letters, digits and dashes");
    }
    if (kind === "worker" && (name.length > 63 || !/^[a-z0-9][a-z0-9_-]*$/i.test(name))) {
      throw badRequest("A Worker name has letters, digits, dashes and underscores");
    }
    if (typeof s.accountId !== "string" || !/^[a-f0-9]{32}$/i.test(s.accountId)) {
      throw badRequest(`Pick the ${kind === "worker" ? "Worker" : "project"} from the list so its Cloudflare account is known`);
    }
    return { resource: name, settings: { kind, accountId: s.accountId, name } };
  },

  async testService(auth): Promise<KeyTest> {
    const accounts = await cf<CfAccount[]>(auth, "/accounts?per_page=20");
    const message = `Connected to ${accounts.map((a) => a.name).join(", ") || "Cloudflare"}`;
    // A user token says when it expires; an account-owned token can't be
    // verified here, and its expiry just stays unknown.
    let expiresAt: string | undefined;
    try {
      const token = await cf<{ expires_on?: string | null }>(auth, "/user/tokens/verify", 0);
      const at = token.expires_on ? Date.parse(token.expires_on) : NaN;
      if (!Number.isNaN(at)) expiresAt = new Date(at).toISOString();
    } catch {
      // not a user token, or no permission to verify: nothing more to say
    }
    return { message, ...(expiresAt ? { expiresAt } : {}) };
  },

  async listResources(auth) {
    const accounts = await cf<CfAccount[]>(auth, "/accounts?per_page=20");
    // A token only sees the accounts it was given. "Nothing found" would
    // leave you guessing; say which accounts were searched and what to change.
    if (accounts.length === 0) {
      throw new Error(
        "This token can't see any Cloudflare account. In Cloudflare → My Profile → API Tokens, edit it and set Account Resources to All accounts (or the account your sites are in).",
      );
    }
    const lists = await Promise.all(
      accounts.map(async (account) => {
        const [projects, workers] = await Promise.all([cf<CfProject[]>(auth, `/accounts/${account.id}/pages/projects`), listWorkers(auth, account)]);
        return { account, projects, ...workers };
      }),
    );
    if (lists.every(({ projects, workers }) => projects.length === 0 && workers.length === 0)) {
      const names = accounts.map((a) => a.name).join(", ");
      const refused = lists.some((l) => l.refused) ? ` This token can't list Workers: ${NEEDS_WORKERS_READ}.` : "";
      throw new Error(
        `No Cloudflare Pages projects or Workers in ${names}, the only account${accounts.length === 1 ? "" : "s"} this token can see. If your site is in another Cloudflare account, edit the token in Cloudflare → My Profile → API Tokens and set Account Resources to All accounts (or that account).${refused}`,
      );
    }
    return lists.flatMap(({ account, projects, workers, domains }): Resource[] => [
      ...projects.map((p) => ({
        id: p.name,
        label: p.name,
        detail: ["Pages", account.name, p.domains?.[0] ?? p.subdomain].filter(Boolean).join(" · "),
        settings: { kind: "pages", name: p.name, accountId: account.id },
      })),
      ...workers.map((w) => ({
        id: `${WORKER_ID}${w.id}`,
        label: w.id,
        detail: [
          "Worker",
          account.name,
          ...domains.filter((d) => d.service === w.id && (d.environment ?? "production") === "production").map((d) => d.hostname),
        ].join(" · "),
        settings: { kind: "worker", name: w.id, accountId: account.id },
      })),
    ]);
  },

  async deploys(conn, auth) {
    if (kindOf(conn) === "worker") {
      const dashboard = dashboardOf(conn);
      return (await workerDeployments(conn, auth)).slice(0, 20).map((d, i) => toWorkerDeploy(d, i === 0, dashboard));
    }
    const list = await cf<CfDeployment[]>(auth, `${pagesPath(conn)}/deployments?env=production&per_page=20`);
    return list.filter((d) => !d.environment || d.environment === "production").map((d) => toDeploy(d, dashboardOf(conn)));
  },

  // Workers Builds records each build as a GitHub check run of this name.
  buildCheckName: (conn) => (kindOf(conn) === "worker" ? `Workers Builds: ${conn.resource}` : undefined),

  // A failed build's log, through the Workers Builds API, which reads with
  // Workers Builds Configuration: Read (the API docs call it Workers CI:
  // Read). Only for this Worker's own builds, in its own account.
  async buildLog(conn, auth, url) {
    const m = url.match(BUILD_PAGE);
    if (kindOf(conn) !== "worker" || !m || m[1].toLowerCase() !== accountOf(conn)?.toLowerCase() || decodeURIComponent(m[2]) !== conn.resource) return undefined;
    try {
      const lines: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < BUILD_LOG_PAGES; page++) {
        const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
        const r = await cf<CfBuildLog>(auth, `/accounts/${m[1]}/builds/builds/${m[3]}/logs${query}`, BUILD_LOG_TTL_MS);
        lines.push(...(r.lines ?? []).map(buildLogLine));
        if (!r.cursor || r.cursor === cursor || !r.lines?.length) break;
        cursor = r.cursor;
      }
      return { log: lines.slice(-BUILD_LOG_LINES).join("\n") };
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) return { logProblem: `Cloudflare refused this build's log (${err.status}): ${NEEDS_CI_READ}` };
      return { logProblem: (err as Error).message };
    }
  },

  // Pages: down when the newest production deploy failed, or ran far longer
  // than usual. A Worker: up while a version serves. Its deployments only
  // exist once a build succeeded, so a failed build can't be seen from here
  // (the Builds API needs an Edit permission); GitHub's check reports it.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Cloudflare service connected" };
    try {
      if (kindOf(conn) === "worker") return await workerHealth(conn, auth, at);
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  // Workers get no Redeploy: deploying a version again needs Workers
  // Scripts: Edit, and retrying a build needs the Workers Builds API, which
  // needs an Edit permission too. A push (or the dashboard) rebuilds one.
  actions: (conn) =>
    kindOf(conn) === "worker"
      ? []
      : [
          {
            id: "redeploy",
            label: "Redeploy",
            description:
              "Retries the latest production deploy on Cloudflare Pages. The live site keeps serving until the new deploy is ready.",
          },
        ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy" || kindOf(conn) === "worker") throw new Error(`Cloudflare has no action "${actionId}" here`);
    // Never stack a second deploy on one that's already running; look fresh.
    const recent = await cf<CfDeployment[]>(auth, `${pagesPath(conn)}/deployments?env=production&per_page=5`, 0);
    const deploys = recent.map((d) => toDeploy(d));
    const running = deploys.find((d) => d.phase === "in-progress");
    if (running) {
      return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status}). Wait for it to finish.` };
    }
    const latest = recent[0];
    if (!latest) return { ok: false, message: "There is no deploy to retry yet. Push a commit first." };

    const created = await postJson<CfEnvelope<{ id?: string } | null>>(
      `${API}${pagesPath(conn)}/deployments/${encodeURIComponent(latest.id)}/retry`,
      {},
      { token: await auth.token(), provider: "Cloudflare" },
    );
    if (created.success === false) throw new Error(`Cloudflare: ${created.errors?.[0]?.message ?? "the redeploy was refused"}`);
    const id = created.result?.id;
    return { ok: true, message: `Redeploy started${id ? ` (${id})` : ""}. It will show under Deploys.` };
  },

  async details(conn, auth) {
    const dashboardUrl = dashboardOf(conn);
    return deploysDetails(await this.deploys!(conn, auth), dashboardUrl, "Cloudflare");
  },

  notice(event, app, reason, _downForMs) {
    if (event === "up") return { title: `${app}: deploys are working again`, body: "The last deploy went live." };
    return reason.startsWith("Deploy running")
      ? { title: `${app}: a deploy is taking too long`, body: reason }
      : { title: `${app}: a deploy failed`, body: reason };
  },
};
