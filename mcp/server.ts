import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ActionDef, ActionResult, ActivityEntry, App, AppHistory, AppStatus, BlockedAction, ConfigReport, ConnectionDetails, FailureLog, NotificationsView, ProtocolView, ProviderStatus, ServiceView } from "../shared/types.ts";
import { CONNECTIONS } from "../shared/catalog.ts";
import { APPROVAL_TIMEOUT_MS } from "../server/agents/approvals.ts";
import { PROTOCOL_ACTION_TIMEOUT_MS, PROTOCOL_TIMEOUT_MS } from "../server/protocol.ts";
import { PeriskoposClient, PeriskoposError } from "./client.ts";
import { actionList, appDetail, appSummary, checkList, configDetail, failureDetail, historyDetail, serviceList, trafficDetail } from "./shape.ts";

// The Periskopos MCP server (PRD §7.9, FR-M1–M4).
//
// Any MCP client can use it (Claude, Cursor, VS Code…); Periskopos is
// told which one, from MCP's clientInfo, and names it to me.
//
// Eight tools only read (check_app checks an app now, the same as "Check
// now" on screen, and get_failure_log reads CI's own log: neither changes
// anything in production). `run_action` changes something in production, so:
// - it is annotated as destructive and not read-only, and must never be on
//   an allow list: Claude Code then asks the user every time;
// - it also needs `confirm: true`, so a call states that the user asked;
// - the server refuses it unless the service allows actions;
// - the server then holds it until I approve it on screen in Periskopos
//   (docs/AGENT-SAFETY.md §4.2), whatever this client's own settings are.
// There is no tool to add, edit or delete apps or services (FR-M4).

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const failed = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

async function guarded(work: () => Promise<unknown>) {
  try {
    return text(await work());
  } catch (err) {
    if (err instanceof PeriskoposError) return failed(err.message);
    return failed(`Unexpected error: ${(err as Error).message}`);
  }
}

export const TOOL_NAMES = ["list_apps", "get_app", "check_app", "get_failure_log", "get_configuration", "get_history", "get_traffic", "list_services", "list_actions", "run_action"] as const;

// How long run_action waits for Periskopos, covering its worst case:
// checking the action (an app's own actions read its protocol endpoint: the
// manifest, then its lists, up to two timeouts), then my approval, then the
// action itself, plus room to spare. Shorter, and we'd report a failure
// while the action could still run.
export const RUN_ACTION_TIMEOUT_MS = 2 * PROTOCOL_TIMEOUT_MS + APPROVAL_TIMEOUT_MS + PROTOCOL_ACTION_TIMEOUT_MS + 30_000;

