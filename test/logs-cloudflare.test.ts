import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { cloudflareLogs, onlyAssets, queryBody, reader, toLogLine } from "../server/integrations/logs/cloudflare.ts";
import type { CfEvent } from "../server/integrations/logs/cloudflare.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Workers Logs through the telemetry query API. Everything here is a fake;
// nothing reaches the network.

const ACCOUNT = "a".repeat(32);
const CF = `/client/v4/accounts/${ACCOUNT}`;
const MIN = 60_000;
const ago = (min: number) => Date.now() - min * MIN;

type Fake = { events: CfEvent[] | 403; count?: number; settings: unknown; scripts?: unknown[]; bodies: Record<string, unknown>[]; calls: string[] };
let fake: Fake;
const realFetch = globalThis.fetch;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ success: true, result, errors: [] });

beforeEach(() => {
  clearHttpCache();
  fake = { events: [], settings: { observability: { enabled: true, logs: { enabled: true, invocation_logs: true } } }, bodies: [], calls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    fake.calls.push(`${method} ${url.pathname}`);
    if (method === "POST") {
      // The only POST: the telemetry query, a read.
      assert.equal(url.pathname, `${CF}/workers/observability/telemetry/query`);
      fake.bodies.push(JSON.parse(String(init?.body)));
      if (fake.events === 403) return json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);
      return ok({ events: { events: fake.events, count: fake.count ?? fake.events.length } });
    }
    if (url.pathname === "/client/v4/accounts") return ok([{ id: ACCOUNT, name: "acme.com" }]);
    if (url.pathname === `${CF}/pages/projects`) return ok([{ name: "site", subdomain: "site.pages.dev" }]);
    if (url.pathname === `${CF}/workers/scripts`) return ok(fake.scripts ?? [{ id: "star-map" }]);
    if (url.pathname === `${CF}/workers/domains`) return ok([]);
    if (url.pathname === `${CF}/workers/scripts/star-map/script-settings`) return ok(fake.settings);
    return json({ success: false, errors: [{ message: "not found" }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "cloudflare", name: "CF", canWrite: false }, token: async () => "cf_test" } as ServiceAuth;
const conn = (id = "c"): Connection => ({ id, appId: "a", type: "cloudflare-logs", serviceId: "s", resource: "star-map", settings: { kind: "worker", accountId: ACCOUNT, name: "star-map" } });
const exception = (minAgo: number, error = "TypeError: Cannot read properties of undefined (reading 'id')"): CfEvent => ({
  timestamp: ago(minAgo),
  $metadata: { error, level: "error", trigger: "GET /api/stars" },
  $workers: { outcome: "exception", eventType: "fetch", scriptName: "star-map" },
});

describe("Cloudflare Worker logs", () => {
  test("the query asks for this Worker's failed events in the window, without saving it", async () => {
    await reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000);
    const body = fake.bodies[0]!;
    assert.equal(body.view, "events");
    assert.equal(body.dry, true);
    assert.equal(body.limit, 1001);
    const tf = body.timeframe as { from: number; to: number };
    assert.ok(Math.abs(tf.from - ago(60)) < 5000 && tf.to >= tf.from);
    assert.deepEqual(body, queryBody("star-map", tf.from, tf.to, 1001));
    // Spelled out, not only compared with queryBody: this Worker AND a failure.
    const params = body.parameters as { filterCombination: string; filters: { key?: string; value?: unknown; filterCombination?: string; filters?: { key: string; value?: string }[] }[] };
    assert.equal(params.filterCombination, "and");
    assert.equal(params.filters.length, 2);
    assert.deepEqual(params.filters[0], { key: "$workers.scriptName", operation: "eq", type: "string", value: "star-map" });
    const failed = params.filters[1]!;
    assert.equal(failed.filterCombination, "or");
    assert.deepEqual(failed.filters!.map((f) => f.key), ["$workers.outcome", "$metadata.level", "$metadata.error"]);
    assert.ok(failed.filters![0]!.value!.split(",").includes("exception") && failed.filters![0]!.value!.split(",").includes("exceededCpu"));
    assert.ok(!failed.filters![0]!.value!.split(",").includes("ok"), "a successful invocation isn't a failure");
    assert.equal(failed.filters![1]!.value, "error,fatal");
  });

  test("events become log lines: the error, its kind of event, fatal when out of CPU", () => {
    const e = exception(1);
    assert.deepEqual(toLogLine(e), { at: new Date(e.timestamp!).toISOString(), level: "error", message: "TypeError: Cannot read properties of undefined (reading 'id')", source: "fetch" });
    const cpu = toLogLine({ timestamp: ago(2), $metadata: { trigger: "GET /heavy" }, $workers: { outcome: "exceededCpu", eventType: "fetch" } });
    assert.equal(cpu?.level, "fatal");
    assert.equal(cpu?.message, "Invocation ended: exceededCpu (GET /heavy)");
    assert.equal(toLogLine({ timestamp: ago(1), $metadata: { level: "error", message: "db timeout" } })?.message, "db timeout");
    assert.equal(toLogLine({ $metadata: { error: "x" } }), undefined, "no time, no line");
  });

  test("lines before `since` are dropped; more than the limit is partial", async () => {
    fake.events = [exception(1), exception(2), exception(3), exception(90)];
    const r = await reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 2);
    assert.equal(r.lines.length, 2);
    assert.equal(r.partial, true);
    clearHttpCache();
    fake.events = [exception(1), exception(90)];
    const r2 = await reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 10);
    assert.equal(r2.lines.length, 1);
    assert.equal(r2.partial, undefined);
  });

  test("Cloudflare counting more events than it returned is partial", async () => {
    fake.events = [exception(1)];
    fake.count = 5000;
    assert.equal((await reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000)).partial, true);
  });

  test("no events with Workers Logs on: no errors", async () => {
    const r = await reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000);
    assert.deepEqual(r, { lines: [] });
  });

  test("no events with Workers Logs off: says how to turn them on", async () => {
    fake.settings = { observability: { enabled: false } };
    await assert.rejects(reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000), /Workers Logs are off.*observability\] enabled = true/s);
    clearHttpCache();
    fake.settings = {}; // never set up
    await assert.rejects(reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000), /Workers Logs are off/);
  });

  test("a token without Workers Observability is told what to add", async () => {
    fake.events = 403;
    await assert.rejects(reader.readErrors(conn(), auth, new Date(ago(60)).toISOString(), 1000), /Workers Observability → Edit/);
  });

  test("only Workers are offered, and only Workers are accepted", async () => {
    const list = await cloudflareLogs.listResources!(auth);
    assert.deepEqual(list.map((r) => r.id), ["worker:star-map"]);
    assert.deepEqual(cloudflareLogs.parse({ resource: "worker:star-map", settings: { kind: "worker", accountId: ACCOUNT } }), {
      resource: "star-map",
      settings: { kind: "worker", accountId: ACCOUNT, name: "star-map" },
    });
    assert.throws(() => cloudflareLogs.parse({ resource: "site", settings: { kind: "pages", accountId: ACCOUNT } }), /Workers/);
    assert.ok(fake.calls.every((c) => c.startsWith("GET ")), "listing only reads");
  });

  test("a Worker that only serves static files isn't offered: no code runs, so no errors to read", async () => {
    // As Cloudflare lists them: an assets-only Worker still has a "fetch" handler.
    assert.equal(onlyAssets({ id: "x", has_assets: true, has_modules: false }), true);
    assert.equal(onlyAssets({ id: "x", has_assets: true, has_modules: true }), false);
    assert.equal(onlyAssets({ id: "x", has_assets: false, has_modules: false }), false);
    assert.equal(onlyAssets({ id: "x" }), false, "unknown: offered");
    fake.scripts = [{ id: "star-map", has_assets: true, has_modules: false, handlers: ["fetch"] }];
    await assert.rejects(cloudflareLogs.listResources!(auth), /only serve static files/);
    clearHttpCache();
    fake.scripts = [{ id: "star-map", has_assets: true, has_modules: true, handlers: ["fetch"] }];
    assert.deepEqual((await cloudflareLogs.listResources!(auth)).map((r) => r.id), ["worker:star-map"]);
  });

  test("a Pages project's connection isn't read", async () => {
    await assert.rejects(reader.readErrors({ ...conn(), settings: { kind: "pages", accountId: ACCOUNT } }, auth, new Date(ago(60)).toISOString(), 10), /Workers only/);
  });

  test("check: a spike in the last 15 minutes is down, with a link to the logs", async () => {
    fake.events = Array.from({ length: 30 }, (_, i) => exception(i % 10));
    const r = await cloudflareLogs.check!(conn("spike"), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /30 errors in the last 15 minutes/);
    assert.equal(r.link?.url, `https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/star-map/production/observability/logs`);
  });
});
