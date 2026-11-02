import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { railwayLogs, reader, toLogLine } from "../server/integrations/logs/railway.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Railway's runtime logs, through its GraphQL API: queries only, never a
// mutation. Everything here is a fake; nothing reaches the network.

const ago = (min: number) => Date.now() - min * 60_000;
const iso = (min: number) => new Date(ago(min)).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const S = "11111111-1111-1111-1111-111111111111";
const P = "22222222-2222-2222-2222-222222222222";
const E = "33333333-3333-3333-3333-333333333333";
const rd = (id: string, status: string, min: number) => ({ id, status, createdAt: iso(min), meta: null });
const rl = (min: number, severity: string, message: string) => ({ timestamp: iso(min), message, severity });

const realFetch = globalThis.fetch;
type Asked = { query: string; variables: Record<string, unknown> };
let asked: Asked[];
let deployments: ReturnType<typeof rd>[];
let logsOf: (deploymentId: string, filter: string, limit: number) => ReturnType<typeof rl>[];
let notAuthorized: boolean;

beforeEach(() => {
  clearHttpCache();
  asked = [];
  notAuthorized = false;
  deployments = [rd("dep-build", "BUILDING", 1), rd("dep-live", "SUCCESS", 30), rd("dep-old", "REMOVED", 300)];
  logsOf = () => [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(url.href, "https://backboard.railway.com/graphql/v2");
    assert.equal(init?.method, "POST");
    const body = JSON.parse(String(init!.body)) as Asked;
    assert.match(body.query, /^query\b/, "a query, never a mutation");
    asked.push(body);
    if (notAuthorized) return json({ data: null, errors: [{ message: "Not Authorized" }] });
    if (body.query.includes("deployments(")) return json({ data: { deployments: { edges: deployments.map((node) => ({ node })) } } });
    if (body.query.includes("deploymentLogs(")) {
      const filter = body.query.match(/filter: ("[^"]*")/)![1]!;
      return json({ data: { deploymentLogs: logsOf(String(body.variables.deploymentId), JSON.parse(filter), Number(body.variables.limit)) } });
    }
    return json({ errors: [{ message: "unknown query" }] });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "railway", name: "Railway", canWrite: false }, token: async () => "rw_test" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "railway-logs", serviceId: "s", resource: S, settings: { projectId: P, environmentId: E, name: "api" } };
const since = () => iso(60);
const logQueries = () => asked.filter((a) => a.query.includes("deploymentLogs("));

describe("Railway logs", () => {
  test("a log line: severity mapped to a level, info left out", () => {
    const l = rl(2, "error", " Error: ECONNRESET ");
    assert.deepEqual(toLogLine(l), { at: l.timestamp, level: "error", message: "Error: ECONNRESET" });
    assert.equal(toLogLine(rl(2, "warn", "x"))!.level, "warning");
    assert.equal(toLogLine(rl(2, "info", "x")), undefined);
    assert.equal(toLogLine({ timestamp: iso(1), message: "x", severity: null }), undefined);
  });

  test("reads the live deploy's error lines since `since`, in the connected service and environment", async () => {
    const from = since();
    logsOf = (id, filter) => (id === "dep-live" && filter === "@level:error" ? [rl(5, "error", "Boom"), rl(70, "error", "too old"), rl(3, "info", "odd")] : []);
    const r = await reader.readErrors(conn, auth, from, 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["Boom"]);
    assert.equal(r.lines[0]!.source, undefined, "one deploy read: no need to say which");
    assert.equal(r.partial, undefined);
    assert.deepEqual(asked[0]!.variables.input, { projectId: P, serviceId: S, environmentId: E });
    const q = logQueries()[0]!;
    assert.equal(q.variables.deploymentId, "dep-live");
    assert.equal(q.variables.limit, 1001, "one more than the limit, to know there were more");
    assert.ok(q.query.includes(`startDate: "${from}"`));
    assert.match(q.query, /endDate: "\d{4}-/);
    assert.match(q.query, /\{ timestamp message severity \}/);
  });

  test("a newer deploy that crashed is read too, each line saying which deploy", async () => {
    deployments = [rd("dep-crash", "CRASHED", 5), rd("dep-live", "SUCCESS", 30)];
    logsOf = (id, filter) => (filter !== "@level:error" ? [] : id === "dep-crash" ? [rl(4, "error", "Crash on boot")] : [rl(20, "error", "Old boom")]);
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => [l.message, l.source]), [["Crash on boot", "deploy dep-cras"], ["Old boom", "deploy dep-live"]]);
  });

  test("at most three deploys are read: the newest crashed ones, then the live one", async () => {
    deployments = [rd("dep-c1", "CRASHED", 2), rd("dep-c2", "FAILED", 4), rd("dep-c3", "CRASHED", 6), rd("dep-live", "SUCCESS", 30)];
    logsOf = (id, filter) => (filter === "@level:error" ? [rl(1, "error", `from ${id}`)] : []);
    await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(logQueries().map((q) => q.variables.deploymentId), ["dep-c1", "dep-c2", "dep-c3"]);
  });

  test("more than the limit: the newest kept, marked partial", async () => {
    logsOf = (_id, filter, limit) => (filter === "@level:error" ? Array.from({ length: limit }, (_, i) => rl(1 + i / 100, "error", `Boom ${i}`)) : []);
    const r = await reader.readErrors(conn, auth, since(), 50);
    assert.equal(r.lines.length, 50);
    assert.equal(r.partial, true);
    // Boom 0 is the newest, Boom 50 (the one over the limit) the oldest
    assert.ok(r.lines.some((l) => l.message === "Boom 0"));
    assert.ok(!r.lines.some((l) => l.message === "Boom 50"));
  });

  test("a deploy that has more lines than asked is partial, even when the lines kept fit", async () => {
    // The API gave limit + 1 lines, but the extra one is older than `since`.
    logsOf = (_id, filter, limit) => (filter === "@level:error" ? [...Array.from({ length: limit - 1 }, (_, i) => rl(1 + i / 100, "error", `Boom ${i}`)), rl(90, "error", "too old")] : []);
    const r = await reader.readErrors(conn, auth, since(), 10);
    assert.equal(r.lines.length, 10);
    assert.equal(r.partial, true);
  });

  test("no errors: warnings if any; no deploy at all: nothing asked", async () => {
    logsOf = (_id, filter) => (filter === "@level:warn" ? [rl(3, "warn", "Deprecated")] : []);
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => [l.level, l.message]), [["warning", "Deprecated"]]);

    clearHttpCache();
    asked = [];
    deployments = [rd("dep-build", "BUILDING", 1)];
    assert.deepEqual(await reader.readErrors(conn, auth, since(), 1000), { lines: [] });
    assert.equal(logQueries().length, 0);
  });

  test("a token that can't read the project: says which token it needs", async () => {
    notAuthorized = true;
    await assert.rejects(reader.readErrors(conn, auth, since(), 1000), /Railway refused to read this service's logs: use an account token, or a workspace token/);
    const r = await railwayLogs.check!(conn, auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /workspace token for the workspace the project is in/);
  });

  test("check: a burst of errors is a spike, down, with a link to the service", async () => {
    logsOf = (_id, filter) => (filter === "@level:error" ? [...Array.from({ length: 22 }, (_, i) => rl(1 + (i % 10), "error", `Unhandled rejection: timeout after ${i}ms`)), rl(50, "error", "earlier")] : []);
    const r = await railwayLogs.check!({ ...conn, id: "c-spike" }, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^22 errors in the last 15 minutes/);
    assert.deepEqual(r.link, { url: `https://railway.com/project/${P}/service/${S}?environmentId=${E}`, label: "Logs in Railway" });
  });
});
