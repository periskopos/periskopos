import { duration } from "../../shared/format.ts";
import type { AuditResult, CheckResult, Connection, Deploy, FindingDraft } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson, postJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, Notice, ServiceAuth } from "./types.ts";

const API = "https://api.render.com/v1";

type RService = {
  id: string;
  name: string;
  type: string;
  dashboardUrl?: string;
  branch?: string;
  repo?: string;
  suspended?: string;
  serviceDetails?: { url?: string };
};
type RDeploy = {
  id: string;
  status: string;
  commit?: { id: string; message: string; createdAt: string };
  createdAt: string;
  finishedAt?: string | null;
};

const IN_PROGRESS = new Set(["created", "queued", "build_in_progress", "update_in_progress", "pre_deploy_in_progress"]);
const FAILED = new Set(["build_failed", "update_failed", "pre_deploy_failed"]);

export function phaseOf(status: string): Deploy["phase"] {
  if (status === "live") return "live";
  if (IN_PROGRESS.has(status)) return "in-progress";
  if (FAILED.has(status)) return "failed";
  return "other"; // deactivated (superseded), canceled
}

async function render<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Render", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const dashboardOf = (conn: Connection) => {
  const url = conn.settings?.dashboardUrl;
  return typeof url === "string" && url.startsWith("https://dashboard.render.com/") ? url : undefined;
};

const toDeploy = (d: RDeploy, dashboard?: string): Deploy => ({
  id: d.id,
  status: d.status,
  phase: phaseOf(d.status),
  ...(d.commit
    ? { commit: { sha: d.commit.id, message: firstLine(d.commit.message), at: d.commit.createdAt } }
    : {}),
  startedAt: d.createdAt,
  ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}),
  ...(dashboard ? { url: `${dashboard}/deploys/${d.id}` } : {}),
});

// A deploy that went live and was later replaced, in any host's words:
// Render says "deactivated", Cloudflare and DigitalOcean "superseded".
export const wasReplaced = (d: Deploy) => d.phase === "other" && (d.status === "deactivated" || d.status === "superseded");

// How long is too long for a deploy (FR-W4): 3× the usual time (the median
// of the last 10 successful ones), or 20 minutes until there are 5 to go by.
export function slowAfterMs(list: Deploy[]): { limitMs: number; usualMs?: number } {
  const times = list
    .filter((d) => d.finishedAt && (d.phase === "live" || wasReplaced(d)))
    .slice(0, 10)
    .map((d) => Date.parse(d.finishedAt!) - Date.parse(d.startedAt))
    .filter((ms) => ms > 0)
    .sort((a, b) => a - b);
  if (times.length < 5) return { limitMs: 20 * 60_000 };
  const usualMs = times[Math.floor(times.length / 2)];
  return { limitMs: 3 * usualMs, usualMs };
}

export const short = (d: Deploy) => (d.commit ? `${d.commit.sha.slice(0, 7)} “${d.commit.message}”` : d.id);

// What a host's newest deploys say about its health, for any host.
export function deployHealth(list: Deploy[], at: string): CheckResult {
  const live = list.find((d) => d.phase === "live");
  const liveLine = live ? `Live: ${short(live)} · ${duration(Date.now() - Date.parse(live.finishedAt ?? live.startedAt))} ago` : "Nothing live";
  const latest = list[0];
  if (!latest) return { state: "up", at, summary: "No deploys yet" };

  const failed = (d: Deploy): CheckResult => ({
    state: "down",
    at,
    detail: `Deploy failed (${d.status.replace(/_/g, " ")}): ${short(d)}`,
    summary: liveLine,
  });
  if (latest.phase === "failed") return failed(latest);
  if (latest.phase === "live") return { state: "up", at, summary: liveLine };

  let summary = liveLine;
  if (latest.phase === "in-progress") {
    const runningMs = Date.now() - Date.parse(latest.startedAt);
    const { limitMs, usualMs } = slowAfterMs(list);
    if (runningMs > limitMs) {
      return {
        state: "down",
        at,
        detail: `Deploy running for ${duration(runningMs)}${usualMs ? ` (usually ${duration(usualMs)})` : ""}: ${short(latest)}`,
        summary: liveLine,
      };
    }
    summary = `Deploying ${short(latest)} · ${liveLine}`;
  }
  // A deploy still running (in time) or one that was canceled says nothing
  // about whether deploys work: the newest one that finished does. Saying
  // "up" here would close a failed-deploy incident as if it had gone live.
  const settled = list.find((d) => d.phase === "live" || d.phase === "failed" || wasReplaced(d));
  if (!settled) return { state: "unknown", at, detail: "No deploy has finished yet", summary };
  if (settled.phase === "failed") return { ...failed(settled), summary };
  return { state: "up", at, summary };
}

// A host's notification, in any host's words: a failed or stuck deploy, or
// deploys working again.
export function deployNotice(event: "down" | "up", app: string, reason: string, downForMs: number): Notice {
  if (event === "up") return { title: `${app}: deploys are working again`, body: `The last deploy went live after ${duration(downForMs)}.` };
  return reason.startsWith("Deploy running") ? { title: `${app}: a deploy is taking too long`, body: reason } : { title: `${app}: a deploy failed`, body: reason };
}

// A service's settings that matter for configuration checks (GET
// /services/{id}). autoDeploy is deprecated in favour of autoDeployTrigger;
// older answers carry only autoDeploy.
type RServiceSettings = RService & {
  autoDeploy?: "yes" | "no";
  autoDeployTrigger?: "commit" | "checksPass" | "off";
  serviceDetails?: { url?: string; plan?: string; healthCheckPath?: string };
};

