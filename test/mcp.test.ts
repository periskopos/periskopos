import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, test } from "node:test";
import { createApp } from "../server/app.ts";
import { Approvals } from "../server/agents/approvals.ts";
import type { App, Approval, Service, TrafficPoint, TrafficDetails } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { clearHttpCache } from "../server/http.ts";
import { StatusService } from "../server/status.ts";
import { updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { PeriskoposClient, PeriskoposError, tokenFolders } from "../mcp/client.ts";
import { trafficDetail } from "../mcp/shape.ts";
import { installedAppDataDir } from "../server/config.ts";
import { RUN_ACTION_TIMEOUT_MS, TOOL_NAMES, createMcpServer } from "../mcp/server.ts";
import { APPROVAL_TIMEOUT_MS } from "../server/agents/approvals.ts";
import { tempDir } from "./tmp.ts";

const TOKEN = "t".repeat(43); // the page's
const AGENT = "a".repeat(43); // the token file's, what the MCP server uses
const RENDER_KEY = "rnd_secret_value_9f3k";
const GITHUB_KEY = "ghp_secret_value_7d2m";
process.env.PERISKOPOS_TEST_RENDER_KEY = RENDER_KEY;
process.env.PERISKOPOS_TEST_GITHUB_KEY = GITHUB_KEY;

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const realFetch = globalThis.fetch;

type Call = { method: string; url: string; auth?: string; body?: unknown };
let calls: Call[];
let deploys: unknown[];
// GitHub's answers: the branch's CI runs, a run's jobs, and each job's log.
let ghRuns: unknown[];
let ghJobs: unknown[];
let ghLogs: Record<string, string | number>;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let db: DatabaseSync;
let gc: ReturnType<typeof createApp>;
let render: Service;
let app: App;
// How the screen answers an agent's request in these tests.
let answer: "approve" | "decline" | "wait";
let asked: Approval[];
let approvals: Approvals;

beforeEach(() => {
  clearHttpCache();
  calls = [];
  ghRuns = [];
  ghJobs = [];
  ghLogs = {};
  deploys = [{ id: "dep-1", status: "live", commit: { id: "bbb2222", message: "ship it", createdAt: iso(2 * H) }, createdAt: iso(2 * H), finishedAt: iso(2 * H - 120_000) }];
  // Providers' APIs (Render, GitHub) are faked; Periskopos's own app is called in-process.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url: url.pathname, auth: headers.authorization, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url.host === "api.render.com" && url.pathname.endsWith("/deploys")) {
      if (init?.method === "POST") return json({ id: "dep-new", status: "created" }, 201);
      return json(deploys.map((deploy) => ({ deploy, cursor: "x" })));
    }
    if (url.host === "api.github.com") {
      if (url.pathname.endsWith("/commits")) return json([{ sha: "aaa1111", html_url: "https://github.com/o/r/commit/aaa1111", commit: { message: "change\n\nbody", committer: { date: iso(3 * H) } } }]);
      if (url.pathname.endsWith("/actions/runs")) return json({ workflow_runs: ghRuns });
      if (/\/actions\/runs\/\d+\/jobs$/.test(url.pathname)) return json({ total_count: ghJobs.length, jobs: ghJobs });
      const log = url.pathname.match(/\/actions\/jobs\/(\d+)\/logs$/);
      if (log) {
        const answer = ghLogs[log[1]!];
        if (typeof answer === "number") return json({ message: "Gone" }, answer);
        return new Response(answer ?? "", { headers: { "content-type": "text/plain" } });
      }
      if (url.pathname.includes("/compare/")) return json({ status: "ahead" });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;

  answer = "approve";
  asked = [];
  // Short, for "no answer in time"; long enough that a test answering by
  // hand on a slow CI runner isn't beaten to it.
  approvals = new Approvals({ timeoutMs: 1000 });
  approvals.onRequest((a) => {
    asked.push(a);
    if (answer !== "wait") approvals.decide(a.id, answer === "approve");
  });

  db = openDb(":memory:");
  const user = store.createUser(db, "Me");
  updateSettings(db, user.id, { agentAccess: true }); // Claude is let in (off by default)
  render = store.createService(db, user.id, { type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_RENDER_KEY", canWrite: false });
  const github = store.createService(db, user.id, { type: "github", name: "My GitHub", secretRef: "PERISKOPOS_TEST_GITHUB_KEY", canWrite: false });
  const created = store.createApp(db, user.id, { name: "Star-Map", url: "http://star-map.example" });
  store.addConnection(db, created, { type: "github", serviceId: github.id, resource: "o/r", settings: { branch: "main", paths: ["apps/star-map"] } });
  store.addConnection(db, created, { type: "render", serviceId: render.id, resource: "srv-abc", settings: { name: "star-map" } });
  app = store.getApp(db, user.id, created.slug)!;

  const watcher = new Watcher({
    db,
    notifier: { notify: async () => {} },
    baseUrl: "http://localhost:4100",
    status: new StatusService(0),
    isOnline: async () => true,
    fetchProvider: async () => ({ indicator: "none", description: "All Systems Operational", incidents: [] }),
  });
  const distDir = tempDir("periskopos-web-");
  writeFileSync(path.join(distDir, "index.html"), "");
  gc = createApp({ db, token: TOKEN, agentToken: AGENT, approvals, port: 4100, distDir, watcher });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

// An MCP client talking to the real MCP server over an in-memory link,
// with the Periskopos app called in-process.
async function connect(token: string | string[] = AGENT, fetchFn?: (url: string, init?: RequestInit) => Promise<Response>, options: { progressEveryMs?: number; clientName?: string } = {}) {
  const periskoposClient = new PeriskoposClient({ baseUrl: "http://127.0.0.1:4100", token, fetchFn: fetchFn ?? ((url, init) => Promise.resolve(gc.request(url, init))) });
  const server = createMcpServer(periskoposClient, options);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  // The AI assistant introduces itself, as Claude Code does.
  const client = new Client({ name: options.clientName ?? "claude-code", version: "0" });
  await client.connect(clientSide);
  return client;
}

type ToolResult = { isError?: boolean; content: { type: string; text: string }[] };

// The JSON the tools answer with: only the parts these tests look at.
type Reply = {
  apps: { slug: string; state: string; lastPush: { state: string; live: { sha: string } } }[];
  checks: { type: string }[];
  recentDeploys: { commit: { sha: string } }[];
  recentCommits: { message: string }[];
  providersAffectingIt: unknown[];
  recentActions: { by: string; action: string }[];
  history: { notWatchedStretches: number };
  days: unknown[];
  incidents: unknown;
  notWatched: unknown;
  services: { type: string; keyFound: boolean; actionsAllowed: boolean; usedBy: string[] }[];
  actions: { id: string }[];
  notAvailable: { reason: string }[];
  ok: boolean;
  result: string;
};

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as ToolResult;
  const text = res.content[0]?.text ?? "";
  let data: Reply;
  try {
    data = JSON.parse(text) as Reply;
  } catch {
    data = {} as Reply; // an error message, not JSON
  }
  return { isError: res.isError === true, text, data };
}

const api = async (method: string, p: string, body?: unknown, token = TOKEN) => {
  const res = await gc.request(`http://localhost:4100/api${p}`, { method, headers: { "x-periskopos-token": token, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
};

describe("the tools (FR-M2, FR-M4)", () => {
  test("exactly ten tools, and none adds, edits or deletes anything", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...TOOL_NAMES].sort());
    assert.ok(!tools.some((t) => /add|create|edit|update|delete|remove/i.test(t.name)));
  });

  test("nine are read-only; run_action is destructive and not read-only (so it is never auto-allowed)", async () => {
    const { tools } = await (await connect()).listTools();
    for (const t of tools) {
      if (t.name === "run_action") {
        assert.equal(t.annotations?.readOnlyHint, false);
        assert.equal(t.annotations?.destructiveHint, true);
      } else {
        assert.equal(t.annotations?.readOnlyHint, true, t.name);
      }
    }
  });

  test("run_action requires confirm: true in its schema", async () => {
    const { tools } = await (await connect()).listTools();
    const run = tools.find((t) => t.name === "run_action")!;
    assert.ok((run.inputSchema.required as string[]).includes("confirm"));
  });
});

describe("reading", () => {
  test("list_apps: state, uptime, last push", async () => {
    const client = await connect();
    const { data, isError } = await call(client, "list_apps");
    assert.equal(isError, false);
    assert.equal(data.apps.length, 1);
    const a = data.apps[0];
    assert.equal(a.slug, "star-map");
    assert.ok(["up", "down", "attention", "unknown"].includes(a.state));
    assert.equal(a.lastPush.state, "live");
    assert.equal(a.lastPush.live.sha, "bbb2222");
  });

  test("get_app: checks, deploys, commits, providers, no keys", async () => {
    const client = await connect();
    const { data, text, isError } = await call(client, "get_app", { slug: "star-map" });
    assert.equal(isError, false);
    assert.deepEqual(data.checks.map((c: { type: string }) => c.type).sort(), ["github", "render", "site"]);
    assert.equal(data.recentDeploys[0].commit.sha, "bbb2222");
    assert.equal(data.recentCommits[0].message, "change");
    assert.equal(data.providersAffectingIt.length, 2);
    assert.ok(Array.isArray(data.recentActions));
    assert.equal(data.history.notWatchedStretches >= 0, true);
    assert.equal(text.includes(TOKEN) || text.includes(RENDER_KEY) || text.includes(GITHUB_KEY), false);
  });

  test("get_history: incidents, gaps, per-day uptime", async () => {
    const site = app.connections.find((c) => c.type === "site")!;
    const startedAt = iso(H);
    history.openIncident(db, { appId: app.id, connectionId: site.id, kind: "outage", startedAt, reason: "Site answered 502" });
    const { data, isError } = await call(await connect(), "get_history", { slug: "star-map" });
    assert.equal(isError, false);
    assert.equal(data.days.length, 30);
    assert.deepEqual(data.incidents, [{ kind: "outage", reason: "Site answered 502", from: startedAt, ongoing: true }]);
    assert.deepEqual(data.notWatched, [], "never watched, so no gap between watched stretches");
  });

  test("list_services: key found, actions allowed, apps using it; never a key or variable name", async () => {
    const { data, text } = await call(await connect(), "list_services");
    const r = data.services.find((s) => s.type === "render");
    assert.ok(r, "the Render service is listed");
    assert.deepEqual(
      { keyFound: r.keyFound, actionsAllowed: r.actionsAllowed, usedBy: r.usedBy },
      { keyFound: true, actionsAllowed: false, usedBy: ["Star-Map"] },
    );
    for (const secret of [TOKEN, RENDER_KEY, GITHUB_KEY, "PERISKOPOS_TEST_RENDER_KEY", "secretRef"]) assert.equal(text.includes(secret), false, secret);
  });

  test("an unknown app is a clear error, not a crash", async () => {
    const { isError, text } = await call(await connect(), "get_app", { slug: "nope" });
    assert.equal(isError, true);
    assert.equal(text, "No such app");
  });
});

describe("run_action (FR-M3)", () => {
  const redeployId = () => `redeploy:${app.connections.find((c) => c.type === "render")!.id}`;
  const posts = () => calls.filter((c) => c.method === "POST");

  test("a read-only service offers nothing, and says why", async () => {
    const { data } = await call(await connect(), "list_actions", { slug: "star-map" });
    assert.deepEqual(data.actions, []);
    assert.match(data.notAvailable[0].reason, /My Render is read only/);
  });

  test("and refuses to run, without calling Render", async () => {
    const { isError, text } = await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(isError, true);
    assert.match(text, /read only/);
    assert.equal(posts().length, 0);
  });

  test("without confirm: true it never reaches Periskopos", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    const client = await connect();
    let refused = false;
    try {
      const r = await call(client, "run_action", { slug: "star-map", action_id: redeployId(), confirm: false });
      refused = r.isError;
    } catch {
      refused = true;
    }
    assert.equal(refused, true);
    assert.equal(posts().length, 0);
  });

  test("with actions allowed: redeploys with the right call, records it as Claude's", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    const client = await connect();

    const listed = (await call(client, "list_actions", { slug: "star-map" })).data;
    assert.deepEqual(listed.actions.map((a: { id: string }) => a.id), [redeployId()]);

    const { data, isError } = await call(client, "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(isError, false);
    assert.equal(data.ok, true);
    assert.match(data.result, /^Redeploy started \(dep-new, created\)/);

    const [post] = posts();
    assert.equal(post.url, "/v1/services/srv-abc/deploys");
    assert.deepEqual(post.body, { clearCache: "do_not_clear" });
    assert.equal(post.auth, `Bearer ${RENDER_KEY}`);

    const detail = (await call(client, "get_app", { slug: "star-map" })).data;
    assert.equal(detail.recentActions[0].by, "Claude Code", "named after the assistant that asked");
    assert.equal(detail.recentActions[0].action, "Redeploy");
    const { body } = await api("GET", "/apps/star-map/activity");
    assert.equal(body.activity[0].source, "mcp");
  });

  test("never stacks a second deploy on one that's running", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    deploys = [{ id: "dep-2", status: "build_in_progress", commit: { id: "ccc3333", message: "wip", createdAt: iso(60_000) }, createdAt: iso(60_000), finishedAt: null }, ...deploys];
    const { data } = await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(data.ok, false);
    assert.match(data.result, /already running/);
    assert.equal(posts().length, 0);
  });

  test("a provider failure is reported and recorded, not thrown", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    const real = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST" ? json({ message: "Service suspended" }, 400) : real(input, init)) as typeof fetch;
    const { data } = await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(data.ok, false);
    assert.match(data.result, /Service suspended/);
    assert.equal((await api("GET", "/apps/star-map/activity")).body.activity[0].ok, false);
  });

  test("an id that isn't one of the app's actions is refused", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    for (const id of ["redeploy:c_nope", "wipe:c_nope", "garbage"]) {
      const { isError, text } = await call(await connect(), "run_action", { slug: "star-map", action_id: id, confirm: true });
      assert.equal(isError, true, id);
      assert.equal(text, "No such action");
    }
  });
});

