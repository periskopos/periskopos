import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Approval, TrafficPoint } from "../shared/types.ts";
import { listActions } from "../server/agents/actions.ts";
import { createApp } from "../server/app.ts";
import { Approvals } from "../server/agents/approvals.ts";
import { openDb } from "../server/db.ts";
import { clearHttpCache } from "../server/http.ts";
import {
  SPIKE_MIN_REQUESTS,
  clearZoneCache,
  cloudflareZone as zone,
  covers,
  errorSpike,
  totalsOf,
  zoneDetails,
} from "../server/integrations/cloudflare-zone/index.ts";
import { authFor } from "../server/keys/secrets.ts";
import { updateSettings } from "../server/settings.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// Cloudflare is faked throughout: nothing here reaches the network, and the
// purge is only ever sent to the fake.

process.env.PERISKOPOS_TEST_CFZ_KEY = "cfz_test";

const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const HOUR = 3_600_000;
const TOKEN = "t".repeat(43);
const AGENT = "g".repeat(43);
const realFetch = globalThis.fetch;

type Call = { method: string; path: string; body?: unknown };
let calls: Call[];
let zoneInfo: Record<string, unknown>;
let dns: unknown[] | 403;
let certs: unknown[] | 403;
let hours: unknown[];
let days: unknown[];
let rumSites: unknown[];
let rum: { days: unknown[]; week: unknown[]; month: unknown[] };

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { "content-type": "application/json" } });
const refused = () => new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: 403 });
const data = (d: unknown) => new Response(JSON.stringify({ data: d, errors: null }), { headers: { "content-type": "application/json" } });

const group = (dims: Record<string, string>, requests: number, cached: number, codes: Record<number, number>, uniques: number) => ({
  dimensions: dims,
  sum: {
    requests,
    cachedRequests: cached,
    bytes: requests * 1000,
    responseStatusMap: Object.entries(codes).map(([code, n]) => ({ edgeResponseStatus: Number(code), requests: n })),
  },
  uniq: { uniques },
});
const hourAt = (hoursAgo: number) => new Date(Math.floor(Date.now() / HOUR) * HOUR - hoursAgo * HOUR).toISOString().replace(".000Z", "Z");
const dayAt = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

beforeEach(() => {
  clearHttpCache();
  clearZoneCache();
  calls = [];
  zoneInfo = { id: ZONE, name: "example.org", status: "active", paused: false, development_mode: 0, account: { id: ACCOUNT, name: "Me" }, plan: { name: "Free Website" } };
  dns = [{ name: "example.org", type: "AAAA", content: "100::", proxied: true }];
  certs = [
    { id: "p1", type: "universal", status: "active", hosts: ["example.org", "*.example.org"] },
    { id: "p2", type: "universal", status: "backup_issued", hosts: ["example.org", "*.example.org"] },
  ];
  hours = [group({ datetime: hourAt(0) }, 100, 80, { 200: 99, 503: 1 }, 10)];
  days = [group({ date: dayAt(1) }, 1000, 500, { 200: 990, 404: 5, 502: 5 }, 100), group({ date: dayAt(0) }, 200, 150, { 200: 200 }, 20)];
  rumSites = [{ site_tag: "s1", ruleset: { zone_tag: ZONE, zone_name: "example.org", enabled: false } }];
  rum = { days: [], week: [], month: [] };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname + url.search, ...(body ? { body } : {}) });
    assert.equal(url.host, "api.cloudflare.com");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer cfz_test");
    const p = url.pathname.replace("/client/v4", "");
    if (p === "/zones") return ok([zoneInfo]);
    if (p === `/zones/${ZONE}`) return ok(zoneInfo);
    if (p === `/zones/${ZONE}/dns_records`) return dns === 403 ? refused() : ok(dns);
    if (p === `/zones/${ZONE}/ssl/certificate_packs`) return certs === 403 ? refused() : ok(certs);
    if (p === `/zones/${ZONE}/purge_cache` && method === "POST") return ok({ id: ZONE });
    if (p === `/accounts/${ACCOUNT}/rum/site_info/list`) return ok(rumSites);
    if (p === "/graphql") {
      const q = String((body as { query: string }).query);
      if (q.includes("rumPageloadEventsAdaptiveGroups")) return data({ viewer: { accounts: [rum] } });
      if (q.includes("httpRequests1hGroups")) return data({ viewer: { zones: [{ hours }] } });
      if (q.includes("httpRequests1dGroups")) return data({ viewer: { zones: [{ days }] } });
    }
    return new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setUp(canWrite = true) {
  const db = openDb(":memory:");
  const user = store.createUser(db, "Me");
  const service = store.createService(db, user.id, { type: "cloudflare", name: "My Cloudflare", secretRef: "PERISKOPOS_TEST_CFZ_KEY", canWrite });
  const app = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org" });
  const conn = store.addConnection(db, app, {
    type: "cloudflare-zone",
    serviceId: service.id,
    ...zone.parse({ resource: "example.org", settings: { zoneId: ZONE, accountId: ACCOUNT, host: "example.org" } }),
  });
  return { db, user, service, app: store.getApp(db, user.id, app.slug)!, conn, auth: authFor(service) };
}

