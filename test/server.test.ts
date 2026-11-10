import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { App, AppStatus, Connection } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

const TOKEN = "t".repeat(43);
const PORT = 4100;
const BASE = `http://localhost:${PORT}`;

const distDir = tempDir("periskopos-web-");
writeFileSync(
  path.join(distDir, "index.html"),
  '<meta name="periskopos" content="app" />',
);

let gc: ReturnType<typeof createApp>;
beforeEach(() => {
  const db = openDb(":memory:");
  const watcher = new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true });
  gc = createApp({ db, token: TOKEN, port: PORT, distDir, watcher });
});

function call(method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) {
  return gc.request(`${BASE}${urlPath}`, {
    method,
    headers: {
      "x-periskopos-token": TOKEN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function setUp() {
  assert.equal((await call("POST", "/api/setup", { name: "Me" })).status, 201);
}

// A local site to check: /ok answers 200, /slow too but after 150 ms,
// /fail answers 500.
let site: ReturnType<typeof createServer>;
let siteUrl = "";
let closedUrl = "";
before(async () => {
  site = createServer((req, res) => {
    res.statusCode = req.url === "/ok" || req.url === "/slow" ? 200 : 500;
    setTimeout(() => res.end("hello"), req.url === "/slow" ? 150 : 0);
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;

  const closed = createServer();
  await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
  closedUrl = `http://127.0.0.1:${(closed.address() as AddressInfo).port}/`;
  await new Promise((resolve) => closed.close(resolve));
});
after(() => site.close());

describe("guard (NFR-SEC2)", () => {
  test("rejects a foreign Host, even with the token (DNS rebinding)", async () => {
    const res = await gc.request("http://evil.example:4100/api/me", { headers: { "x-periskopos-token": TOKEN } });
    assert.equal(res.status, 403);
  });

  test("rejects the page itself on a foreign Host", async () => {
    const res = await gc.request("http://evil.example:4100/");
    assert.equal(res.status, 403);
  });

  test("rejects API calls without the token or with a wrong one", async () => {
    assert.equal((await gc.request(`${BASE}/api/me`)).status, 401);
    assert.equal((await call("GET", "/api/me", undefined, { "x-periskopos-token": "x".repeat(43) })).status, 401);
  });

  test("rejects a foreign Origin and cross-site fetches", async () => {
    assert.equal((await call("GET", "/api/me", undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await call("GET", "/api/me", undefined, { "sec-fetch-site": "cross-site" })).status, 403);
  });

  test("accepts its own origin on localhost and 127.0.0.1", async () => {
    assert.equal((await call("GET", "/api/me", undefined, { origin: BASE })).status, 200);
    const res = await gc.request(`http://127.0.0.1:${PORT}/api/me`, { headers: { "x-periskopos-token": TOKEN } });
    assert.equal(res.status, 200);
  });

  test("serves the page only to the app's window (its session cookie), with a strict CSP and no key in it", async () => {
    const res = await gc.request(`${BASE}/`, { headers: { cookie: `other=1; periskopos_session=${TOKEN}` } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.ok(!html.includes(TOKEN), "the page never carries the key");
    assert.match(res.headers.get("content-security-policy") ?? "", /default-src 'self'/);
  });

  test("anything else (a browser, curl) gets the locked page, and the API with the cookie works", async () => {
    const strangers: Record<string, string>[] = [{}, { cookie: "periskopos_session=" + "x".repeat(43) }, { "x-periskopos-token": "x".repeat(43) }];
    for (const headers of strangers) {
      const res = await gc.request(`${BASE}/`, { headers });
      assert.equal(res.status, 403);
      assert.match(await res.text(), /opens only in its desktop app/);
    }
    const viaCookie = await gc.request(`${BASE}/api/me`, { headers: { cookie: `periskopos_session=${TOKEN}` } });
    assert.equal(viaCookie.status, 200);
  });
});

describe("first run (FR-U1)", () => {
  test("no user until set up, then exactly one", async () => {
    assert.deepEqual(await (await call("GET", "/api/me")).json(), { user: null });
    assert.equal((await call("GET", "/api/apps")).status, 409);
    await setUp();
    const { user } = (await (await call("GET", "/api/me")).json()) as { user: { name: string } };
    assert.equal(user.name, "Me");
    assert.equal((await call("POST", "/api/setup", { name: "Again" })).status, 409);
  });

  test("a name is required", async () => {
    assert.equal((await call("POST", "/api/setup", { name: "  " })).status, 400);
  });
});

describe("apps and connections", () => {
  beforeEach(setUp);

  test("a new app gets a slug and a site check for its URL (FR-A1)", async () => {
    const res = await call("POST", "/api/apps", { name: "Star-Map", url: "https://example.org" });
    assert.equal(res.status, 201);
    const { app } = (await res.json()) as { app: App };
    assert.equal(app.slug, "star-map");
    // From the URL alone: the site, its certificate and its domain.
    assert.deepEqual(
      app.connections.map((c) => [c.type, c.resource]),
      [["site", "https://example.org/"], ["ssl", "example.org"], ["domain", "example.org"]],
    );
  });

  test("slugs stay unique", async () => {
    await call("POST", "/api/apps", { name: "Same", url: "https://a.example" });
    const { app } = (await (await call("POST", "/api/apps", { name: "Same", url: "https://b.example" })).json()) as { app: App };
    assert.equal(app.slug, "same-2");
  });

  test("only http(s) URLs are accepted", async () => {
    for (const url of ["javascript:alert(1)", "ftp://x.example", "not a url", "https://u:p@x.example"]) {
      assert.equal((await call("POST", "/api/apps", { name: "X", url })).status, 400, url);
    }
  });

  test("changing the URL moves the site check with it", async () => {
    await call("POST", "/api/apps", { name: "A", url: "https://old.example" });
    const { app } = (await (await call("PATCH", "/api/apps/a", { url: "https://new.example" })).json()) as { app: App };
    assert.equal(app.url, "https://new.example/");
    assert.deepEqual(
      app.connections.map((c) => [c.type, c.resource]),
      [["site", "https://new.example/"], ["ssl", "new.example"]],
    );
  });

  test("links need a label; connections can be removed", async () => {
    await call("POST", "/api/apps", { name: "A", url: "https://a.example" });
    assert.equal((await call("POST", "/api/apps/a/connections", { type: "link", resource: "https://x.example" })).status, 400);
    const res = await call("POST", "/api/apps/a/connections", {
      type: "link",
      resource: "https://dashboard.render.com",
      settings: { label: "Render" },
    });
    assert.equal(res.status, 201);
    const { connection } = (await res.json()) as { connection: Connection };
    assert.deepEqual(connection.settings, { label: "Render" });
    const again = await call("POST", "/api/apps/a/connections", { type: "link", resource: "https://dashboard.render.com", settings: { label: "Render 2" } });
    assert.equal(again.status, 409, "the same thing twice is refused");
    assert.match(((await again.json()) as { error: string }).error, /^A already has https:\/\/dashboard\.render\.com\/ connected$/);
    assert.equal((await call("DELETE", `/api/apps/a/connections/${connection.id}`)).status, 204);
    assert.equal((await call("DELETE", `/api/apps/a/connections/${connection.id}`)).status, 404);
  });

  test("unknown connection types are refused", async () => {
    await call("POST", "/api/apps", { name: "A", url: "https://a.example" });
    assert.equal((await call("POST", "/api/apps/a/connections", { type: "nope", resource: "https://x.example" })).status, 400);
    // Names every object inherits are not types either.
    for (const type of ["constructor", "toString", "__proto__"]) {
      assert.equal((await call("POST", "/api/apps/a/connections", { type, resource: "https://x.example" })).status, 400, type);
    }
  });

  test("unknown service types are refused, inherited names too", async () => {
    for (const type of ["nope", "constructor", "toString", "hasOwnProperty"]) {
      const res = await call("POST", "/api/services", { type, name: "X", secretRef: "X_KEY" });
      assert.equal(res.status, 400, type);
    }
    assert.deepEqual(((await (await call("GET", "/api/services")).json()) as { services: unknown[] }).services, []);
  });

  test("the plan switch: only for an account with a free plan to watch", async () => {
    type View = { service: { id: string; paidPlan?: true; canWrite: boolean } };
    const cf = ((await (await call("POST", "/api/services", { type: "cloudflare", name: "CF", secretRef: "CF_KEY" })).json()) as View).service;
    const gh = ((await (await call("POST", "/api/services", { type: "github", name: "GH" })).json()) as View).service;
    const paid = (await (await call("PATCH", `/api/services/${cf.id}`, { paidPlan: true })).json()) as View;
    assert.deepEqual([paid.service.paidPlan, paid.service.canWrite], [true, false], "the other switch is left alone");
    assert.equal(((await (await call("PATCH", `/api/services/${cf.id}`, { paidPlan: false })).json()) as View).service.paidPlan, undefined);
    assert.equal((await call("PATCH", `/api/services/${gh.id}`, { paidPlan: true })).status, 400);
    assert.equal((await call("PATCH", `/api/services/${cf.id}`, { paidPlan: "yes" })).status, 400);
    assert.equal((await call("PATCH", `/api/services/${cf.id}`, {})).status, 400);
  });

  test("deleting an app removes it", async () => {
    await call("POST", "/api/apps", { name: "A", url: "https://a.example" });
    assert.equal((await call("DELETE", "/api/apps/a")).status, 204);
    assert.equal((await call("GET", "/api/apps/a")).status, 404);
  });
});

describe("the watcher's log", () => {
  beforeEach(setUp);

  type Log = { off: boolean; checks: { at: string; state: string; slug: string; app: string; what: string; ms?: number }[] };
  const read = async () => (await (await call("GET", "/api/watcher/log")).json()) as Log;

  test("says what was checked, newest first, and nothing before there's anything", async () => {
    assert.deepEqual((await read()).checks, []);
    await call("POST", "/api/apps", { name: "Shop", url: "http://shop.test/" });
    await call("GET", "/api/apps/shop/status");
    await call("GET", "/api/apps/shop/status?refresh=1");
    const { checks, off } = await read();
    assert.equal(off, false);
    assert.ok(checks.length >= 2);
    assert.equal(checks[0]!.slug, "shop");
    assert.equal(checks[0]!.app, "Shop");
    assert.ok(checks[0]!.what.length > 0);
    assert.ok(checks.every((c, i) => i === 0 || c.at <= checks[i - 1]!.at));
  });
});

describe("status (site check)", () => {
  beforeEach(setUp);

  async function statusOf(url: string): Promise<AppStatus> {
    await call("POST", "/api/apps", { name: "S", url });
    return ((await (await call("GET", "/api/apps/s/status")).json()) as { status: AppStatus }).status;
  }

  test("up when the site answers 2xx, with a response time", async () => {
    const status = await statusOf(`${siteUrl}/ok`);
    assert.equal(status.state, "up");
    const [check] = Object.values(status.checks);
    assert.equal(check.httpStatus, 200);
    assert.equal(typeof check.ms, "number");
  });

  test("down when the site answers 5xx, saying why", async () => {
    const status = await statusOf(`${siteUrl}/fail`);
    assert.equal(status.state, "down");
    assert.equal(Object.values(status.checks)[0].detail, "Answered HTTP 500");
  });

  test("down when nothing is listening", async () => {
    const status = await statusOf(closedUrl);
    assert.equal(status.state, "down");
    assert.equal(Object.values(status.checks)[0].detail, "Connection refused");
  });

  test("an app with only links has state none", async () => {
    await call("POST", "/api/apps", { name: "L", url: `${siteUrl}/ok` });
    const { app } = (await (await call("GET", "/api/apps/l")).json()) as { app: App };
    await call("DELETE", `/api/apps/l/connections/${app.connections[0].id}`);
    const { statuses } = (await (await call("GET", "/api/status")).json()) as { statuses: AppStatus[] };
    assert.equal(statuses.find((s) => s.slug === "l")?.state, "none");
  });
});

describe("an app that isn't live yet (FR-A7)", () => {
  beforeEach(setUp);

  const statusFor = async (slug: string) => {
    const { statuses } = (await (await call("GET", "/api/status?refresh=1")).json()) as { statuses: AppStatus[] };
    return statuses.find((s) => s.slug === slug)!;
  };

  test("is live unless said otherwise, and a non-boolean is refused", async () => {
    const { app } = (await (await call("POST", "/api/apps", { name: "A", url: `${siteUrl}/ok` })).json()) as { app: App };
    assert.equal(app.live, true);
    assert.equal((await call("POST", "/api/apps", { name: "B", url: `${siteUrl}/ok`, live: "no" })).status, 400);
  });

  test("its dead site is never checked: not down, no uptime, a state of its own", async () => {
    await call("POST", "/api/apps", { name: "Soon", url: closedUrl, live: false });
    const status = await statusFor("soon");
    assert.equal(status.state, "prelaunch");
    assert.deepEqual(status.checks, {});
    assert.equal(status.incident, undefined);
    assert.equal(status.uptime30d, undefined);
  });

  test("marking a down app not live clears the outage; marking it live checks it again", async () => {
    await call("POST", "/api/apps", { name: "Soon", url: closedUrl });
    await statusFor("soon");
    assert.equal((await statusFor("soon")).state, "down");

    await call("PATCH", "/api/apps/soon", { live: false });
    const parked = await statusFor("soon");
    assert.equal(parked.state, "prelaunch");
    assert.equal(parked.incident, undefined);

    await call("PATCH", "/api/apps/soon", { live: true });
    assert.equal((await statusFor("soon")).state, "down");
  });
});

describe("status checks: extra URLs and their settings", () => {
  beforeEach(setUp);

  test("an extra URL is its own status check, once per URL, and the app's URL leaves it alone", async () => {
    await call("POST", "/api/apps", { name: "A", url: `${siteUrl}/ok` });
    const res = await call("POST", "/api/apps/a/connections", { type: "site", resource: `${siteUrl}/fail` });
    assert.equal(res.status, 201);
    const { connection } = (await res.json()) as { connection: Connection };
    assert.deepEqual(connection.settings, { label: "/fail" }, "named by its path when given no name");
    assert.equal((await call("POST", "/api/apps/a/connections", { type: "site", resource: `${siteUrl}/fail` })).status, 400, "already checked");
    assert.equal((await call("POST", "/api/apps/a/connections", { type: "site", resource: `${siteUrl}/ok` })).status, 400, "the app's own URL");

    const { status } = (await (await call("GET", "/api/apps/a/status")).json()) as { status: AppStatus };
    assert.equal(status.checks[connection.id]?.detail, "Answered HTTP 500");
    assert.equal(status.state, "down", "an extra URL failing is the app failing");

    const { app } = (await (await call("PATCH", "/api/apps/a", { url: "https://new.example" })).json()) as { app: App };
    assert.deepEqual(
      app.connections.filter((c) => c.type === "site").map((c) => c.resource),
      ["https://new.example/", `${siteUrl}/fail`],
    );
  });

  test("what a page must contain is saved and checked at once; a bad value is refused", async () => {
    await call("POST", "/api/apps", { name: "A", url: `${siteUrl}/ok` });
    const { app } = (await (await call("GET", "/api/apps/a")).json()) as { app: App };
    const siteId = app.connections.find((c) => c.type === "site")!.id;
    const patch = (body: unknown) => call("PATCH", `/api/apps/a/connections/${siteId}`, body);

    assert.equal((await patch({ expectText: "Welcome", slowMs: "1500", slowChecks: "4" })).status, 200);
    const { status } = (await (await call("GET", "/api/apps/a/status")).json()) as { status: AppStatus };
    assert.equal(status.checks[siteId]?.detail, "The page doesn't contain “Welcome”");
    const saved = ((await (await call("GET", "/api/apps/a")).json()) as { app: App }).app.connections.find((c) => c.id === siteId);
    assert.deepEqual(saved?.settings, { expectText: "Welcome", slowMs: 1500, slowChecks: 4 });

    const bad = await patch({ slowMs: 5 });
    assert.equal(bad.status, 400);
    assert.match(((await bad.json()) as { error: string }).error, /from 100 to 9000/);
    assert.equal((await patch({ expectText: "hello" })).status, 200);
    const after = ((await (await call("GET", "/api/apps/a")).json()) as { app: App }).app.connections.find((c) => c.id === siteId);
    assert.deepEqual(after?.settings, { expectText: "hello" }, "blank fields switch off what they set");
  });

  test("slow for the checks in a row it takes: the app needs attention, it isn't down", async () => {
    await call("POST", "/api/apps", { name: "A", url: `${siteUrl}/slow` });
    const { app } = (await (await call("GET", "/api/apps/a")).json()) as { app: App };
    const siteId = app.connections.find((c) => c.type === "site")!.id;
    await call("PATCH", `/api/apps/a/connections/${siteId}`, { slowMs: 100, slowChecks: 2 });
    // Saving checks it once: one slow answer isn't yet two in a row.
    const once = ((await (await call("GET", "/api/apps/a/status")).json()) as { status: AppStatus }).status;
    assert.ok(once.checks[siteId]!.ms! > 100, "the first check was slow too");
    assert.equal(once.state, "up");
    const { status } = (await (await call("GET", "/api/apps/a/status?refresh=1")).json()) as { status: AppStatus };
    assert.equal(status.checks[siteId]?.state, "up");
    assert.equal(status.state, "attention");
    assert.equal(status.incident?.kind, "slow");
  });
});
