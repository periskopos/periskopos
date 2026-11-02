import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { reader, renderLogs, toLogLine } from "../server/integrations/logs/render.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Render's logs API: a service's error lines, a page at a time.
// Everything here is a fake; nothing reaches the network.

const ago = (min: number) => Date.now() - min * 60_000;
const iso = (min: number) => new Date(ago(min)).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
let n = 0;
const rlog = (min: number, level: string, message: string) => ({
  id: `log-${n++}`,
  message,
  timestamp: iso(min),
  labels: [
    { name: "resource", value: "srv-abc123" },
    { name: "instance", value: "srv-abc123-7f9c" },
    { name: "level", value: level },
    { name: "type", value: "app" },
  ],
});
type Page = { hasMore: boolean; nextStartTime: string; nextEndTime: string; logs: ReturnType<typeof rlog>[] };

const realFetch = globalThis.fetch;
let seen: URL[];
let pages: (q: URLSearchParams) => Page; // what /logs answers for a query
let refuse: number | undefined;

beforeEach(() => {
  clearHttpCache();
  seen = [];
  refuse = undefined;
  pages = (q) => ({ hasMore: false, nextStartTime: q.get("startTime")!, nextEndTime: q.get("endTime")!, logs: [] });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push(url);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    if (refuse) return json({ id: "x", message: "unauthorized" }, refuse);
    if (url.pathname === "/v1/services/srv-abc123") return json({ id: "srv-abc123", name: "api", ownerId: "tea-owner1", dashboardUrl: "https://dashboard.render.com/web/srv-abc123" });
    if (url.pathname === "/v1/logs") return json(pages(url.searchParams));
    return json({ message: "Not found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "render", name: "Render", canWrite: false }, token: async () => "rnd_test" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "render-logs", serviceId: "s", resource: "srv-abc123", settings: { name: "api", dashboardUrl: "https://dashboard.render.com/web/srv-abc123" } };
const since = () => iso(60);
const logCalls = () => seen.filter((u) => u.pathname === "/v1/logs");

describe("Render logs", () => {
  test("a log entry: its level from its labels, critical and above as fatal, the instance as source", () => {
    const e = rlog(2, "error", "  Error: connect ECONNREFUSED 10.0.0.4:5432 ");
    assert.deepEqual(toLogLine(e), { at: e.timestamp, level: "error", message: "Error: connect ECONNREFUSED 10.0.0.4:5432", source: "srv-abc123-7f9c" });
    assert.equal(toLogLine(rlog(2, "critical", "x"))!.level, "fatal");
    assert.equal(toLogLine(rlog(2, "emergency", "x"))!.level, "fatal");
    assert.equal(toLogLine(rlog(2, "warning", "x"))!.level, "warning");
    assert.equal(toLogLine(rlog(2, "info", "x")), undefined);
  });

  test("asks for the service's error lines, in its workspace, since `since`", async () => {
    pages = (q) => ({ hasMore: false, nextStartTime: q.get("startTime")!, nextEndTime: q.get("endTime")!, logs: [rlog(5, "error", "Boom"), rlog(3, "critical", "Down"), rlog(70, "error", "too old")] });
    const from = since();
    const r = await reader.readErrors(conn, auth, from, 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["Boom", "Down"]);
    assert.equal(r.partial, undefined);
    const q = logCalls()[0]!.searchParams;
    assert.equal(q.get("ownerId"), "tea-owner1");
    assert.deepEqual(q.getAll("resource"), ["srv-abc123"]);
    assert.deepEqual(q.getAll("level"), ["error", "critical", "alert", "emergency"]);
    assert.equal(q.get("startTime"), from);
    assert.equal(q.get("direction"), "backward");
    assert.equal(q.get("limit"), "100");
    assert.ok(Date.parse(q.get("endTime")!) <= Date.now());
  });

  test("follows the pages with nextStartTime and nextEndTime until there are no more", async () => {
    const nextStart = iso(59);
    pages = (q) =>
      q.get("endTime") === "2026-10-29T10:00:00Z"
        ? { hasMore: false, nextStartTime: "x", nextEndTime: "y", logs: [rlog(20, "error", "Page 2")] }
        : { hasMore: true, nextStartTime: nextStart, nextEndTime: "2026-10-29T10:00:00Z", logs: [rlog(2, "error", "Page 1")] };
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["Page 1", "Page 2"]);
    assert.equal(logCalls().length, 2);
    assert.equal(logCalls()[1]!.searchParams.get("startTime"), nextStart);
    assert.equal(logCalls()[1]!.searchParams.get("endTime"), "2026-10-29T10:00:00Z");
  });

  test("a page that points back at itself ends the reading instead of looping", async () => {
    pages = (q) => ({ hasMore: true, nextStartTime: q.get("startTime")!, nextEndTime: q.get("endTime")!, logs: [rlog(2, "error", "Same page")] });
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["Same page"]);
    assert.equal(logCalls().length, 1);
  });

  test("stops at the limit, marked partial", async () => {
    let page = 0;
    pages = (q) => ({ hasMore: true, nextStartTime: q.get("startTime")!, nextEndTime: `2026-10-29T10:0${page}:00Z`, logs: Array.from({ length: 100 }, (_, i) => rlog(1 + (page++ % 50) + i / 1000, "error", `Boom ${i}`)) });
    const r = await reader.readErrors(conn, auth, since(), 150);
    assert.equal(r.lines.length, 150);
    assert.equal(r.partial, true);
    assert.equal(logCalls().length, 2);

    // exactly a page's worth at the limit: no need to ask for the next page
    clearHttpCache();
    seen = [];
    page = 0;
    const full = await reader.readErrors(conn, auth, since(), 100);
    assert.equal(full.lines.length, 100);
    assert.equal(full.partial, true);
    assert.equal(logCalls().length, 1);
  });

  test("no errors: warnings if there are any, else nothing", async () => {
    pages = (q) => ({ hasMore: false, nextStartTime: "x", nextEndTime: "y", logs: q.getAll("level").includes("warning") ? [rlog(4, "warning", "Slow query")] : [] });
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => [l.level, l.message]), [["warning", "Slow query"]]);

    clearHttpCache();
    pages = () => ({ hasMore: false, nextStartTime: "x", nextEndTime: "y", logs: [] });
    assert.deepEqual(await reader.readErrors(conn, auth, since(), 1000), { lines: [] });
  });

  test("a refused key: says which key it needs", async () => {
    refuse = 401;
    await assert.rejects(reader.readErrors(conn, auth, since(), 1000), /Render refused to read this service's logs \(401\): use an API key of a workspace member/);
    const r = await renderLogs.check!(conn, auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /workspace member who can see the service/);
  });

  test("check: a burst of errors is a spike, down, with a link to the service's logs", async () => {
    pages = () => ({ hasMore: false, nextStartTime: "x", nextEndTime: "y", logs: [...Array.from({ length: 30 }, (_, i) => rlog(1 + (i % 12), "error", `Error: connect ECONNREFUSED 10.0.0.${i}:5432`)), rlog(45, "error", "earlier")] });
    const r = await renderLogs.check!({ ...conn, id: "c-spike" }, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^30 errors in the last 15 minutes.*ECONNREFUSED/);
    assert.deepEqual(r.link, { url: "https://dashboard.render.com/web/srv-abc123/logs", label: "Logs in Render" });
  });
});