describe("the actions API itself", () => {
  const rid = () => app.connections.find((c) => c.type === "render")!.id;

  test("it won't run without confirmed: true", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    assert.equal((await api("POST", `/apps/star-map/actions/redeploy:${rid()}`, {})).status, 400);
    assert.equal((await api("POST", `/apps/star-map/actions/redeploy:${rid()}`, { confirmed: "yes" })).status, 400);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  test("the screen's runs are logged as the user's, and aren't asked about", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    assert.equal((await api("POST", `/apps/star-map/actions/redeploy:${rid()}`, { confirmed: true })).status, 200);
    assert.equal((await api("GET", "/apps/star-map/activity")).body.activity[0].source, "ui");
    assert.equal(asked.length, 0);
  });

  test("who is asking comes from the token: an agent saying it's the screen is still asked about and logged as Claude", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    assert.equal((await api("POST", `/apps/star-map/actions/redeploy:${rid()}`, { confirmed: true, source: "ui" }, AGENT)).status, 200);
    assert.equal(asked.length, 1);
    assert.equal((await api("GET", "/apps/star-map/activity")).body.activity[0].source, "mcp");
  });

  test("Allow actions can be switched on and off again", async () => {
    assert.equal((await api("PATCH", `/services/${render.id}`, { canWrite: true })).body.service.canWrite, true);
    assert.equal((await api("PATCH", `/services/${render.id}`, { canWrite: false })).body.service.canWrite, false);
    assert.equal((await api("PATCH", `/services/${render.id}`, { canWrite: "yes" })).status, 400);
  });

  test("removing the service takes its actions away", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    await api("DELETE", `/services/${render.id}`);
    const { body } = await api("GET", "/apps/star-map/actions");
    assert.deepEqual(body, { actions: [], blocked: [] });
  });
});