// What a service shows set up loosely: pushes that don't deploy, a web
// service Render can't health-check, a live app on an instance that sleeps.
export function auditService(s: RServiceSettings, live: boolean): FindingDraft[] {
  const settings = s.dashboardUrl?.startsWith("https://dashboard.render.com/") ? { link: { url: `${s.dashboardUrl}/settings`, label: "Open the service's settings" } } : {};
  const out: FindingDraft[] = [];
  const autoDeployOff = s.autoDeployTrigger ? s.autoDeployTrigger === "off" : s.autoDeploy === "no";
  if (autoDeployOff) {
    out.push({
      key: "auto-deploy-off",
      severity: "low",
      title: "Auto-deploy is off: pushes don't deploy",
      why: "A push to the service's branch changes nothing live until someone starts a deploy by hand, so fixes can sit undeployed.",
      fix: { steps: "In Render, open the service's Settings → Build & Deploy, set Auto-Deploy to On Commit (or After CI Checks Pass) and save.", ...settings },
    });
  }
  if (s.type === "web_service") {
    if (!s.serviceDetails?.healthCheckPath) {
      out.push({
        key: "health-check-path-missing",
        severity: "medium",
        title: "No health check path set",
        why: "Render can't tell a broken deploy from a working one, so a bad deploy replaces a good one as soon as it starts listening.",
        fix: {
          steps: "In Render, open the service's Settings → Health Checks, set Health Check Path to a route that answers 200 only when the app works (such as /healthz), and save.",
          ...settings,
        },
      });
    }
    if (live && s.serviceDetails?.plan === "free") {
      out.push({
        key: "free-instance",
        severity: "low",
        title: "A live app on a free instance",
        why: "Free web services spin down after 15 minutes without traffic, so the next visitor waits up to a minute for the page.",
        fix: { steps: "In Render, open the service's Settings → Instance Type and pick a paid type such as Starter.", ...settings },
      });
    }
  }
  return out;
}

export const renderIntegration: Integration = {
  ...described("render"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Render service", 100);
    if (!/^[a-z]{3,4}-[a-z0-9]+$/i.test(id)) throw badRequest("A Render service id looks like srv-abc123");
    const s = (settings ?? {}) as Record<string, unknown>;
    return {
      resource: id,
      settings: {
        ...(typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {}),
        ...(typeof s.dashboardUrl === "string" && s.dashboardUrl.startsWith("https://dashboard.render.com/")
          ? { dashboardUrl: s.dashboardUrl }
          : {}),
      },
    };
  },

  async testService(auth) {
    const owners = await render<{ owner: { name: string } }[]>(auth, "/owners?limit=20");
    return { message: `Connected to ${owners.map((o) => o.owner.name).join(", ") || "Render"}` };
  },

  async listResources(auth) {
    const list = await render<{ service: RService }[]>(auth, "/services?limit=100&includePreviews=false");
    return list.map(({ service: s }) => ({
      id: s.id,
      label: s.name,
      detail: [s.type.replace(/_/g, " "), s.serviceDetails?.url, s.suspended === "suspended" && "suspended"]
        .filter(Boolean)
        .join(" · "),
      settings: { name: s.name, ...(s.dashboardUrl ? { dashboardUrl: s.dashboardUrl } : {}) },
    }));
  },

  async deploys(conn, auth) {
    const list = await render<{ deploy: RDeploy }[]>(auth, `/services/${encodeURIComponent(conn.resource)}/deploys?limit=20`);
    return list.map(({ deploy }) => toDeploy(deploy, dashboardOf(conn)));
  },

  // Down when the newest deploy failed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Render service connected" };
    try {
      return deployHealth(await this.deploys!(conn, auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description:
        "Starts a new deploy of the latest commit on Render. Nothing is cleared; the live site keeps serving until the new deploy is ready.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`Render has no action "${actionId}"`);
    // Never stack a second deploy on one that's already running; look fresh.
    const recent = await render<{ deploy: RDeploy }[]>(auth, `/services/${encodeURIComponent(conn.resource)}/deploys?limit=5`, 0);
    const running = recent.map(({ deploy }) => toDeploy(deploy)).find((d) => d.phase === "in-progress");
    if (running) {
      return { ok: false, message: `A deploy is already running (${short(running)}, ${running.status.replace(/_/g, " ")}). Wait for it to finish.` };
    }

    const created = await postJson<{ id?: string; status?: string }>(
      `${API}/services/${encodeURIComponent(conn.resource)}/deploys`,
      { clearCache: "do_not_clear" },
      { token: await auth.token(), provider: "Render" },
    );
    const detail = created.id ? ` (${created.id}${created.status ? `, ${created.status.replace(/_/g, " ")}` : ""})` : "";
    return { ok: true, message: `Redeploy started${detail}. It will show under Deploys.` };
  },

  async details(conn, auth) {
    const dashboardUrl = dashboardOf(conn);
    return deploysDetails(await this.deploys!(conn, auth), dashboardUrl, "Render");
  },

  async audit(conn, auth, app): Promise<AuditResult> {
    if (!auth) return { findings: [], notes: ["No Render account connected"] };
    let service: RServiceSettings;
    try {
      service = await render<RServiceSettings>(auth, `/services/${encodeURIComponent(conn.resource)}`);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) return { findings: [], notes: ["The Render key can't read this service's settings, so they weren't checked."] };
      throw err;
    }
    return { findings: auditService(service, app.live) };
  },

  notice: deployNotice,
};
