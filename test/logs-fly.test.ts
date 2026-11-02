import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { flyLogs, reader, toLogLine } from "../server/integrations/logs/fly.ts";
import type { FlyEntry } from "../server/integrations/logs/fly.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Fly.io logs through the endpoint `fly logs` uses: pages forward from a
// nanosecond time. Everything here is a fake; nothing reaches the network.

const MIN = 60_000;
const PAGE = 3; // a small page, to see the paging

type Fake = { entries: FlyEntry[]; status: number; calls: { token: string; auth: string | null }[] };
let fake: Fake;
const realFetch = globalThis.fetch;

beforeEach(() => {
  clearHttpCache();
  fake = { entries: [], status: 200, calls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(init?.method ?? "GET", "GET", "reads only");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.host !== "api.fly.io" || url.pathname !== "/api/v1/apps/shop/logs") return json({ error: "Not Found" }, 404);
    const token = url.searchParams.get("next_token") ?? "";
    fake.calls.push({ token, auth: new Headers(init?.headers).get("authorization") });
    if (fake.status !== 200) return json({ errors: [{ title: "unauthorized" }] }, fake.status);
    // The entries after the token's time, oldest first, a page at a time.
    const after = Number(BigInt(token) / 1_000_000n);
    const page = fake.entries.filter((e) => Date.parse(e.timestamp!) > after).sort((a, b) => a.timestamp!.localeCompare(b.timestamp!)).slice(0, PAGE);
    const last = page.at(-1);
    return json({ data: page.map((e, i) => ({ id: String(i), type: "logs", attributes: e })), meta: { next_token: last ? `${BigInt(Date.parse(last.timestamp!)) * 1_000_000n}` : token } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "fly", name: "Fly", canWrite: false }, token: async () => "FlyV1 fm2_test" } as ServiceAuth;
const conn = (id = "c"): Connection => ({ id, appId: "a", type: "fly-logs", serviceId: "s", resource: "shop", settings: { name: "shop" } });
const since = () => new Date(Date.now() - 60 * MIN).toISOString();
let n = 0;
const entry = (minAgo: number, message: string, level = "info", extra: Partial<FlyEntry> = {}): FlyEntry => ({
  // A few ms apart, so no two entries share a time.
  timestamp: new Date(Date.now() - minAgo * MIN - n++).toISOString(),
  message,
  level,
  instance: "148e272b",
  region: "fra",
  meta: { instance: "148e272b", region: "fra" },
  ...extra,
});

describe("Fly.io logs", () => {
  test("entries become log lines: Fly's own level, a 5xx answer, or text that reads as an error", () => {
    const e = entry(1, "could not find a good candidate", "error");
    assert.deepEqual(toLogLine(e), {
      at: e.timestamp,
      level: "error",
      message: "could not find a good candidate",
      source: "148e272b",
    });
    assert.equal(toLogLine(entry(1, "TypeError: boom"))?.level, "error");
    assert.equal(toLogLine(entry(1, "panic: nil map"))?.level, "fatal");
    assert.equal(toLogLine(entry(1, "request done", "info", { meta: { http: { response: { status_code: 502 } } } }))?.level, "error");
    assert.equal(toLogLine(entry(1, "GET / 200 3ms")), undefined);
  });

  test("reads forward from `since`, page by page, the last quarter-hour first, with the token as it is", async () => {
    fake.entries = [entry(50, "ERROR a"), entry(40, "fine"), entry(30, "ERROR b"), entry(20, "ERROR c"), entry(10, "ERROR d"), entry(5, "fine"), entry(1, "ERROR e"), entry(90, "ERROR too old")];
    const r = await reader.readErrors(conn(), auth, since(), 1000);
    assert.deepEqual(r.lines.map((l) => l.message), ["ERROR e", "ERROR d", "ERROR c", "ERROR b", "ERROR a"]);
    assert.equal(r.partial, undefined);
    assert.equal(fake.calls[0]!.auth, "FlyV1 fm2_test");
    const first = Number(BigInt(fake.calls[0]!.token) / 1_000_000n);
    assert.ok(Math.abs(first - (Date.now() - 15 * MIN)) < 5000, "the recent stretch is read first");
  });

  test("more than the limit is partial", async () => {
    fake.entries = [1, 2, 3, 4].map((m) => entry(m, `ERROR ${m}`));
    const r = await reader.readErrors(conn(), auth, since(), 2);
    assert.equal(r.partial, true);
    assert.deepEqual(r.lines.map((l) => l.message), ["ERROR 1", "ERROR 2"]);
  });

  test("an hour too busy to page through is partial", async () => {
    fake.entries = Array.from({ length: 3 * 26 }, (_, i) => entry(14 - i * 0.1, "fine"));
    assert.equal((await reader.readErrors(conn(), auth, since(), 1000)).partial, true);
  });

  test("quiet: no lines", async () => {
    assert.deepEqual(await reader.readErrors(conn(), auth, since(), 1000), { lines: [] });
  });

  test("a token that can't read the app is told what to use", async () => {
    fake.status = 401;
    await assert.rejects(reader.readErrors(conn(), auth, since(), 1000), /fly tokens create readonly/);
  });

  test("check: a spike in the last 15 minutes is down", async () => {
    fake.entries = Array.from({ length: 22 }, (_, i) => entry(i % 10, "Error: upstream timed out"));
    const r = await flyLogs.check!(conn("spike"), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /22 errors in the last 15 minutes/);
    assert.equal(r.link?.url, "https://fly.io/apps/shop/monitoring");
  });
});