describe("approval on screen (AGENT-SAFETY §4.2)", () => {
  const redeployId = () => `redeploy:${app.connections.find((c) => c.type === "render")!.id}`;
  const posts = () => calls.filter((c) => c.method === "POST");
  const waitUntilAsked = async () => {
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    return asked[0]!;
  };

  test("the request names the app, the action and the service", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]!.appSlug, asked[0]!.appName, asked[0]!.label, asked[0]!.service], ["star-map", "Star-Map", "Redeploy", "My Render"]);
  });

  test("declined: nothing runs, Claude is told, and the attempt is recorded", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "decline";
    const { isError, text } = await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(isError, true);
    assert.match(text, /Declined on screen\. Nothing was run/);
    assert.equal(posts().length, 0);
    const [entry] = (await api("GET", "/apps/star-map/activity")).body.activity;
    assert.deepEqual([entry.source, entry.ok, entry.message], ["mcp", false, "Declined on screen. Nothing was run."]);
  });

  test("no answer in time: nothing runs", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const { isError, text } = await call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(isError, true);
    assert.match(text, /in time\. Nothing was run/);
    assert.equal(posts().length, 0);
    assert.deepEqual(approvals.list(), [], "it no longer waits");
  });

  test("the screen sees what's waiting and answers it; agents can do neither", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    const { id } = await waitUntilAsked();

    assert.equal((await api("GET", "/approvals", undefined, AGENT)).status, 403);
    assert.equal((await api("POST", `/approvals/${id}`, { approve: true }, AGENT)).status, 403);
    const { body } = await api("GET", "/approvals");
    assert.deepEqual(body.approvals.map((a: Approval) => a.id), [id]);

    assert.equal((await api("POST", `/approvals/${id}`, { approve: "yes" })).status, 400);
    assert.equal((await api("POST", `/approvals/${id}`, { approve: true })).status, 200);
    const { data } = await running;
    assert.equal(data.ok, true);
    assert.equal(posts().length, 1);
    assert.equal((await api("POST", `/approvals/${id}`, { approve: true })).status, 404, "already answered");
  });

  test("switching Allow actions off while it waits means nothing runs", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    const { id } = await waitUntilAsked();
    await api("PATCH", `/services/${render.id}`, { canWrite: false });
    approvals.decide(id, true);
    const { isError, text } = await running;
    assert.equal(isError, true);
    assert.match(text, /read only now/);
    assert.equal(posts().length, 0);
    const [entry] = (await api("GET", "/apps/star-map/activity")).body.activity;
    assert.deepEqual([entry.source, entry.ok], ["mcp", false], "the refusal is in the audit log");
    assert.match(entry.message, /read only now/);
  });

  test("the app deleted while it waits: nothing runs, and no server error", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    const { id } = await waitUntilAsked();
    assert.equal((await api("DELETE", "/apps/star-map")).status, 204);
    approvals.decide(id, true);
    const { isError, text } = await running;
    assert.equal(isError, true);
    assert.match(text, /removed while waiting, so nothing was run/);
    assert.equal(posts().length, 0);
  });

  test("the app deleted while it waits, then declined: told so, not a server error", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    const { id } = await waitUntilAsked();
    await api("DELETE", "/apps/star-map");
    approvals.decide(id, false);
    const { isError, text } = await running;
    assert.equal(isError, true);
    assert.match(text, /Declined on screen/);
  });

  test("the connection removed while it waits: nothing runs, and that's recorded", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    const { id } = await waitUntilAsked();
    assert.equal((await api("DELETE", `/apps/star-map/connections/${app.connections.find((c) => c.type === "render")!.id}`)).status, 204);
    approvals.decide(id, true);
    const { isError, text } = await running;
    assert.equal(isError, true);
    assert.match(text, /connection was removed while waiting/);
    assert.equal(posts().length, 0);
    const [entry] = (await api("GET", "/apps/star-map/activity")).body.activity;
    assert.equal(entry.ok, false);
  });

  test("approved just as the agent hung up: nothing runs behind its back", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const ctrl = new AbortController();
    approvals.onRequest((a) => {
      approvals.decide(a.id, true);
      ctrl.abort(); // after the answer, before the action runs
    });
    const res = await gc.request(`http://localhost:4100/api/apps/star-map/actions/${encodeURIComponent(redeployId())}`, {
      method: "POST",
      headers: { "x-periskopos-token": AGENT, "content-type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
      signal: ctrl.signal,
    });
    assert.equal(res.status, 409);
    assert.equal(posts().length, 0);
  });

  test("a cancelled tool call withdraws the question, so approving can't run it", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const ctrl = new AbortController();
    const running = (await connect()).callTool({ name: "run_action", arguments: { slug: "star-map", action_id: redeployId(), confirm: true } }, undefined, { signal: ctrl.signal });
    const { id } = await waitUntilAsked();
    ctrl.abort();
    await assert.rejects(running);
    for (let i = 0; i < 100 && approvals.list().length > 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(approvals.list(), [], "no longer asked");
    assert.equal(approvals.decide(id, true), false);
    assert.equal(posts().length, 0);
  });

  test("while it waits, a client that asked for progress hears from it", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const heard: { progress: number; message?: string }[] = [];
    const client = await connect(AGENT, undefined, { progressEveryMs: 30 });
    const running = client.callTool({ name: "run_action", arguments: { slug: "star-map", action_id: redeployId(), confirm: true } }, undefined, { onprogress: (p) => heard.push(p) });
    // Answered once it has heard twice, not left to expire: how many ticks
    // fit before then is up to the machine.
    const { id } = await waitUntilAsked();
    while (heard.length < 2 && approvals.list().length > 0) await new Promise((r) => setTimeout(r, 5));
    approvals.decide(id, false);
    await running;
    assert.ok(heard.length >= 2, `heard ${heard.length}`);
    assert.ok(heard.every((p, i) => p.progress === i + 1), "progress only goes up");
    assert.match(heard[0]!.message ?? "", /Waiting for approval/);
  });
});

