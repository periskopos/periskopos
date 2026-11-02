import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import { addGrant, auditCsv, decide, LEGACY_NAME } from "../server/agents/agents.ts";
import type { AgentCtx } from "../server/agents/agents.ts";
import { createApp } from "../server/app.ts";
import { Approvals } from "../server/agents/approvals.ts";
import { openDb } from "../server/db.ts";
import { clearHttpCache } from "../server/http.ts";
import { updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { StatusService } from "../server/status.ts";
import { Watcher } from "../server/watcher.ts";
import { PeriskoposClient, PeriskoposError } from "../mcp/client.ts";
import type { AgentAuditEntry, AgentView, App, Approval, McpStatus } from "../shared/types.ts";
import { tempDir } from "./tmp.ts";

// AI assistants, one each (server/agents/agents.ts, docs/AGENT-SAFETY.md phase 2):
// their own tokens, what they may see and do, a rule per action, grants
// from the approval dialog, the kill switch, and the audit log.

const TOKEN = "t".repeat(43); // the screen's
const SHARED = "s".repeat(43); // the shared token file's
process.env.PERISKOPOS_TEST_RENDER_KEY = "rnd_secret_value_9f3k";
const realFetch = globalThis.fetch;

let db: DatabaseSync;
let gc: ReturnType<typeof createApp>;
let approvals: Approvals;
let asked: Approval[];
let answer: "approve" | "decline" | "wait";
let deployed: number;
let starMap: App;
let moonBase: App;
let userId: string;

beforeEach(() => {
  clearHttpCache();
  deployed = 0;
  // Render's API, faked: a redeploy is counted.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "api.render.com" && url.pathname.endsWith("/deploys")) {
      if (init?.method === "POST") {
        deployed++;
        return new Response(JSON.stringify({ id: "dep-new", status: "created" }), { status: 201, headers: { "content-type": "application/json" } });
      }
      return new Response("[]", { headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;

  answer = "approve";
  asked = [];
  approvals = new Approvals({ timeoutMs: 1000 });
  approvals.onRequest((a) => {
    asked.push(a);
    if (answer !== "wait") approvals.decide(a.id, answer === "approve");
  });

  db = openDb(":memory:");
  userId = store.createUser(db, "Me").id;
  updateSettings(db, userId, { agentAccess: true });
  const render = store.createService(db, userId, { type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_RENDER_KEY", canWrite: true });
  for (const [name, url] of [["Star-Map", "http://star-map.example"], ["Moon-Base", "http://moon-base.example"]] as const) {
    const created = store.createApp(db, userId, { name, url });
    store.addConnection(db, created, { type: "render", serviceId: render.id, resource: `srv-${name.toLowerCase()}`, settings: { name } });
  }
  starMap = store.getApp(db, userId, "star-map")!;
  moonBase = store.getApp(db, userId, "moon-base")!;
  const distDir = tempDir("periskopos-web-");
  writeFileSync(path.join(distDir, "index.html"), "");
  const watcher = new Watcher({ db, notifier: { notify: async () => {} }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true, fetchProvider: async () => ({ indicator: "none", description: "ok", incidents: [] }) });
  gc = createApp({ db, token: TOKEN, agentToken: SHARED, approvals, port: 4100, distDir, watcher });
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

async function call(method: string, apiPath: string, body?: unknown, token = TOKEN, client?: string) {
  const res = await gc.request(`http://localhost:4100/api${apiPath}`, {
    method,
    headers: { "x-periskopos-token": token, ...(client ? { "x-periskopos-client": client } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> & { error?: string } };
}

const redeploy = (a: App) => `redeploy:${a.connections.find((c) => c.type === "render")!.id}`;
const add = async (body: Record<string, unknown>) => (await call("POST", "/agents", body)).body as { agent: AgentView; token: string; setup: { claudeCode: string; json: string } };
const auditOf = async () => ((await call("GET", "/agents/audit")).body.entries as AgentAuditEntry[]);

describe("an assistant of its own", () => {
  test("added on screen: its token once, in a setup for Claude Code and as JSON; only its hash is kept", async () => {
    const { agent, token, setup } = await add({ name: "Claude Code", access: "ask", apps: "all" });
    assert.match(token, /^gca_[\w-]{43}$/);
    assert.match(setup.claudeCode, new RegExp(`^claude mcp add --env PERISKOPOS_AGENT_TOKEN=${token} --scope user periskopos node ".*mcp[\\\\/]main\\.ts"$`));
    assert.doesNotMatch(setup.claudeCode, / -- /, "no bare --, which PowerShell drops");
    assert.equal(JSON.parse(setup.json).mcpServers["periskopos"].env.PERISKOPOS_AGENT_TOKEN, token);
    const listed = (await call("GET", "/agents")).body.agents as AgentView[];
    assert.deepEqual(listed.filter((a) => !a.legacy).map((a) => a.name), ["Claude Code"]);
    assert.ok(!JSON.stringify(listed).includes(token), "the list never carries the token");
    const stored = db.prepare("SELECT token_hash FROM agents WHERE id = ?").get(agent.id) as { token_hash: string };
    assert.notEqual(stored.token_hash, token);
    assert.equal(stored.token_hash.length, 64);
  });

  test("its token reads, and asks; the approval names it, and knows which assistant it is", async () => {
    const { agent, token } = await add({ name: "Cursor at work", access: "ask", apps: "all" });
    assert.equal((await call("GET", "/apps", undefined, token)).status, 200);
    const r = await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    assert.equal(r.status, 200);
    assert.equal(deployed, 1);
    assert.equal(asked[0]?.agent, "Cursor at work");
    assert.equal(asked[0]?.agentId, agent.id);
  });

  test("assistants can't reach the assistants: not the list, not the audit log", async () => {
    const { token } = await add({ name: "A", access: "ask", apps: "all" });
    assert.equal((await call("GET", "/agents", undefined, token)).status, 403);
    assert.equal((await call("GET", "/agents/audit", undefined, token)).status, 403);
  });

  test("the shared token file still works, as an assistant of its own named so", async () => {
    assert.equal((await call("GET", "/apps", undefined, SHARED, "claude-code")).status, 200);
    const listed = (await call("GET", "/agents")).body.agents as AgentView[];
    assert.deepEqual(listed.map((a) => [a.name, a.legacy]), [[LEGACY_NAME, true]]);
    await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, SHARED, "claude-code");
    assert.equal(asked[0]?.agent, "Claude Code", "the shared token is named by the tool that says it's calling");
  });
});

describe("This PC: connecting without a token", () => {
  test("the setup on screen has no token, and This PC is there before its first request", async () => {
    const r = (await call("GET", "/agents")).body as { agents: AgentView[]; mcp: McpStatus };
    assert.match(r.mcp.setup.claudeCode, /^claude mcp add --scope user periskopos node ".*mcp[\\/]main\.ts"$/);
    assert.equal(JSON.parse(r.mcp.setup.json).mcpServers["periskopos"].env, undefined);
    assert.match(r.mcp.setup.claudeDesktop, /claude_desktop_config\.json$/);
    assert.equal(r.mcp.installed, true, "mcp/main.ts is in the app");
    assert.deepEqual(r.agents.map((a) => [a.name, a.legacy]), [[LEGACY_NAME, true]]);
    assert.equal(r.mcp.thisPcOff, false);
    assert.equal(r.mcp.lastRequest, undefined);
  });

  test("its last request is the status line's", async () => {
    await call("GET", "/apps", undefined, SHARED, "claude-code");
    const { mcp } = (await call("GET", "/agents")).body as { mcp: McpStatus };
    assert.equal(mcp.lastRequest?.agentName, LEGACY_NAME);
    assert.equal(mcp.lastRequest?.client, "Claude Code");
  });

  test("turned off, it's refused and stays off; turned back on, it works again", async () => {
    const thisPc = ((await call("GET", "/agents")).body.agents as AgentView[]).find((a) => a.legacy)!;
    assert.equal((await call("DELETE", `/agents/${thisPc.id}`)).status, 204);
    assert.equal((await call("GET", "/apps", undefined, SHARED)).status, 401);
    const off = (await call("GET", "/agents")).body as { agents: AgentView[]; mcp: McpStatus };
    assert.equal(off.mcp.thisPcOff, true);
    assert.deepEqual(off.agents, [], "not made again behind your back");
    assert.equal((await call("POST", "/agents/this-pc")).status, 200);
    assert.equal((await call("GET", "/apps", undefined, SHARED)).status, 200);
    assert.equal(((await call("GET", "/agents")).body as { mcp: McpStatus }).mcp.thisPcOff, false);
  });
});

describe("what it may see and do", () => {
  test("limited to some apps: the others don't exist, in lists or by name; what it can't open is refused", async () => {
    const { token } = await add({ name: "Scoped", access: "ask", apps: [starMap.id] });
    const apps = (await call("GET", "/apps", undefined, token)).body.apps as App[];
    assert.deepEqual(apps.map((a) => a.slug), ["star-map"]);
    assert.equal((await call("GET", "/apps/moon-base", undefined, token)).status, 404);
    assert.equal((await call("GET", "/apps/moon-base/history", undefined, token)).status, 404);
    assert.equal((await call("POST", `/apps/moon-base/actions/${redeploy(moonBase)}`, { confirmed: true }, token)).status, 404);
    const statuses = (await call("GET", "/status", undefined, token)).body.statuses as { slug: string }[];
    assert.deepEqual(statuses.map((s) => s.slug), ["star-map"]);
    const services = (await call("GET", "/services", undefined, token)).body.services as { apps: { slug: string }[] }[];
    assert.deepEqual(services[0]!.apps.map((a) => a.slug), ["star-map"]);
    assert.equal((await call("GET", "/settings", undefined, token)).status, 403);
    assert.equal(deployed, 0);
  });

  test("read only: it can't ask for anything", async () => {
    const { token } = await add({ name: "Reader", access: "read", apps: "all" });
    const r = await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    assert.equal(r.status, 403);
    assert.match(r.body.error!, /can only read/);
    assert.equal(asked.length, 0);
  });

  test("its scope and access change on screen; unknown apps and bad values are refused", async () => {
    const { agent } = await add({ name: "B", access: "ask", apps: "all" });
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { apps: ["nope"] })).status, 400);
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { access: "admin" })).status, 400);
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { apps: [] })).status, 400);
    const changed = (await call("PATCH", `/agents/${agent.id}`, { access: "read", apps: [moonBase.id] })).body.agent as AgentView;
    assert.deepEqual([changed.access, changed.apps], ["read", [moonBase.id]]);
  });
});

