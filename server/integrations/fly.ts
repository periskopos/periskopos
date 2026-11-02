import { duration } from "../../shared/format.ts";
import type { CheckResult, Connection, Deploy } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { deployHealth } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Fly.io as a host, through the Machines API (its GraphQL API is
// undocumented and being retired). Fly keeps no deploy history there: each
// release is read from the Machines running it, so only the current ones
// show, and without the commit they built ("is my last push live?" needs a
// host that records it). What it does say: a release still rolling out, a
// Machine that failed, and health checks failing on a running Machine.

const API = "https://api.machines.dev/v1";

type FlyCheck = { name?: string; status?: string; output?: string };
type FlyMachine = {
  id: string;
  name?: string;
  state: string; // created, starting, started, stopping, stopped, suspended, replacing, destroying, destroyed, failed…
  region?: string;
  created_at: string;
  updated_at?: string;
  image_ref?: { repository?: string; tag?: string };
  config?: { metadata?: Record<string, string> };
  checks?: FlyCheck[];
};

// A token from `fly tokens create` comes as "FlyV1 fm2_…", which is its own
// scheme; an older personal token goes as a Bearer token.
async function api<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  const token = (await auth.token()).trim();
  const headers: Record<string, string> = token.startsWith("FlyV1 ") ? { authorization: token } : {};
  return getJson<T>(`${API}${path}`, { token, headers, provider: "Fly.io", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const SETTLING = new Set(["created", "starting", "replacing", "updating", "launch_failed_retrying"]);
const FAILED = new Set(["failed"]);
const GONE = new Set(["destroying", "destroyed"]);

const versionOf = (m: FlyMachine) => m.config?.metadata?.fly_release_version;

// One "deploy" per release the app's Machines run, newest first.
export function toDeploys(machines: FlyMachine[], app: string): Deploy[] {
  const byVersion = new Map<string, FlyMachine[]>();
  for (const m of machines) {
    if (GONE.has(m.state)) continue;
    const v = versionOf(m) ?? "?";
    byVersion.set(v, [...(byVersion.get(v) ?? []), m]);
  }
  const versions = [...byVersion.keys()].sort((a, b) => Number(b) - Number(a));
  return versions.map((v, i): Deploy => {
    const ms = byVersion.get(v)!;
    const times = ms.map((m) => Date.parse(m.updated_at ?? m.created_at)).filter(Number.isFinite);
    const startedAt = new Date(Math.min(...times)).toISOString();
    const finishedAt = new Date(Math.max(...times)).toISOString();
    const failed = ms.filter((m) => FAILED.has(m.state));
    const settling = ms.some((m) => SETTLING.has(m.state));
    let phase: Deploy["phase"];
    let status: string;
    if (i > 0) [phase, status] = ["other", "superseded"]; // older Machines still on a previous release
    else if (failed.length) [phase, status] = ["failed", `${failed.length} of ${ms.length} machines failed`];
    else if (settling) [phase, status] = ["in-progress", "rolling out"];
    else [phase, status] = ["live", "live"];
    const tag = ms[0]?.image_ref?.tag;
    return {
      id: v === "?" ? "release" : `v${v}`,
      status,
      phase,
      startedAt,
      ...(phase !== "in-progress" ? { finishedAt } : {}),
      url: `https://fly.io/apps/${encodeURIComponent(app)}/monitoring${tag ? `#${encodeURIComponent(tag)}` : ""}`,
    };
  });
}

// Running Machines whose health checks are failing: the release is out, but it isn't well.
export function failingChecks(machines: FlyMachine[]): { machine: string; check: string }[] {
  return machines
    .filter((m) => m.state === "started")
    .flatMap((m) => (m.checks ?? []).filter((c) => c.status === "critical").map((c) => ({ machine: m.name ?? m.id, check: c.name ?? "health check" })));
}

const machinesOf = (conn: Connection, auth: ServiceAuth) => api<FlyMachine[]>(auth, `/apps/${encodeURIComponent(conn.resource)}/machines`);

export const fly: Integration = {
  ...described("fly"),

  parse({ resource }) {
    const name = requiredText(resource, "Fly.io app", 63).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw badRequest("A Fly.io app is named like my-app: lowercase letters, digits and dashes");
    return { resource: name, settings: { name } };
  },

  async testService(auth) {
    const { total_apps, apps } = await api<{ total_apps?: number; apps?: unknown[] }>(auth, "/apps?org_slug=personal", 0);
    const n = total_apps ?? apps?.length ?? 0;
    return { message: `Connected: ${n} app${n === 1 ? "" : "s"} in your personal organization` };
  },

  async listResources(auth) {
    const { apps } = await api<{ apps?: { name: string; machine_count?: number }[] }>(auth, "/apps?org_slug=personal");
    if (!apps?.length) throw new Error("This Fly.io token sees no apps in your personal organization.");
    return apps.map((a) => ({
      id: a.name,
      label: a.name,
      // Its fly.dev address: a host serving the app's URL is its match.
      detail: [`${a.name}.fly.dev`, a.machine_count !== undefined ? `${a.machine_count} machine${a.machine_count === 1 ? "" : "s"}` : undefined].filter(Boolean).join(" · "),
      settings: { name: a.name },
    }));
  },

  async deploys(conn, auth) {
    return toDeploys(await machinesOf(conn, auth), conn.resource);
  },

  // Down when a Machine failed, a release has rolled out for far too long,
  // or a running Machine fails its health checks.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Fly.io account connected" };
    try {
      const machines = await machinesOf(conn, auth);
      const health = deployHealth(toDeploys(machines, conn.resource), at);
      if (health.state === "down") return health;
      const failing = failingChecks(machines);
      if (failing.length) {
        const first = failing[0]!;
        return { state: "down", at, detail: `Health check failing: ${first.check} on ${first.machine}${failing.length > 1 ? ` (and ${failing.length - 1} more)` : ""}`, summary: health.summary };
      }
      return health;
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), `https://fly.io/apps/${encodeURIComponent(conn.resource)}`, "Fly.io");
  },

  notice(event, app, reason, downForMs) {
    if (event === "up") return { title: `${app}: Fly.io Machines are healthy again`, body: `After ${duration(downForMs)}.` };
    if (reason.startsWith("Health check")) return { title: `${app}: a health check is failing`, body: reason };
    return reason.startsWith("Deploy running") ? { title: `${app}: a release is taking too long`, body: reason } : { title: `${app}: a Machine failed`, body: reason };
  },
};