describe("how long run_action waits", () => {
  test("long enough for the server's worst case: checking, approval, then the action", () => {
    assert.ok(RUN_ACTION_TIMEOUT_MS >= 2 * 15_000 + APPROVAL_TIMEOUT_MS + 60_000);
  });

  test("no answer in time is not reported as Periskopos not running", async () => {
    const hang = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const client = new PeriskoposClient({ baseUrl: "http://127.0.0.1:4100", token: AGENT, fetchFn: hang });
    await assert.rejects(client.post("/apps/x/actions/y", { confirmed: true }, { timeoutMs: 20 }), (err: Error) => {
      assert.ok(err instanceof PeriskoposError);
      assert.match(err.message, /no answer in time; the action may still have run.*get_app/s);
      assert.doesNotMatch(err.message, /isn't running/);
      return true;
    });
  });
});


describe("Claude's switch in Settings", () => {
  const redeployId = () => `redeploy:${app.connections.find((c) => c.type === "render")!.id}`;

  test("off: the agent token gets nothing, and Claude is told where to switch it on", async () => {
    await api("PATCH", "/settings", { agentAccess: false });
    const res = await api("GET", "/apps", undefined, AGENT);
    assert.equal(res.status, 403);
    assert.match(res.body.error, /switched off.*Settings/);
    const { isError, text } = await call(await connect(), "list_apps");
    assert.equal(isError, true);
    assert.match(text, /switched off/);
    assert.equal((await api("GET", "/apps")).status, 200, "the app itself is unaffected");
  });

  test("it's off for a new registry", async () => {
    const fresh = openDb(":memory:");
    store.createUser(fresh, "Me");
    const dir = tempDir("periskopos-web-");
    writeFileSync(path.join(dir, "index.html"), "");
    const other = createApp({ db: fresh, token: TOKEN, agentToken: AGENT, port: 4100, distDir: dir });
    const res = await other.request("http://localhost:4100/api/apps", { headers: { "x-periskopos-token": AGENT } });
    assert.equal(res.status, 403);
  });

  test("switching it off withdraws what Claude is waiting on, and nothing runs", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    answer = "wait";
    const running = call(await connect(), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    await api("PATCH", "/settings", { agentAccess: false });
    const { isError } = await running;
    assert.equal(isError, true);
    assert.deepEqual(approvals.list(), []);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  });

  test("only the app can change it", async () => {
    assert.equal((await api("PATCH", "/settings", { agentAccess: true }, AGENT)).status, 403);
    assert.equal((await api("PATCH", "/settings", { agentAccess: "yes" })).status, 400);
  });
});

describe("which AI assistant is asking", () => {
  const redeployId = () => `redeploy:${app.connections.find((c) => c.type === "render")!.id}`;

  test("the approval and the history name the tool, whatever it is", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    await call(await connect(AGENT, undefined, { clientName: "cursor-vscode" }), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(asked[0]!.agent, "Cursor");
    await call(await connect(AGENT, undefined, { clientName: "My <b>Bot</b> 1.0" }), "run_action", { slug: "star-map", action_id: redeployId(), confirm: true });
    assert.equal(asked[1]!.agent, "My bBotb 1.0", "unknown names are kept, as plain text");
    const { body } = await api("GET", "/apps/star-map/activity");
    assert.deepEqual(body.activity.slice(0, 2).map((a: { agent?: string }) => a.agent), ["My bBotb 1.0", "Cursor"]);
  });

  test("an agent token used without an MCP client is still recorded, as an AI assistant", async () => {
    await api("PATCH", `/services/${render.id}`, { canWrite: true });
    await api("POST", `/apps/star-map/actions/${redeployId()}`, { confirmed: true }, AGENT);
    assert.equal(asked[0]!.agent, "An AI assistant");
  });
});

const failingRun = { id: 77, name: "CI", workflow_id: 5, status: "completed", conclusion: "failure", head_sha: "aaa1111ffff", created_at: iso(H), html_url: "https://github.com/o/r/actions/runs/77" };

describe("check_app", () => {
  type Check = { type: string; state: string; problem?: string; seeWhy?: string };
  const github = (r: { data: Reply }) => (r.data.checks as Check[]).find((c) => c.type === "github")!;

  test("checks the app again now and answers with the fresh result", async () => {
    const client = await connect();
    const first = await call(client, "check_app", { slug: "star-map" });
    assert.equal(first.isError, false);
    assert.equal(github(first).state, "up");

    // CI breaks. get_app tells what was recorded; check_app checks again.
    ghRuns = [failingRun];
    clearHttpCache();
    assert.equal(github(await call(client, "get_app", { slug: "star-map" })).state, "up");
    const again = await call(client, "check_app", { slug: "star-map" });
    assert.equal(github(again).state, "down");
    assert.equal(github(again).problem, "CI failing on main", "a workflow named CI isn't named twice");
    assert.equal(github(again).seeWhy, failingRun.html_url);
    assert.equal(again.text.includes(GITHUB_KEY) || again.text.includes(RENDER_KEY), false);
  });

  test("an unknown app is a clear error", async () => {
    const { isError, text } = await call(await connect(), "check_app", { slug: "nope" });
    assert.equal(isError, true);
    assert.equal(text, "No such app");
  });
});

describe("get_failure_log", () => {
  const job = (id: number, conclusion: string, name = `job ${id}`) => ({
    id,
    name,
    status: "completed",
    conclusion,
    html_url: `https://github.com/o/r/actions/runs/77/job/${id}`,
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "npm run check", status: "completed", conclusion: conclusion === "success" ? "success" : "failure" },
      { name: "Post Run actions/checkout@v4", status: "completed", conclusion: "success" },
    ],
  });
  type Failure = {
    failing: boolean;
    note?: string;
    repositories: { repository: string; branch: string; failingRuns: { workflow: string; commit: string; seeWhy: string; failedJobs: { job: string; failedStep?: string; logTail?: string; logProblem?: string }[] }[] }[];
  };
  const read = async (slug = "star-map") => {
    const r = await call(await connect(), "get_failure_log", { slug });
    return { ...r, failure: r.data as unknown as Failure };
  };

  test("the end of the failed job's log, ending at the error, without timestamps or colours", async () => {
    ghRuns = [failingRun];
    ghJobs = [job(1, "success", "lint"), job(2, "failure", "test")];
    const stamp = "2026-10-18T10:00:00.1234567Z ";
    ghLogs = {
      "2": [
        "\uFEFF" + stamp + "##[group]Run npm run check",
        ...Array.from({ length: 200 }, (_, i) => `${stamp}\x1b[32mline ${i}\x1b[0m`),
        `${stamp}not ok 1 - get_app shows the checks`,
        `${stamp}##[error]Process completed with exit code 1.`,
        `${stamp}Post job cleanup.`,
        `${stamp}[command]/usr/bin/git version`,
        "",
      ].join("\r\n"),
    };
    const { isError, text, failure } = await read();
    assert.equal(isError, false);
    assert.equal(failure.failing, true);
    const [repo] = failure.repositories;
    assert.deepEqual([repo!.repository, repo!.branch], ["o/r", "main"]);
    const [run] = repo!.failingRuns;
    assert.deepEqual([run!.workflow, run!.commit, run!.seeWhy], ["CI", "aaa1111", failingRun.html_url]);
    assert.deepEqual(run!.failedJobs.map((j) => [j.job, j.failedStep]), [["test", "npm run check"]], "only the failed job, and the step that failed");
    const lines = run!.failedJobs[0]!.logTail!.split("\n");
    assert.equal(lines.length, 150);
    assert.equal(lines.at(-1), "##[error]Process completed with exit code 1.");
    assert.equal(lines.at(-2), "not ok 1 - get_app shows the checks");
    assert.equal(lines[0], "line 52");
    assert.equal(/1234567Z|\\u001b|cleanup/.test(text), false, "no timestamps, colours or clean-up");
    assert.equal(text.includes(GITHUB_KEY) || text.includes(RENDER_KEY) || text.includes(TOKEN), false);
    // The log was read with the account's key, from GitHub's own API.
    assert.equal(calls.find((c) => c.url.endsWith("/actions/jobs/2/logs"))!.auth, `Bearer ${GITHUB_KEY}`);
    assert.equal(calls.some((c) => c.url.endsWith("/actions/jobs/1/logs")), false, "a job that passed isn't read");
  });

  test("a log GitHub no longer has is said, and the job's page is still given", async () => {
    ghRuns = [failingRun];
    ghJobs = [job(2, "failure")];
    ghLogs = { "2": 410 };
    const { isError, failure } = await read();
    assert.equal(isError, false);
    const j = failure.repositories[0]!.failingRuns[0]!.failedJobs[0]!;
    assert.match(j.logProblem!, /Couldn't read the log: GitHub answered HTTP 410/);
    assert.equal(j.logTail, undefined);
  });

  test("at most three jobs' logs, the rest by their page", async () => {
    ghRuns = [failingRun];
    ghJobs = [1, 2, 3, 4].map((id) => job(id, "failure"));
    ghLogs = { "1": "a", "2": "b", "3": "c", "4": "d" };
    const jobs = (await read()).failure.repositories[0]!.failingRuns[0]!.failedJobs;
    assert.deepEqual(jobs.map((j) => j.logTail), ["a", "b", "c", undefined]);
    assert.match(jobs[3]!.logProblem!, /first 3/);
  });

  test("nothing failing: says so, and reads no log", async () => {
    ghRuns = [{ ...failingRun, conclusion: "success" }];
    const { isError, failure } = await read();
    assert.equal(isError, false);
    assert.equal(failure.failing, false);
    assert.match(failure.note!, /Nothing is failing/);
    assert.equal(calls.some((c) => c.url.includes("/jobs")), false);
  });

  test("an app without a GitHub repository says how to connect one", async () => {
    store.createApp(db, app.ownerId, { name: "Bare", url: "http://bare.example" });
    const { isError, text } = await read("bare");
    assert.equal(isError, true);
    assert.match(text, /no GitHub repository connected/);
  });

  test("the route is a read the agent token may make; a connection without logs is a 404", async () => {
    const gh = app.connections.find((c) => c.type === "github")!;
    const rd = app.connections.find((c) => c.type === "render")!;
    assert.equal((await api("GET", `/apps/star-map/connections/${gh.id}/failure-log`, undefined, AGENT)).status, 200);
    assert.equal((await api("GET", `/apps/star-map/connections/${rd.id}/failure-log`, undefined, AGENT)).status, 404);
  });
});

