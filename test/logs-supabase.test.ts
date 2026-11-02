import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { parseTime, reader, supabaseLogs, toLogLine } from "../server/integrations/logs/supabase.ts";
import type { SbRow } from "../server/integrations/logs/supabase.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Supabase logs through the Management API's logs endpoint. Everything here
// is a fake; nothing reaches the network.

const REF = "abcdefghijklmnopqrst";
const MIN = 60_000;
// The endpoint's own format: UTC, no offset, microseconds.
const ts = (minAgo: number) => new Date(Date.now() - minAgo * MIN).toISOString().replace("Z", "000");

type Fake = { rows: SbRow[]; status: number; error?: unknown; urls: URL[] };
let fake: Fake;
const realFetch = globalThis.fetch;

beforeEach(() => {
  clearHttpCache();
  fake = { rows: [], status: 200, urls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(init?.method ?? "GET", "GET", "reads only");
    fake.urls.push(url);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === `/v1/projects/${REF}/analytics/endpoints/logs`) {
      if (fake.status !== 200) return json({ message: "Forbidden" }, fake.status);
      return json(fake.error ? { result: null, error: fake.error } : { result: fake.rows, error: null });
    }
    return json({ message: "not found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "supabase", name: "SB", canWrite: false }, token: async () => "sbp_test" } as ServiceAuth;
const conn = (id = "c"): Connection => ({ id, appId: "a", type: "supabase-logs", serviceId: "s", resource: REF, settings: { name: "shop" } });
const since = () => new Date(Date.now() - 60 * MIN).toISOString();
const pg = (minAgo: number, severity = "ERROR", msg = 'relation "orders" does not exist'): SbRow => ({ timestamp: ts(minAgo), source: "postgres_logs", event_message: msg, pg_severity: severity, level: "", status_code: "" });

describe("Supabase logs", () => {
  test("the query: the logs endpoint, the window, every error source", async () => {
    await reader.readErrors(conn(), auth, since(), 1000);
    const url = fake.urls[0]!;
    assert.equal(url.host, "api.supabase.com");
    assert.ok(Math.abs(Date.parse(url.searchParams.get("iso_timestamp_start")!) - (Date.now() - 60 * MIN)) < 5000);
    assert.ok(url.searchParams.get("iso_timestamp_end"));
    const sql = url.searchParams.get("sql")!;
    for (const s of ["from logs", "postgres_logs", "function_logs", "auth_logs", "edge_logs", "function_edge_logs", "parsed.error_severity", "response.status_code", "limit 1000"]) assert.ok(sql.includes(s), s);
    assert.ok(!/select \*/i.test(sql), "the endpoint refuses select *");
  });

  test("rows become log lines, named by the log they came from", () => {
    const row = pg(1); // one clock reading for both sides
    assert.deepEqual(toLogLine(row), { at: parseTime(row.timestamp), level: "error", message: 'relation "orders" does not exist', source: "postgres" });
    assert.equal(toLogLine(pg(1, "FATAL", "password authentication failed"))?.level, "fatal");
    const two = ts(2);
    assert.deepEqual(toLogLine({ timestamp: two, source: "edge_logs", event_message: "GET | 503 | …", status_code: "503", method: "GET", path: "/rest/v1/orders" }), {
      at: parseTime(two),
      level: "error",
      message: "503 GET /rest/v1/orders",
      source: "api",
    });
    assert.equal(toLogLine({ timestamp: ts(3), source: "function_logs", event_message: "Error: boom", level: "error", function_id: "f1" })?.source, "functions");
    assert.equal(toLogLine({ timestamp: ts(3), source: "auth_logs", event_message: "invalid JWT", level: "error" })?.source, "auth");
    assert.equal(toLogLine({ timestamp: ts(3), source: "storage_logs", event_message: "x" }), undefined);
  });

  test("times: the endpoint's ISO without offset, a space, or microseconds since 1970", () => {
    assert.equal(parseTime("2026-08-22T00:13:07.123456"), "2026-08-22T00:13:07.123Z");
    assert.equal(parseTime("2026-08-22 00:13:07"), "2026-08-22T00:13:07.000Z");
    assert.equal(parseTime(1787357587123456), "2026-08-22T00:13:07.123Z");
    assert.equal(parseTime("soon"), undefined);
  });

  test("lines before `since` are dropped; a full page is partial", async () => {
    fake.rows = [pg(1), pg(2), pg(3), pg(70)];
    const r = await reader.readErrors(conn(), auth, since(), 2);
    assert.equal(r.lines.length, 2);
    assert.equal(r.partial, true);
    assert.ok(fake.urls[0]!.searchParams.get("sql")!.includes("limit 3"));
    // A full page is partial even when old rows leave fewer lines than the limit.
    clearHttpCache();
    fake.rows = [pg(1), pg(70), pg(75)];
    const full = await reader.readErrors(conn(), auth, since(), 2);
    assert.deepEqual([full.lines.length, full.partial], [1, true]);
    clearHttpCache();
    const recent = pg(1);
    fake.rows = [recent, pg(70)];
    assert.deepEqual(await reader.readErrors(conn(), auth, since(), 10), { lines: [toLogLine(recent)!] });
  });

  test("no errors: no lines", async () => {
    assert.deepEqual(await reader.readErrors(conn(), auth, since(), 1000), { lines: [] });
  });

  test("a query error, answered with HTTP 200, is a failure", async () => {
    fake.error = "Backend error! Retry your query.";
    await assert.rejects(reader.readErrors(conn(), auth, since(), 1000), /Supabase couldn't read the logs: Backend error/);
  });

  test("a token that can't read logs is told what it needs", async () => {
    fake.status = 403;
    await assert.rejects(reader.readErrors(conn(), auth, since(), 1000), /analytics_logs_read/);
  });

  test("check: a spike in the last 15 minutes is down", async () => {
    fake.rows = Array.from({ length: 25 }, (_, i) => pg(i % 12));
    const r = await supabaseLogs.check!(conn("spike"), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /25 errors in the last 15 minutes/);
    assert.equal(r.link?.url, `https://supabase.com/dashboard/project/${REF}/logs/explorer`);
  });
});