const point = (at: string, requests: number, errors5xx: number): TrafficPoint => ({ at, requests, cachedRequests: 0, bytes: 0, visitors: 0, errors5xx });

describe("cloudflare domain", () => {
  test("parse needs the zone from the list, and keeps the app's host only when it's on the domain", () => {
    assert.throws(() => zone.parse({ resource: "example.org", settings: {} }), /Pick the domain from the list/);
    assert.throws(() => zone.parse({ resource: "not a domain", settings: { zoneId: ZONE, accountId: ACCOUNT } }));
    assert.deepEqual(zone.parse({ resource: "Example.org", settings: { zoneId: ZONE, accountId: ACCOUNT, host: "www.example.org" } }), {
      resource: "example.org",
      settings: { zoneId: ZONE, accountId: ACCOUNT, host: "www.example.org" },
    });
    assert.equal(zone.parse({ resource: "example.org", settings: { zoneId: ZONE, accountId: ACCOUNT, host: "evil.example" } }).settings?.host, "example.org");
  });

  test("lists the account's domains with the zone and account ids", async () => {
    const { auth } = setUp();
    const [r] = await zone.listResources!(auth);
    assert.deepEqual(r, { id: "example.org", label: "example.org", detail: "Me · Free Website", settings: { zoneId: ZONE, accountId: ACCOUNT } });
  });

  test("the add-connection list offers domains for a Cloudflare account through ?type=", async () => {
    const { db, service } = setUp();
    const distDir = tempDir("periskopos-web-");
    writeFileSync(path.join(distDir, "index.html"), "");
    const gc = createApp({ db, token: TOKEN, port: 4100, distDir });
    const res = await gc.request(`http://localhost:4100/api/services/${service.id}/resources?type=cloudflare-zone`, { headers: { "x-periskopos-token": TOKEN } });
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { resources: { id: string }[] }).resources[0].id, "example.org");
    const wrong = await gc.request(`http://localhost:4100/api/services/${service.id}/resources?type=github`, { headers: { "x-periskopos-token": TOKEN } });
    assert.equal(wrong.status, 400);
  });

  test("health: active is up, with DNS, the certificate and today's traffic in the summary", async () => {
    const { conn, auth } = setUp();
    const r = await zone.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /example\.org active/);
    assert.match(r.summary!, /DNS: example\.org proxied/);
    assert.match(r.summary!, /Edge certificate active/, "backup_issued next to an active pack is normal");
    assert.match(r.summary!, /100 requests in 24 h · 1% 5xx/);
  });

  test("health: paused or not active is down (needs attention), development mode is only said", async () => {
    const { conn, auth } = setUp();
    zoneInfo = { ...zoneInfo, paused: true };
    let r = await zone.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /Cloudflare is paused on example\.org/);
    assert.equal(zone.incidentKind, "dependency");

    clearHttpCache();
    zoneInfo = { ...zoneInfo, paused: false, status: "pending" };
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /pending: its nameservers/);

    clearHttpCache();
    zoneInfo = { ...zoneInfo, status: "active", development_mode: 7200 };
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Development mode on: cache bypassed for another 120 min/);
  });

  test("health: a missing DNS record or an inactive certificate is a problem", async () => {
    const { conn, auth } = setUp();
    dns = [{ name: "example.org", type: "MX", content: "mx.example", proxied: false }];
    let r = await zone.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /no A, AAAA or CNAME record/);

    clearHttpCache();
    dns = [{ name: "example.org", type: "AAAA", content: "100::", proxied: true }];
    certs = [{ id: "p1", status: "pending_validation", hosts: ["example.org"] }];
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /edge certificate for example\.org is pending validation/);

    clearHttpCache();
    certs = [{ id: "p1", status: "active", hosts: ["*.example.org"] }];
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "down", "a wildcard doesn't cover the bare domain");
    assert.match(r.detail!, /No Cloudflare edge certificate covers example\.org/);

    clearHttpCache();
    dns = [{ name: "example.org", type: "A", content: "1.2.3.4", proxied: false }];
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "up", "a DNS-only name doesn't use Cloudflare's certificate");
    assert.match(r.summary!, /DNS only/);
  });

  test("health: without DNS or SSL read permission it stays up and names the permission to add", async () => {
    const { conn, auth } = setUp();
    dns = 403;
    certs = 403;
    const r = await zone.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /Add Zone → DNS → Read to check DNS records/);
    assert.match(r.summary!, /Add Zone → SSL and Certificates → Read/);
  });

  test("certificate hosts: a wildcard covers one level only", () => {
    assert.ok(covers("*.example.org", "www.example.org"));
    assert.ok(covers("example.org", "example.org"));
    assert.ok(!covers("*.example.org", "example.org"));
    assert.ok(!covers("*.example.org", "a.b.example.org"));
  });

  test("error spike: 5% of at least 50 requests in the current and previous hour", () => {
    const now = Math.floor(Date.now() / HOUR) * HOUR + 20 * 60_000; // 20 past the hour
    const at = (hoursAgo: number) => new Date(Math.floor(now / HOUR) * HOUR - hoursAgo * HOUR).toISOString();
    assert.equal(errorSpike([point(at(0), 40, 30)], now), undefined, "too few requests to judge");
    assert.equal(errorSpike([point(at(1), 100, 4)], now), undefined, "4% is under the threshold");
    assert.equal(errorSpike([point(at(2), 100, 90), point(at(0), 100, 0)], now), undefined, "older hours don't count");
    // The edges: exactly 5% is a spike, and so are exactly 50 requests.
    assert.ok(errorSpike([point(at(0), 100, 5)], now), "exactly 5%");
    assert.ok(errorSpike([point(at(0), 50, 3)], now), "exactly 50 requests");
    assert.equal(errorSpike([point(at(0), 49, 3)], now), undefined, "49 requests");
    const spike = errorSpike([point(at(1), 30, 3), point(at(0), 30, 3)], now);
    assert.ok(spike && 30 + 30 >= SPIKE_MIN_REQUESTS);
    assert.match(spike!.reason, /^10% of requests failed \(5xx\) since \d\d:00: 6 of 60$/);
  });

  test("error spike: the check alerts with the reason, and recovers when it drops", async () => {
    const { conn, auth } = setUp();
    hours = [group({ datetime: hourAt(0) }, 200, 0, { 200: 176, 502: 24 }, 5)];
    let r = await zone.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /12% of requests failed \(5xx\) since \d\d:00: 24 of 200/);
    assert.equal(zone.notice!("down", "Star-Map", r.detail!, 0).title, "Star-Map: requests are failing");

    clearHttpCache();
    clearZoneCache();
    hours = [group({ datetime: hourAt(0) }, 200, 0, { 200: 199, 502: 1 }, 5)];
    r = await zone.check!(conn, auth);
    assert.equal(r.state, "up");
  });

  test("traffic: totals, cached share, 5xx share and gap-free series", async () => {
    const { conn, auth } = setUp();
    const d = await zoneDetails(conn, auth);
    const t = d.traffic!;
    assert.equal(t.hours.length, 24);
    assert.equal(t.days.length, 30);
    assert.equal(t.days.at(-1)!.at, dayAt(0));
    assert.equal(t.days[0].requests, 0, "days without traffic are zero, not missing");
    assert.deepEqual(t.totals.week, { requests: 1200, bytes: 1_200_000, visitors: 120, errors5xx: 5, cachedPct: 54.2, errorPct: 0.4 });
    assert.equal(t.totals.day.requests, 100);
    assert.deepEqual(totalsOf([]), { requests: 0, bytes: 0, visitors: 0, errors5xx: 0 });
    // The second read within the refresh window is the cached one.
    const before = calls.filter((c) => c.path.startsWith("/client/v4/graphql")).length;
    await zoneDetails(conn, auth);
    assert.equal(calls.filter((c) => c.path.startsWith("/client/v4/graphql")).length, before);
  });

  test("visitors: Web Analytics off says how to switch it on; none says it isn't set up", async () => {
    const { conn, auth } = setUp();
    let v = (await zoneDetails(conn, auth)).visitors;
    assert.ok(v.state === "off");
    assert.match(v.message, /Web Analytics is off for example\.org/);
    assert.match(v.howTo ?? "", /Analytics & Logs → Web Analytics → this site → turn on automatic setup/);

    clearHttpCache();
    rumSites = [];
    v = (await zoneDetails(conn, auth)).visitors;
    assert.equal(v.state, "none");
  });

  test("visitors: with Web Analytics on, visits and page views per day and top pages", async () => {
    const { conn, auth } = setUp();
    rumSites = [{ site_tag: "s1", ruleset: { zone_tag: ZONE, enabled: true } }];
    rum = {
      days: [{ count: 30, sum: { visits: 12 }, dimensions: { date: dayAt(0) } }],
      week: [{ count: 20, dimensions: { requestPath: "/" } }, { count: 10, dimensions: { requestPath: "/pricing" } }],
      month: [{ count: 25, dimensions: { requestPath: "/" } }],
    };
    const v = (await zoneDetails(conn, auth)).visitors;
    assert.ok(v.state === "on");
    assert.equal(v.days.length, 30);
    assert.deepEqual(v.days.at(-1), { date: dayAt(0), visits: 12, pageViews: 30 });
    assert.deepEqual(v.topPages.week, [{ path: "/", views: 20 }, { path: "/pricing", views: 10 }]);
  });

  test("purge cache: offered only with Allow actions, and sends exactly purge_everything", async () => {
    const readOnly = setUp(false);
    let listed = await listActions(readOnly.db, readOnly.app);
    assert.deepEqual(listed.actions, []);
    assert.match(listed.blocked[0].reason, /read only/);

    const { db, app, conn, auth } = setUp(true);
    listed = await listActions(db, app);
    const def = listed.actions.find((a) => a.id === `purge-cache:${conn.id}`);
    assert.ok(def);
    assert.equal(def.danger, false);
    assert.match(def.description, /next visits fetch fresh copies/);
    assert.match(def.description, /Nothing is deleted from the app/);

    const r = await zone.run!(conn, auth, "purge-cache");
    assert.equal(r.ok, true);
    const posts = calls.filter((c) => c.method === "POST");
    assert.deepEqual(posts, [{ method: "POST", path: `/client/v4/zones/${ZONE}/purge_cache`, body: { purge_everything: true } }]);
  });

  test("purge cache from an agent waits for approval on screen", async () => {
    const { db, user, app, conn } = setUp(true);
    updateSettings(db, user.id, { agentAccess: true });
    const asked: Approval[] = [];
    let answer = false;
    const approvals = new Approvals({ timeoutMs: 500 });
    approvals.onRequest((a) => {
      asked.push(a);
      approvals.decide(a.id, answer);
    });
    const distDir = tempDir("periskopos-web-");
    writeFileSync(path.join(distDir, "index.html"), "");
    const watcher = new Watcher({ db, notifier: { notify: async () => {} }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true });
    const gc = createApp({ db, token: TOKEN, agentToken: AGENT, approvals, port: 4100, distDir, watcher });
    const run = () =>
      gc.request(`http://localhost:4100/api/apps/${app.slug}/actions/${encodeURIComponent(`purge-cache:${conn.id}`)}`, {
        method: "POST",
        headers: { "x-periskopos-token": AGENT, "content-type": "application/json" },
        body: JSON.stringify({ confirmed: true }),
      });

    let res = await run();
    assert.equal(res.status, 403, "declined on screen");
    assert.equal(asked[0].label, "Purge cache");
    assert.equal(calls.some((c) => c.method === "POST"), false, "nothing reached Cloudflare");

    answer = true;
    res = await run();
    assert.equal(res.status, 200);
    assert.equal(calls.filter((c) => c.method === "POST" && c.path.endsWith("/purge_cache")).length, 1);
  });
});