describe("get_traffic", () => {
  test("an app without a Cloudflare domain says how to get one", async () => {
    const { isError, text } = await call(await connect(), "get_traffic", { slug: "star-map" });
    assert.equal(isError, true);
    assert.match(text, /no Cloudflare domain connected/);
  });

  test("shapes the totals, one figure per day or hour, and Web Analytics", () => {
    const day = (d: string, requests: number): TrafficPoint => ({ at: d, requests, cachedRequests: requests / 2, bytes: 1000, visitors: requests / 10, errors5xx: 1 });
    const totals = { requests: 300, cachedPct: 50, bytes: 3000, visitors: 30, errors5xx: 3, errorPct: 1 };
    const z: TrafficDetails = {
      shape: "traffic",
      zone: "example.org",
      status: "active",
      paused: false,
      developmentMode: false,
      traffic: { hours: [day("2026-10-17T10:00:00Z", 10)], days: Array.from({ length: 30 }, (_, i) => day(`2026-09-${String(i + 1).padStart(2, "0")}`, 100)), totals: { day: totals, week: totals, month: totals } },
      visitors: { state: "off", message: "Web Analytics is off for example.org" },
    };
    const week = trafficDetail(app, z, "7d") as Record<string, unknown>;
    assert.equal((week.perDay as unknown[]).length, 7);
    assert.deepEqual(week.totals, { requests: 300, visitors: 30, servedFromCachePct: 50, errors5xx: 3, errorPct: 1, bytes: 3000 });
    assert.deepEqual(week.webAnalytics, { state: "off", note: "Web Analytics is off for example.org" });
    assert.equal(((trafficDetail(app, z, "24h") as Record<string, unknown>).perHour as unknown[]).length, 1);
    assert.equal(((trafficDetail(app, z, "30d") as Record<string, unknown>).perDay as unknown[]).length, 30);
  });
});