describe("a rule per action", () => {
  test("never: refused without asking, and recorded", async () => {
    const { agent, token } = await add({ name: "C", access: "ask", apps: "all" });
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:${redeploy(starMap)}`]: "never" } })).status, 200);
    const r = await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    assert.equal(r.status, 403);
    assert.match(r.body.error!, /a rule in Settings → AI assistants says never/);
    assert.equal(asked.length, 0);
    assert.equal(deployed, 0);
    const [entry] = (await call("GET", "/apps/star-map/activity")).body.activity as { ok: boolean }[];
    assert.equal(entry?.ok, false);
  });

  test("allow: runs without asking; other actions and other apps still ask", async () => {
    const { agent, token } = await add({ name: "D", access: "ask", apps: "all" });
    await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:${redeploy(starMap)}`]: "allow" } });
    answer = "decline";
    assert.equal((await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token)).status, 200);
    assert.equal(deployed, 1);
    assert.equal(asked.length, 0, "no question for an allowed action");
    assert.equal((await call("POST", `/apps/moon-base/actions/${redeploy(moonBase)}`, { confirmed: true }, token)).status, 403, "Moon-Base still asks, and was declined");
    assert.equal(asked.length, 1);
  });

  test("rules must name a real action, and a rule left at ask isn't kept", async () => {
    const { agent } = await add({ name: "E", access: "ask", apps: "all" });
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:nope`]: "allow" } })).status, 400);
    assert.equal((await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:${redeploy(starMap)}`]: "maybe" } })).status, 400);
    const kept = (await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:${redeploy(starMap)}`]: "ask" } })).body.agent as AgentView;
    assert.deepEqual(kept.rules, {});
  });
});

describe("grants: approve, and allow for a while", () => {
  test("approving with allowForMinutes lets that action run unasked until then; ending it asks again", async () => {
    const { agent, token } = await add({ name: "F", access: "ask", apps: "all" });
    answer = "wait";
    const first = call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await call("POST", `/approvals/${asked[0]!.id}`, { approve: true, allowForMinutes: 7 })).status, 400, "only the offered lengths");
    assert.equal((await call("POST", `/approvals/${asked[0]!.id}`, { approve: true, allowForMinutes: 60 })).status, 200);
    assert.equal((await first).status, 200);
    assert.equal(deployed, 1);

    const live = ((await call("GET", "/agents")).body.agents as AgentView[])[0]!.grants;
    assert.equal(live.length, 1);
    assert.ok(Math.abs(Date.parse(live[0]!.until) - Date.now() - 60 * 60_000) < 5_000);
    assert.equal((await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token)).status, 200);
    assert.equal(asked.length, 1, "the second run didn't ask");

    assert.equal((await call("DELETE", `/agents/${agent.id}/grants?appId=${starMap.id}&actionId=${encodeURIComponent(redeploy(starMap))}`)).status, 204);
    answer = "decline";
    assert.equal((await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token)).status, 403);
    assert.equal(asked.length, 2);
  });

  test("a grant runs out by itself, and wins over a rule while it lasts", () => {
    const ctx: AgentCtx = { id: "a", name: "x", legacy: false, apps: "all", access: "ask", rules: { "app:act": "never" }, grants: [{ appId: "app", actionId: "act", until: new Date(Date.now() + 60_000).toISOString() }] };
    assert.deepEqual(decide(ctx, "app", "act"), { rule: "allow", by: "grant" });
    assert.deepEqual(decide(ctx, "app", "act", Date.now() + 120_000), { rule: "never", by: "rule" });
    assert.deepEqual(decide(ctx, "app", "other"), { rule: "ask", by: "default" });
  });

  test("a grant for an assistant that's gone isn't made", () => {
    assert.equal(addGrant(db, "ag_missing", { appId: "a", actionId: "b" }, 60), undefined);
  });
});

describe("cutting off", () => {
  test("revoked: its token stops at once, and what it was waiting on is withdrawn", async () => {
    const { agent, token } = await add({ name: "G", access: "ask", apps: "all" });
    answer = "wait";
    const waiting = call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    assert.equal((await call("DELETE", `/agents/${agent.id}`)).status, 204);
    // Withdrawn at once, not left to run out on the approval's own timer.
    assert.deepEqual(approvals.list(), []);
    assert.equal((await waiting).status, 403);
    assert.equal((await call("GET", "/apps", undefined, token)).status, 401);
    assert.deepEqual(((await call("GET", "/agents")).body.agents as AgentView[]).filter((a) => !a.legacy), []);
    assert.equal(deployed, 0);
  });

  test("the kill switch (access off) shuts every assistant out, and says where to turn it back on", async () => {
    const { token } = await add({ name: "H", access: "ask", apps: "all" });
    answer = "wait";
    const waiting = call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    while (asked.length === 0) await new Promise((r) => setTimeout(r, 5));
    await call("PATCH", "/settings", { agentAccess: false });
    assert.deepEqual(approvals.list(), [], "what it was waiting on is withdrawn too");
    assert.equal((await waiting).status, 403);
    assert.equal(deployed, 0);
    const r = await call("GET", "/apps", undefined, token);
    assert.equal(r.status, 403);
    assert.match(r.body.error!, /switched off.*Settings → AI assistants/);
  });
});

describe("the audit log", () => {
  test("every request, with what came of it: read, refused, approved, declined, allowed by rule", async () => {
    const { agent, token } = await add({ name: "Logged", access: "ask", apps: [starMap.id] });
    await call("GET", "/apps", undefined, token, "cursor");
    await call("GET", "/apps/moon-base", undefined, token);
    await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    answer = "decline";
    await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);
    await call("PATCH", `/agents/${agent.id}`, { rules: { [`${starMap.id}:${redeploy(starMap)}`]: "allow" } });
    await call("POST", `/apps/star-map/actions/${redeploy(starMap)}`, { confirmed: true }, token);

    const entries = (await auditOf()).reverse();
    assert.deepEqual(entries.map((e) => [e.method, e.path.replace(/redeploy:.*/, "…"), e.outcome, e.status]), [
      ["GET", "/api/apps", "read", 200],
      ["GET", "/api/apps/moon-base", "refused", 404],
      ["POST", "/api/apps/star-map/actions/…", "approved", 200],
      ["POST", "/api/apps/star-map/actions/…", "declined", 403],
      ["POST", "/api/apps/star-map/actions/…", "allowed by rule", 200],
    ]);
    assert.equal(entries[0]!.client, "Cursor");
    assert.equal(entries[0]!.agentName, "Logged");
    assert.equal(entries[2]!.appSlug, "star-map");
  });

  test("exported as CSV (formula-looking cells kept as text) or JSON, for one assistant or all", async () => {
    const { agent, token } = await add({ name: "=cmd", access: "read", apps: "all" });
    await call("GET", "/apps", undefined, token);
    const res = await gc.request(`http://localhost:4100/api/agents/audit?format=csv&agent=${agent.id}`, { headers: { "x-periskopos-token": TOKEN } });
    assert.match(res.headers.get("content-disposition") ?? "", /attachment; filename="periskopos-assistants\.csv"/);
    const lines = (await res.text()).trim().split("\n");
    assert.equal(lines[0], "at,assistant,client,method,path,app,outcome,status,detail");
    assert.match(lines[1]!, /,'=cmd,.*,GET,\/api\/apps,,read,200,/);
    assert.equal(auditCsv([{ id: 1, at: "t", agentId: "a", agentName: 'say "hi", ok', method: "GET", path: "/x", outcome: "read", status: 200 }]).split("\n")[1], 't,"say ""hi"", ok",,GET,/x,,read,200,');
  });
});

describe("the MCP server, given its assistant's own token", () => {
  test("PERISKOPOS_AGENT_TOKEN is used, before any token file; a refused one says it was revoked", async () => {
    const seen: string[] = [];
    // The client made from the environment sends with the global fetch, faked here.
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.push(String((init?.headers as Record<string, string>)["x-periskopos-token"]));
      return new Response(JSON.stringify({ error: "no" }), { status: 401 });
    }) as never;
    const client = PeriskoposClient.fromEnv({ PERISKOPOS_AGENT_TOKEN: " gca_mine ", PERISKOPOS_DATA_DIR: "nowhere" });
    await assert.rejects(client.get("/apps"), (err: unknown) => err instanceof PeriskoposError && /PERISKOPOS_AGENT_TOKEN\): it was revoked/.test(err.message));
    assert.deepEqual(seen, ["gca_mine"], "exactly that token, trimmed, and no other tried");
  });
});
