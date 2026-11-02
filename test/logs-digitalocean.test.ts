import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { digitaloceanLogs, errorLines, looksLikeError, reader } from "../server/integrations/logs/digitalocean.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// App Platform runtime logs: links from the API, plain text behind them.
// Everything here is a fake; nothing reaches the network.

const APP_ID = "4f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf";
const MIN = 60_000;
const ts = (minAgo: number) => new Date(Date.now() - minAgo * MIN).toISOString().replace("Z", "123456Z");
const LOG_URL = "https://proxy-nyc1.ondigitalocean.app/logs/abc?signature=xyz";

type Fake = { links: unknown; status: number; text: string; calls: { url: string; auth: string | null }[] };
let fake: Fake;
const realFetch = globalThis.fetch;

beforeEach(() => {
  clearHttpCache();
  fake = { links: { live_url: LOG_URL, historic_urls: [] }, status: 200, text: "", calls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    assert.equal(init?.method ?? "GET", "GET", "reads only");
    fake.calls.push({ url: url.toString(), auth: new Headers(init?.headers).get("authorization") });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.host === "api.digitalocean.com" && url.pathname === `/v2/apps/${APP_ID}/logs`) {
      return fake.status === 200 ? json(fake.links) : json({ id: "forbidden", message: "You are not authorized to perform this operation" }, fake.status);
    }
    if (url.toString() === LOG_URL) return new Response(fake.text, { status: 200 });
    return json({ id: "not_found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "digitalocean", name: "DO", canWrite: false }, token: async () => "dop_v1_test" } as ServiceAuth;
const conn = (id = "c"): Connection => ({ id, appId: "a", type: "digitalocean-logs", serviceId: "s", resource: APP_ID, settings: { name: "shop" } });
const since = () => new Date(Date.now() - 60 * MIN).toISOString();

describe("DigitalOcean: which lines are errors", () => {
  test("level markers, exceptions, panics, tracebacks and 5xx answers", () => {
    const cases: [string, string | undefined][] = [
      ["ERROR connecting to database", "error"],
      ['{"level":"error","msg":"db down"}', "error"],
      ['{"level":50,"msg":"db down"}', "error"],
      ['{"level":60,"msg":"out of memory"}', "fatal"],
      ["level=error msg=timeout", "error"],
      ["TypeError: Cannot read properties of undefined (reading 'id')", "error"],
      ["java.lang.NullPointerException: null", "error"],
      ["Traceback (most recent call last):", "error"],
      ["Unhandled promise rejection", "error"],
      ["panic: runtime error: index out of range", "fatal"],
      ["FATAL: could not start server", "fatal"],
      ['10.0.0.1 - - "GET /api HTTP/1.1" 502 12', "error"],
      ["GET /checkout 500 31.2 ms", "error"],
      ["request finished status=503", "error"],
      ["GET /checkout 200 12 ms", undefined],
      ["Compiled with 0 errors", undefined],
      ["Unhandled rejections: 0 errors", undefined],
      ["Server listening on :8080", undefined],
      ["errorHandler registered", undefined],
      ["    at Object.<anonymous> (/app/index.js:3:9)", undefined],
    ];
    for (const [line, level] of cases) assert.equal(looksLikeError(line), level, line);
  });

  test("lines: component, time, message; older or untimed lines dropped", () => {
    const t1 = ts(1);
    const text = [
      `web ${t1} TypeError: boom`,
      "    at handler (/app/index.js:3:9)",
      `web ${ts(2)} GET / 200 3 ms`,
      `worker ${ts(3)} ERROR job failed`,
      `${ts(4)} panic: nil map`,
      `web ${ts(90)} TypeError: old`,
    ].join("\n");
    const lines = errorLines(text, since());
    assert.deepEqual(
      lines.map((l) => [l.source, l.level, l.message]),
      [
        ["web", "error", "TypeError: boom"],
        ["worker", "error", "ERROR job failed"],
        [undefined, "fatal", "panic: nil map"],
      ],
    );
    assert.equal(lines[0]!.at, new Date(Date.parse(t1.replace("123456Z", "123Z"))).toISOString());
  });
});

describe("DigitalOcean logs", () => {
  test("asks for the active deployment's runtime logs, then fetches the link without the token", async () => {
    fake.text = `web ${ts(1)} ERROR one\nweb ${ts(2)} fine`;
    const r = await reader.readErrors(conn(), auth, since(), 1000);
    assert.equal(r.lines.length, 1);
    const [api, file] = fake.calls;
    const q = new URL(api!.url).searchParams;
    assert.equal(q.get("type"), "RUN");
    assert.equal(q.get("follow"), "false");
    assert.equal(api!.auth, "Bearer dop_v1_test");
    assert.equal(file!.url, LOG_URL);
    assert.equal(file!.auth, null, "the token never goes to the log host");
  });

  test("historic_urls when there's no https live_url", async () => {
    fake.links = { live_url: "wss://proxy/logs/live", historic_urls: [LOG_URL] };
    fake.text = `web ${ts(1)} ERROR one`;
    assert.equal((await reader.readErrors(conn(), auth, since(), 1000)).lines.length, 1);
  });

  test("no links (nothing running): no lines", async () => {
    fake.links = {};
    assert.deepEqual(await reader.readErrors(conn(), auth, since(), 1000), { lines: [] });
  });

  test("more than the limit: the newest, partial", async () => {
    fake.text = [1, 2, 3, 4].map((m) => `web ${ts(m)} ERROR number ${m}`).join("\n");
    const r = await reader.readErrors(conn(), auth, since(), 2);
    assert.equal(r.partial, true);
    assert.deepEqual(r.lines.map((l) => l.message), ["ERROR number 1", "ERROR number 2"]);
  });

  test("a token without app: read is told so", async () => {
    fake.status = 403;
    await assert.rejects(reader.readErrors(conn(), auth, since(), 1000), /app: read/);
  });

  test("check: a spike in the last 15 minutes is down", async () => {
    fake.text = Array.from({ length: 24 }, (_, i) => `web ${ts(i % 10)} TypeError: x is not a function`).join("\n");
    const r = await digitaloceanLogs.check!(conn("spike"), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /24 errors in the last 15 minutes/);
    assert.equal(r.link?.url, `https://cloud.digitalocean.com/apps/${APP_ID}/logs`);
  });
});