describe("the agent token's limits (AGENT-SAFETY §4.1)", () => {
  test("it reads", async () => {
    for (const p of ["/me", "/apps", "/apps/star-map", "/services", "/apps/star-map/actions", "/apps/star-map/activity", "/settings"]) {
      assert.equal((await api("GET", p, undefined, AGENT)).status, 200, p);
    }
  });

  test("it can't change anything else", async () => {
    const refused: [string, string, unknown?][] = [
      ["PATCH", `/services/${render.id}`, { canWrite: true }],
      ["DELETE", `/services/${render.id}`],
      ["POST", "/services", { type: "render", name: "x", secretRef: "X_KEY" }],
      ["POST", "/apps", { name: "x", url: "https://x.example" }],
      ["PATCH", "/apps/star-map", { name: "y" }],
      ["DELETE", "/apps/star-map"],
      ["POST", "/apps/star-map/protocol/generate", { capabilities: ["metrics"] }],
      ["PATCH", "/settings", { watcherEnabled: false }],
      ["POST", "/notifications/test", {}],
      ["POST", "/setup", { name: "x" }],
    ];
    for (const [method, p, body] of refused) {
      const res = await api(method, p, body, AGENT);
      assert.equal(res.status, 403, `${method} ${p}`);
      assert.match(res.body.error, /done on screen/);
    }
    assert.equal(store.getService(db, app.ownerId, render.id)!.canWrite, false);
    assert.ok(store.getApp(db, app.ownerId, "star-map"));
  });
});