export function createMcpServer(gc: PeriskoposClient, { progressEveryMs = 15_000 }: { progressEveryMs?: number } = {}) {
  const server = new McpServer({ name: "periskopos", version: "0.1.0" });
  // Once the client has introduced itself, every request carries its name.
  server.server.oninitialized = () => {
    const client = server.server.getClientVersion();
    gc.setClient(client?.title ?? client?.name);
  };
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
  const slug = z.string().min(1).max(60).describe("The app's slug, as shown by list_apps (e.g. star-map)");

  server.registerTool(
    "list_apps",
    {
      title: "List my apps",
      description:
        "Lists every app watched by Periskopos with its state (up, down, attention, unknown, stale: no recent data, so not known to be up), any open problem, 30-day uptime over the time actually watched and whether the last push is live. watching lists anything wrong with Periskopos's own checks or alerts: while there is, what's listed may be out of date or a problem may have gone unannounced. Start here.",
      annotations: { title: "List my apps", ...readOnly },
    },
    () =>
      guarded(async () => {
        const [{ apps }, { statuses }, notifications] = await Promise.all([
          gc.get<{ apps: App[] }>("/apps"),
          gc.get<{ statuses: AppStatus[] }>("/status"),
          gc.get<NotificationsView>("/notifications"),
        ]);
        const watching = notifications.now.filter((n) => n.watching).map((n) => n.text);
        return { ...(watching.length ? { watching } : {}), apps: apps.map((a) => appSummary(a, statuses.find((s) => s.slug === a.slug))) };
      }),
  );

  server.registerTool(
    "get_app",
    {
      title: "Get one app",
      description:
        "Everything about one app: its checks (site, SSL, domain, GitHub, Cloudflare, Render, Supabase, Search Console) with the latest result, whether the last push is live, recent deploys, commits and CI runs, how it does in Google Search (clicks, impressions, position, top queries), recent incidents, providers with an incident that affects it, and recent actions run on it.",
      inputSchema: { slug },
      annotations: { title: "Get one app", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const { app } = await gc.get<{ app: App }>(base);
        const [{ status }, { history }, { providers }, { activity }, { services }, { protocol }] = await Promise.all([
          gc.get<{ status: AppStatus }>(`${base}/status`),
          gc.get<{ history: AppHistory }>(`${base}/history`),
          gc.get<{ providers: ProviderStatus[] }>("/providers"),
          gc.get<{ activity: ActivityEntry[] }>(`${base}/activity`),
          gc.get<{ services: ServiceView[] }>("/services"),
          gc.get<{ protocol: ProtocolView }>(`${base}/protocol`),
        ]);
        // A provider that fails to answer leaves a gap, not an error, and says so.
        const couldNotRead: string[] = [];
        const details = (
          await Promise.all(
            app.connections
              .filter((c) => CONNECTIONS[c.type]?.role !== undefined || ["search", "errors", "payments", "logs"].includes(CONNECTIONS[c.type]?.shows ?? ""))
              .map((c) =>
                gc.get<{ details: ConnectionDetails }>(`${base}/connections/${encodeURIComponent(c.id)}/details`).then(
                  (r) => r.details,
                  () => {
                    couldNotRead.push(CONNECTIONS[c.type]?.label ?? c.type);
                    return undefined;
                  },
                ),
              ),
          )
        ).filter((d): d is ConnectionDetails => d !== undefined);
        return appDetail({ app, status, history, details, couldNotRead, providers, activity, services, protocol });
      }),
  );

  server.registerTool(
    "check_app",
    {
      title: "Check one app now",
      description:
        "Checks one app now, the same as Check now in Periskopos, instead of waiting for the next scheduled check: its state and every check's fresh result. Use it after a fix or a deploy to confirm it worked. Providers' answers are kept for up to a minute, so a change made seconds ago may not show yet. Changes nothing in production.",
      inputSchema: { slug },
      annotations: { title: "Check one app now", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const { app } = await gc.get<{ app: App }>(base);
        const [{ status }, { services }] = await Promise.all([
          gc.get<{ status: AppStatus }>(`${base}/status?refresh=1`),
          gc.get<{ services: ServiceView[] }>("/services"),
        ]);
        return { ...appSummary(app, status), checks: checkList(app, status, services) };
      }),
  );

  server.registerTool(
    "get_failure_log",
    {
      title: "Read why CI failed",
      description:
        "For an app whose GitHub check is failing: each failing workflow's latest run on the app's branch, its failed jobs and the step that failed, and the last 150 lines of each failed job's log (up to 3 jobs), so you can tell the user why. GitHub hides the repository's secrets in its logs (***). A failed Cloudflare build is named with its page and the last 150 lines of its log, when the app's Cloudflare token can read Workers Builds Configuration. Only reads; to fix it, change the code, or ask the user before any run_action.",
      inputSchema: { slug },
      annotations: { title: "Read why CI failed", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const { app } = await gc.get<{ app: App }>(base);
        const sources = app.connections.filter((c) => c.type === "github");
        if (sources.length === 0) {
          throw new PeriskoposError(`${app.name} has no GitHub repository connected, so there's no CI log to read. Connect it on the app's Settings in Periskopos.`);
        }
        const repositories = (
          await Promise.all(
            sources.map((c) =>
              gc.get<{ failure: FailureLog }>(`${base}/connections/${encodeURIComponent(c.id)}/failure-log`).then((r) => failureDetail(c.resource, r.failure)),
            ),
          )
        ).filter((r) => r.failingRuns.length > 0 || r.failedBuilds);
        if (repositories.length === 0) {
          return { app: app.name, failing: false, note: "Nothing is failing on GitHub: each workflow's latest finished run passed. check_app shows the app's other checks." };
        }
        return { app: app.name, failing: true, repositories };
      }),
  );

  server.registerTool(
    "get_configuration",
    {
      title: "Get an app's configuration problems",
      description:
        "What's set up wrong around one app, worst first: its site (HTTPS, security headers, cookies, exposed files), its DNS (SPF, DMARC, CAA) and its connected accounts (GitHub branch protection, Cloudflare SSL mode, Supabase row level security, Vercel preview protection…). Each has why it matters and the exact fix, with anything to paste. Checked daily; the user's ignored ones are listed apart. Periskopos never changes these itself.",
      inputSchema: { slug },
      annotations: { title: "Get an app's configuration problems", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const [{ app }, { report }] = await Promise.all([gc.get<{ app: App }>(base), gc.get<{ report: ConfigReport }>(`${base}/config`)]);
        return configDetail(app, report);
      }),
  );

  server.registerTool(
    "get_history",
    {
      title: "Get an app's history",
      description:
        "The last 30 days for one app: uptime, every incident (outage, deploy, CI, expiry, dependency) with start and end, the stretches when Periskopos wasn't watching, and one uptime figure per day. Uptime counts only watched time.",
      inputSchema: { slug },
      annotations: { title: "Get an app's history", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const [{ app }, { history }] = await Promise.all([gc.get<{ app: App }>(base), gc.get<{ history: AppHistory }>(`${base}/history`)]);
        return historyDetail(app, history);
      }),
  );

  server.registerTool(
    "list_services",
    {
      title: "List my accounts",
      description:
        "The accounts connected to Periskopos (GitHub, Cloudflare, Render, Supabase): whether each key is found, whether actions are allowed, which apps use it, and the provider's own status page. Never returns keys.",
      annotations: { title: "List my accounts", ...readOnly },
    },
    () =>
      guarded(async () => {
        const [{ services }, { providers }] = await Promise.all([
          gc.get<{ services: ServiceView[] }>("/services"),
          gc.get<{ providers: ProviderStatus[] }>("/providers"),
        ]);
        return { services: serviceList(services, providers) };
      }),
  );

  server.registerTool(
    "list_actions",
    {
      title: "List an app's actions",
      description:
        "What can be done to an app (for example Redeploy on Render). Only accounts with 'Allow actions' switched on offer any; the rest are listed under notAvailable with the reason. Use the id with run_action.",
      inputSchema: { slug },
      annotations: { title: "List an app's actions", ...readOnly },
    },
    ({ slug }) =>
      guarded(async () => {
        const list = await gc.get<{ actions: ActionDef[]; blocked: BlockedAction[] }>(`/apps/${encodeURIComponent(slug)}/actions`);
        return actionList(slug, list);
      }),
  );

  server.registerTool(
    "run_action",
    {
      title: "Run an action (changes production)",
      description:
        "Runs one action from list_actions, such as redeploying an app. This changes something in production: only call it when the user has asked for exactly this action on exactly this app, and tell them what you are about to do. Periskopos then asks the user to approve it on screen and this call waits (up to 2 minutes) for their answer: tell them to look for the approval in Periskopos. If they decline or don't answer, nothing runs. The call is recorded with this assistant's name. Actions marked danger in list_actions are refused here: they can only be run on screen, where the user types the app's name.",
      inputSchema: {
        slug,
        action_id: z.string().min(1).max(100).describe("An id from list_actions, e.g. redeploy:c_abc123"),
        confirm: z.literal(true).describe("Must be true: you are acting on the user's explicit request for this action"),
      },
      annotations: { title: "Run an action (changes production)", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ slug, action_id }, extra) =>
      guarded(async () => {
        // While it waits for my approval, tell a client that asked for
        // progress that we're still here: some reset their own timeout
        // (often 60 s) on each one, and would otherwise give up first.
        const progressToken = extra._meta?.progressToken;
        let progress = 0;
        const ticker =
          progressToken === undefined
            ? undefined
            : setInterval(() => {
                progress += 1;
                void extra
                  .sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress, message: "Waiting for approval in Periskopos" },
                  })
                  .catch(() => {});
              }, progressEveryMs);
        try {
          const result = await gc.post<ActionResult & { label: string }>(
            `/apps/${encodeURIComponent(slug)}/actions/${encodeURIComponent(action_id)}`,
            { confirmed: true },
            // A cancelled tool call hangs up, so the approval is withdrawn.
            { timeoutMs: RUN_ACTION_TIMEOUT_MS, signal: extra.signal },
          );
          return { action: result.label, ok: result.ok, result: result.message };
        } finally {
          clearInterval(ticker);
        }
      }),
  );

  server.registerTool(
    "get_traffic",
    {
      title: "Get an app's traffic",
      description:
        "Traffic and visitors for one app, from its Cloudflare domain: requests, unique visitors, the share served from Cloudflare's cache and the share of failed (5xx) requests, for the last 24 hours, 7 days or 30 days, with one figure per day (or hour), plus visits, page views and top pages from Cloudflare Web Analytics when it's on. Only for apps with a Cloudflare domain connected.",
      inputSchema: {
        slug,
        range: z.enum(["24h", "7d", "30d"]).default("7d").describe("How far back: 24h (hourly), 7d or 30d (daily)"),
      },
      annotations: { title: "Get an app's traffic", ...readOnly },
    },
    ({ slug, range }) =>
      guarded(async () => {
        const base = `/apps/${encodeURIComponent(slug)}`;
        const { app } = await gc.get<{ app: App }>(base);
        const zone = app.connections.find((c) => CONNECTIONS[c.type]?.shows === "traffic");
        if (!zone) {
          throw new PeriskoposError(`${app.name} has no Cloudflare domain connected, so there's no traffic to show. Connect it on the app's Settings in Periskopos.`);
        }
        const { details } = await gc.get<{ details: ConnectionDetails }>(`${base}/connections/${encodeURIComponent(zone.id)}/details`);
        if (details.shape !== "traffic") throw new PeriskoposError(`${app.name}'s domain didn't answer with its traffic.`);
        return trafficDetail(app, details, range);
      }),
  );

  return server;
}
