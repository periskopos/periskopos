import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { reader, streamLimits, toLogLine, vercelLogs } from "../server/integrations/logs/vercel.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Vercel's runtime logs, read from the live production deploy's stream.
// Everything here is a fake; nothing reaches the network.

const ago = (min: number) => Date.now() - min * 60_000;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const vlog = (min: number, level: string, message: string, extra: Record<string, unknown> = {}) => ({
  domain: "shop.vercel.app",
  level,
  message,
  messageTruncated: false,
  requestMethod: "GET",
  requestPath: "/api/cart",
  responseStatusCode: 200,
  rowId: `r${Math.random()}`,
  source: "serverless",
  timestampInMs: ago(min),
  ...extra,
});

const realFetch = globalThis.fetch;
type Seen = { method: string; url: URL; accept: string | null };
let seen: Seen[];
let deployments: unknown[];
let logs: unknown[];
let open: boolean; // the stream stays open after its lines, as Vercel's does
let lastNewline: boolean; // the last line ends with a line break
let refuse: number | undefined;

beforeEach(() => {
  clearHttpCache();
  seen = [];
  deployments = [
    { uid: "dpl_new", readyState: "BUILDING", created: ago(1) },
    { uid: "dpl_live", readyState: "READY", created: ago(90), ready: ago(88) },
    { uid: "dpl_old", readyState: "READY", created: ago(900), ready: ago(898) },
  ];
  logs = [];
  open = false;
  lastNewline = true;
  refuse = undefined;
  streamLimits.readMs = 8_000;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    seen.push({ method: init?.method ?? "GET", url, accept: new Headers(init?.headers).get("accept") });
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    if (url.pathname === "/v7/deployments") return json({ deployments });
    if (/^\/v1\/projects\/[^/]+\/deployments\/[^/]+\/runtime-logs$/.test(url.pathname)) {
      if (refuse) return json({ error: { code: "forbidden", message: "Not authorized" } }, refuse);
      const bytes = new TextEncoder().encode(logs.map((l) => JSON.stringify(l)).join("\n") + (lastNewline && logs.length ? "\n" : ""));
      const signal = init?.signal;
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          // Split mid-line, as a network would.
          const cut = Math.floor(bytes.length / 2);
          c.enqueue(bytes.slice(0, cut));
          c.enqueue(bytes.slice(cut));
          if (!open) c.close();
          else signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/stream+json" } });
    }
    return json({ error: { message: "Not found" } }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "vercel", name: "Vercel", canWrite: false }, token: async () => "vc_test" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "vercel-logs", serviceId: "s", resource: "prj_abc123", settings: { name: "shop", scope: "me", teamId: "team_xyz" } };
const since = () => new Date(ago(60)).toISOString();

describe("Vercel logs", () => {
  test("a streamed line: errors and fatals kept, a 5xx request is an error, the rest left out", () => {
    const line = vlog(1, "error", "TypeError: x is undefined");
    assert.deepEqual(toLogLine(line), { at: new Date(line.timestampInMs).toISOString(), level: "error", message: "TypeError: x is undefined", source: "GET /api/cart" });
    assert.equal(toLogLine(vlog(1, "fatal", "out of memory"))!.level, "fatal");
    assert.equal(toLogLine(vlog(1, "info", "hello")), undefined);
    assert.equal(toLogLine(vlog(1, "warning", "slow"))!.level, "warning");
    const crashed = toLogLine(vlog(1, "info", "", { source: "request", responseStatusCode: 504 }))!;
    assert.deepEqual([crashed.level, crashed.message], ["error", "GET /api/cart answered 504"]);
    assert.equal(toLogLine(vlog(1, "info", "", { source: "request", responseStatusCode: 404 })), undefined);
  });

  test("reads the live production deploy's logs, for its team; only errors since `since`", async () => {
    logs = [vlog(90, "error", "too old"), vlog(30, "error", "Boom 1"), vlog(5, "fatal", "Crash"), vlog(4, "info", "fine"), vlog(3, "warning", "slow")];
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message).sort(), ["Boom 1", "Crash"]);
    assert.equal(r.partial, undefined);
    const logsCall = seen.find((s) => s.url.pathname.endsWith("/runtime-logs"))!;
    assert.equal(logsCall.url.pathname, "/v1/projects/prj_abc123/deployments/dpl_live/runtime-logs");
    assert.equal(logsCall.url.searchParams.get("teamId"), "team_xyz");
    assert.equal(logsCall.accept, "application/stream+json");
    const deploysCall = seen.find((s) => s.url.pathname === "/v7/deployments")!;
    assert.equal(deploysCall.url.searchParams.get("target"), "production");
  });

  test("warnings only when there's nothing stronger", async () => {
    logs = [vlog(5, "warning", "slow"), vlog(4, "info", "fine")];
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => [l.level, l.message]), [["warning", "slow"]]);
  });

  test("more errors than the limit: the newest kept, marked partial", async () => {
    logs = Array.from({ length: 30 }, (_, i) => vlog(40 - i, "error", `Boom ${i}`));
    const r = await reader.readErrors(conn, auth, since(), 10);
    assert.equal(r.lines.length, 10);
    assert.equal(r.partial, true);
    assert.ok(r.lines.every((l) => /^Boom 2\d$/.test(l.message)), "the newest ten");
  });

  test("a last line without a line break is still read", async () => {
    lastNewline = false;
    logs = [vlog(3, "error", "Boom 1"), vlog(2, "error", "Boom 2")];
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message).sort(), ["Boom 1", "Boom 2"]);
  });

  test("a stream that stays open is cut at the time limit, keeping what came", async () => {
    streamLimits.readMs = 100;
    open = true;
    logs = [vlog(2, "error", "Boom")];
    const r = await reader.readErrors(conn, auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["Boom"]);
  });

  test("no runtime logs (a static site), or nothing live: no lines", async () => {
    assert.deepEqual(await reader.readErrors(conn, auth, since(), 1000), { lines: [] });
    deployments = [{ uid: "dpl_x", readyState: "ERROR", created: ago(5) }];
    clearHttpCache();
    assert.deepEqual(await reader.readErrors(conn, auth, since(), 1000), { lines: [] });
    assert.ok(!seen.some((s) => s.url.pathname.includes("dpl_x")), "a failed build has no runtime");
  });

  test("a token without the team: says which token it needs", async () => {
    refuse = 403;
    await assert.rejects(reader.readErrors(conn, auth, since(), 1000), /runtime logs \(403\): the token needs access to the project's team/);
    const r = await vercelLogs.check!(conn, auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /scope set to that team/);
  });

  test("check: a burst of errors in the last minutes is a spike, down, with a link to the logs", async () => {
    logs = [...Array.from({ length: 25 }, (_, i) => vlog(1 + (i % 10), "error", `Cannot read properties of undefined #${i}`)), vlog(40, "error", "Old one")];
    const r = await vercelLogs.check!({ ...conn, id: "c-spike" }, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^25 errors in the last 15 minutes/);
    assert.deepEqual(r.link, { url: "https://vercel.com/me/shop/logs?levels=error", label: "Logs in Vercel" });
  });
});