describe("when Periskopos can't be reached", () => {
  test("without PERISKOPOS_DATA_DIR it tries the installed app's token, then this folder's, and keeps the one that works", async () => {
    const sent: string[] = [];
    const client = await connect(["x".repeat(43), AGENT], (url, init) => {
      sent.push((init?.headers as Record<string, string>)["x-periskopos-token"]!);
      return Promise.resolve(gc.request(url, init));
    });
    const first = await call(client, "list_apps");
    assert.equal(first.isError, false);
    assert.ok(sent.includes("x".repeat(43)) && sent.includes(AGENT), "the first is tried, then the next");
    // A tool may make a few requests at once; the next call sends only the one that worked.
    const before = sent.length;
    assert.equal((await call(client, "list_apps")).isError, false);
    assert.ok(sent.length > before);
    assert.deepEqual([...new Set(sent.slice(before))], [AGENT], "the working token is kept");
    assert.deepEqual(tokenFolders({ PERISKOPOS_DATA_DIR: "/somewhere" }).length, 1);
    const folders = tokenFolders({});
    assert.equal(folders[0], installedAppDataDir(), "the installed app first");
    assert.ok(folders.some((f) => f.endsWith(path.join("periskopos", "data"))));
  });

  test("not running: says how to start it", async () => {
    const client = await connect(TOKEN, () => Promise.reject(new Error("ECONNREFUSED")));
    const { isError, text } = await call(client, "list_apps");
    assert.equal(isError, true);
    assert.match(text, /isn't running.*Open the Periskopos app/s);
  });

  test("wrong token: says where to look", async () => {
    const { isError, text } = await call(await connect("x".repeat(43)), "list_apps");
    assert.equal(isError, true);
    assert.match(text, /rejected the agent token.*PERISKOPOS_DATA_DIR/s);
  });

  test("set up not done yet: passes the server's own words on", async () => {
    // A registry with no user.
    const empty = openDb(":memory:");
    const dir = tempDir("periskopos-web-");
    writeFileSync(path.join(dir, "index.html"), "");
    const bare = createApp({ db: empty, token: TOKEN, port: 4100, distDir: dir });
    const client = await connect(TOKEN, (url, init) => Promise.resolve(bare.request(url, init)));
    const { isError, text } = await call(client, "list_apps");
    assert.equal(isError, true);
    assert.equal(text, "Set up Periskopos first");
  });
});
