import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection, ProviderIncident, ProviderMaintenance, ProviderStatus, ServiceType } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { keylessChecks, openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { clearHttpCache } from "../server/http.ts";
import { domain, evaluate as evalDomain, expiryFromRdap, registrableDomain } from "../server/integrations/domain.ts";
import { evaluate as evalCert, setCertFetcher, ssl } from "../server/integrations/ssl.ts";
import { describeStatus, supabase, unhealthyServices } from "../server/integrations/supabase.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { affects, listProviders, parseSummary, partsInUse, partsView, relevantIndicator } from "../server/providers.ts";
import { authFor } from "../server/keys/secrets.ts";
import { StatusService } from "../server/status.ts";
import { updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { Watcher, TICK_MS } from "../server/watcher.ts";
import type { Fetched } from "../server/providers.ts";
import { tempDir } from "./tmp.ts";

process.env.PERISKOPOS_TEST_SB_KEY = "sbp_test";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-06T12:00:00Z");
const inDays = (n: number) => new Date(NOW + n * DAY).toISOString();

describe("checks from a URL alone (FR-A1)", () => {
  test("https gets site + ssl + domain; http only site (+ domain)", () => {
    assert.deepEqual(keylessChecks("https://example.org/").map((c) => c.type), ["site", "ssl", "domain"]);
    assert.deepEqual(keylessChecks("http://example.org/").map((c) => c.type), ["site", "domain"]);
  });

  test("local, test and IP addresses have no registered domain to watch", () => {
    for (const url of ["http://localhost:3000", "http://127.0.0.1:4199/", "http://thing.test", "http://x.invalid", "http://intranet/"]) {
      assert.deepEqual(keylessChecks(url).map((c) => c.type), ["site"], url);
    }
    // Over https there's still a certificate to watch, but no domain.
    assert.deepEqual(keylessChecks("https://thing.test").map((c) => c.type), ["site", "ssl"]);
    assert.deepEqual(keylessChecks("https://10.0.0.5/").map((c) => c.type), ["site", "ssl"]);
  });

  test("a port stays with the certificate host", () => {
    assert.deepEqual(keylessChecks("https://app.example.com:8443/").find((c) => c.type === "ssl")?.resource, "app.example.com:8443");
  });
});

describe("ssl", () => {
  const cert = (daysLeft: number, extra = {}) => ({ validTo: inDays(daysLeft), authorized: true, issuer: "Let's Encrypt", ...extra });

  test("valid with plenty of time is up and says when it ends", () => {
    const r = evalCert(cert(60), NOW);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Valid until 2026-12-05 · 60 days left · Let's Encrypt/);
  });

  test("14 days or less warns; 15 does not", () => {
    assert.equal(evalCert(cert(14), NOW).state, "down");
    assert.equal(evalCert(cert(15), NOW).state, "up");
    assert.equal(evalCert(cert(9), NOW).detail, "Certificate expires in 9 days (2026-10-15)");
  });

  test("days are whole days: expired within the day is today, days left round up", () => {
    assert.match(evalCert({ validTo: new Date(NOW - 3_600_000).toISOString(), authorized: true }, NOW).detail!, /^Certificate expired today/);
    assert.match(evalCert({ validTo: new Date(NOW - 25 * 3_600_000).toISOString(), authorized: true }, NOW).detail!, /^Certificate expired 1 day ago/);
    const almost14 = evalCert({ validTo: new Date(NOW + 14 * DAY - 3_600_000).toISOString(), authorized: true }, NOW);
    assert.match(almost14.detail!, /^Certificate expires in 14 days/);
    assert.equal(evalCert({ validTo: new Date(NOW + 14 * DAY + 3_600_000).toISOString(), authorized: true }, NOW).state, "up", "15 days left (rounded up) doesn't warn");
    assert.match(evalDomain(new Date(NOW - 3_600_000).toISOString(), "looked up", NOW).detail!, /^Domain expired today/);
    assert.match(evalDomain(new Date(NOW + 30 * DAY - 3_600_000).toISOString(), "looked up", NOW).detail!, /^Domain expires in 30 days/);
  });

  test("the domain's date reads dd/mm/yyyy", () => {
    assert.match(evalDomain("2026-10-20T00:00:00.000Z", "looked up", NOW).detail!, /\(20\/10\/2026\)$/);
    assert.match(evalDomain("2027-09-22T00:00:00.000Z", "entered", NOW).summary!, /^Registered until 22\/09\/2027 · /);
  });

  test("expired and untrusted are problems with their reason", () => {
    assert.match(evalCert(cert(-3), NOW).detail!, /^Certificate expired 3 days ago/);
    const bad = evalCert(cert(90, { authorized: false, error: "Hostname/IP does not match certificate's altnames" }), NOW);
    assert.equal(bad.state, "down");
    assert.match(bad.detail!, /isn't trusted: Hostname/);
  });

  test("a failed handshake is unknown, not a problem", async () => {
    setCertFetcher(async () => {
      throw new Error("ECONNREFUSED");
    });
    try {
      const r = await ssl.check!({ id: "c", appId: "a", type: "ssl", resource: "example.org" });
      assert.equal(r.state, "unknown");
    } finally {
      setCertFetcher(undefined);
    }
  });

  test("host:port is parsed; junk is refused", () => {
    assert.deepEqual(ssl.parse({ resource: "app.example.com:8443", settings: {} }), { resource: "app.example.com:8443" });
    assert.throws(() => ssl.parse({ resource: "bad host!", settings: {} }));
  });
});

describe("domain", () => {
  test("registrable domain: last two labels, three under a country second level", () => {
    assert.equal(registrableDomain("www.example.org"), "example.org");
    assert.equal(registrableDomain("example.org"), "example.org");
    assert.equal(registrableDomain("shop.example.co.uk"), "example.co.uk");
    assert.equal(registrableDomain("a.b.example.org.il"), "example.org.il");
  });

  test("the expiry comes from the RDAP expiration event", () => {
    assert.equal(expiryFromRdap({ events: [{ eventAction: "registration", eventDate: "2026-01-01T00:00:00Z" }, { eventAction: "expiration", eventDate: "2027-09-22T19:36:27Z" }] }), "2027-09-22T19:36:27.000Z");
    assert.equal(expiryFromRdap({ events: [] }), undefined);
    assert.equal(expiryFromRdap(null), undefined);
  });

  test("30 days or less warns; renewal date wording says how it was found", () => {
    assert.equal(evalDomain(inDays(30), "looked up", NOW).state, "down");
    assert.equal(evalDomain(inDays(31), "looked up", NOW).state, "up");
    assert.match(evalDomain(inDays(200), "entered", NOW).summary!, /date entered by hand/);
    assert.match(evalDomain(inDays(-2), "looked up", NOW).detail!, /^Domain expired 2 days ago/);
  });

  describe("check (RDAP and the date I enter, FR-I5)", () => {
    const realFetch = globalThis.fetch;
    let rdap: { status: number; body?: unknown };
    const conn = (settings?: Record<string, unknown>): Connection => ({ id: "c", appId: "a", type: "domain", resource: "www.example.org", ...(settings ? { settings } : {}) });
    beforeEach(() => {
      rdap = { status: 200, body: { events: [{ eventAction: "expiration", eventDate: new Date(Date.now() + 200 * DAY).toISOString() }] } };
      globalThis.fetch = (async (input: string | URL | Request) => {
        assert.match(String(input), /^https:\/\/rdap\.org\/domain\/example\.org$/, "asks about the registrable domain");
        return new Response(JSON.stringify(rdap.body ?? {}), { status: rdap.status });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("looked up", async () => {
      const r = await domain.check!(conn());
      assert.equal(r.state, "up");
      assert.doesNotMatch(r.summary!, /by hand/);
    });

    test("not offered: the entered date is used; without one it's unknown, never OK", async () => {
      rdap = { status: 404 };
      const entered = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
      const withDate = await domain.check!(conn({ expiresOn: entered }));
      assert.equal(withDate.state, "up");
      assert.match(withDate.summary!, /by hand/);
      const without = await domain.check!(conn());
      assert.equal(without.state, "unknown");
      assert.match(without.detail!, /Enter the expiry date in this app's Settings/);
    });

    test("a looked-up date wins over an entered one", async () => {
      const soon = new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10);
      const r = await domain.check!(conn({ expiresOn: soon })); // RDAP says 200 days
      assert.equal(r.state, "up");
    });
  });

  test("parse validates the entered date", () => {
    assert.deepEqual(domain.parse({ resource: "Example.org", settings: { expiresOn: "2027-09-22" } }), { resource: "example.org", settings: { expiresOn: "2027-09-22" } });
    assert.throws(() => domain.parse({ resource: "example.org", settings: { expiresOn: "22/09/2027" } }));
    // Dates that don't exist aren't rolled over into the next month.
    assert.throws(() => domain.parse({ resource: "example.org", settings: { expiresOn: "2026-02-30" } }));
    assert.throws(() => domain.parse({ resource: "example.org", settings: { expiresOn: "2027-13-01" } }));
    assert.deepEqual(domain.parse({ resource: "example.org", settings: { expiresOn: "2028-02-29" } }).settings, { expiresOn: "2028-02-29" });
    assert.throws(() => domain.parse({ resource: "not a domain", settings: {} }));
  });
});

describe("supabase", () => {
  test("project statuses", () => {
    assert.deepEqual(describeStatus("ACTIVE_HEALTHY"), { state: "up", text: "Running" });
    assert.equal(describeStatus("INACTIVE").text, "Project is paused");
    assert.equal(describeStatus("PAUSED").state, "down");
    assert.equal(describeStatus("COMING_UP").state, "unknown");
    assert.equal(describeStatus("SOMETHING_NEW").state, "unknown");
  });

  test("unhealthy services are named with their errors", () => {
    assert.deepEqual(unhealthyServices([{ name: "auth", healthy: true }, { name: "db", healthy: false, error: "timeout" }, { name: "rest", healthy: false }]), ["db (timeout)", "rest"]);
  });

  describe("check", () => {
    const realFetch = globalThis.fetch;
    let project: { status: string };
    let health: unknown[];
    let healthStatus: number;
    let calls: string[];
    let methods: string[];
    let db: DatabaseSync;
    let conn: Connection;
    let auth: ReturnType<typeof authFor>;

    beforeEach(() => {
      clearHttpCache();
      calls = [];
      methods = [];
      project = { status: "ACTIVE_HEALTHY" };
      healthStatus = 200;
      health = [{ name: "auth", healthy: true }, { name: "db", healthy: true }, { name: "rest", healthy: true }];
      db = openDb(":memory:");
      const user = store.createUser(db, "Me");
      const service = store.createService(db, user.id, { type: "supabase", name: "My Supabase", secretRef: "PERISKOPOS_TEST_SB_KEY", canWrite: false });
      const app = store.createApp(db, user.id, { name: "A", url: "http://a.example" });
      conn = store.addConnection(db, app, { type: "supabase", serviceId: service.id, resource: "abcdefghijklmnopqrst" });
      auth = authFor(service);
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push(url.pathname + url.search);
        methods.push(init?.method ?? "GET");
        assert.equal((init?.headers as Record<string, string>).authorization, "Bearer sbp_test");
        if (url.pathname === "/v1/projects") return new Response(JSON.stringify([{ id: "abcdefghijklmnopqrst", ref: "abcdefghijklmnopqrst", name: "star", region: "eu-west-1", ...project }]), { status: 200 });
        if (url.pathname.endsWith("/health")) {
          if (healthStatus === 400 && url.searchParams.get("services")!.includes("storage")) return new Response('{"message":"bad services"}', { status: 400 });
          return new Response(JSON.stringify(health), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    test("healthy", async () => {
      const r = await supabase.check!(conn, auth);
      assert.equal(r.state, "up");
      assert.equal(r.summary, "Running · auth, db, rest healthy");
    });

    test("a paused project is down, and health isn't asked", async () => {
      project = { status: "INACTIVE" };
      const r = await supabase.check!(conn, auth);
      assert.equal(r.state, "down");
      assert.equal(r.detail, "Project is paused");
      assert.ok(!calls.some((c) => c.includes("/health")));
    });

    test("an unhealthy service is down, named", async () => {
      health = [{ name: "auth", healthy: false, error: "502" }, { name: "db", healthy: true }];
      const r = await supabase.check!(conn, auth);
      assert.equal(r.state, "down");
      assert.equal(r.detail, "Unhealthy: auth (502)");
    });

    test("an API that rejects some service names is retried with fewer", async () => {
      healthStatus = 400;
      const r = await supabase.check!(conn, auth);
      assert.equal(r.state, "up");
      assert.ok(calls.some((c) => c.includes("services=auth,db,rest") && !c.includes("storage")));
    });

    test("a project the token can't see is unknown", async () => {
      conn = { ...conn, resource: "zzzzzzzzzzzzzzzzzzzz" };
      assert.equal((await supabase.check!(conn, auth)).state, "unknown");
    });

    test("only GET endpoints are used (the token can't be read-only)", async () => {
      await supabase.check!(conn, auth);
      assert.ok(calls.length >= 2, "the project and its health");
      assert.deepEqual([...new Set(methods)], ["GET"]);
    });

    test("an expiry-style incident is a dependency incident: needs attention, not downtime", () => {
      assert.equal(supabase.incidentKind, "dependency");
    });
  });
});

describe("provider status pages (FR-I3)", () => {
  describe("the parts my apps use, and their state", () => {
    // Render lists each product once per region, under a group per region.
    const summary = {
      status: { indicator: "minor", description: "Partial outage" },
      components: [
        { id: "g1", name: "Oregon", group: true },
        { id: "g2", name: "Frankfurt", group: true },
        { id: "w1", name: "Web Services", group_id: "g1", status: "operational" },
        { id: "w2", name: "Web Services", group_id: "g2", status: "partial_outage" },
        { id: "b1", name: "Builds and Deploys", group_id: "g1", status: "degraded_performance" },
        { id: "b2", name: "Builds and Deploys", group_id: "g2", status: "degraded_performance" },
        { id: "r1", name: "Redis", group_id: "g1", status: "major_outage" },
        { id: "x1", name: "Dashboard", status: "under_maintenance" },
        { id: "y1", name: "Odd", status: "something_new" },
      ],
    };

    test("every part is kept with its state and group, its groups aren't", () => {
      const { components } = parseSummary(summary);
      assert.equal(components?.length, 7);
      assert.deepEqual(components?.[1], { name: "Web Services", state: "partial", group: "Frankfurt" });
      assert.deepEqual(components?.find((c) => c.name === "Dashboard"), { name: "Dashboard", state: "maintenance" });
      assert.equal(components?.find((c) => c.name === "Odd")?.state, "unknown");
    });

    test("only the parts in use, once each: the worst state, and where it isn't operational", () => {
      const parts = partsView(parseSummary(summary).components, new Set(["Web Services", "Builds and Deploys", "Not listed"]));
      assert.deepEqual(parts, [
        { name: "Web Services", state: "partial", where: ["Frankfurt"] },
        { name: "Builds and Deploys", state: "degraded", where: ["Oregon", "Frankfurt"] },
      ]);
    });

    test("a provider that names nothing finer shows what it lists, if that's a handful", () => {
      assert.equal(partsView(parseSummary(summary).components, undefined).length, 5, "Web Services and Builds once each, Redis, Dashboard, Odd");
      const many = Array.from({ length: 13 }, (_, i) => ({ name: `Region ${i}`, state: "operational" as const }));
      assert.deepEqual(partsView(many, undefined), []);
      assert.deepEqual(partsView(undefined, new Set(["x"])), []);
    });
  });

  test("a Statuspage summary is parsed; anything odd is 'unknown'", () => {
    assert.deepEqual(parseSummary({ status: { indicator: "none", description: "All Systems Operational" }, incidents: [] }), { components: [], indicator: "none", description: "All Systems Operational", incidents: [], maintenance: [] });
    const minor = parseSummary({ status: { indicator: "minor", description: "Partial outage" }, incidents: [{ name: "Slow builds", impact: "minor", shortlink: "https://stspg.io/x" }] });
    assert.equal(minor.indicator, "minor");
    assert.deepEqual(minor.incidents, [{ name: "Slow builds", impact: "minor", url: "https://stspg.io/x" }]);
    assert.equal(parseSummary({}).indicator, "unknown");
    assert.equal(parseSummary({ status: { indicator: "weird" } }).indicator, "unknown");
  });

  describe("watcher", () => {
    let db: DatabaseSync;
    let notices: Notice[];
    let current: Fetched | Error;
    let fetched: ServiceType[];
    let watcher: Watcher;
    let userId: string;

    beforeEach(() => {
      db = openDb(":memory:");
      notices = [];
      fetched = [];
      current = { indicator: "none", description: "All Systems Operational", incidents: [] };
      userId = store.createUser(db, "Me").id;
      const service = store.createService(db, userId, { type: "render", name: "My Render", secretRef: "X", canWrite: false });
      const app = store.createApp(db, userId, { name: "Star-Map", url: "http://star-map.example" });
      store.addConnection(db, app, { type: "render", serviceId: service.id, resource: "srv-abc" });
      // A GitHub service no app uses is never fetched.
      store.createService(db, userId, { type: "github", name: "Unused", canWrite: false });
      watcher = new Watcher({
        db,
        notifier: { notify: async (n) => void notices.push(n) },
        baseUrl: "http://localhost:4100",
        status: new StatusService(0),
        isOnline: async () => true,
        fetchProvider: async (type) => {
          fetched.push(type);
          if (current instanceof Error) throw current;
          return current;
        },
      });
    });

    test("every account's status page is fetched, once each, also when no app uses it", async () => {
      await watcher.refreshProviders(userId, false, NOW);
      assert.deepEqual([...fetched].sort(), ["github", "render"]);
      await watcher.refreshProviders(userId, false, NOW + 60_000); // too soon
      assert.equal(fetched.length, 2);
      await watcher.refreshProviders(userId, false, NOW + 5 * 60_000);
      assert.equal(fetched.length, 4);
    });

    test("only incidents in the parts my apps use are announced; the rest are listed", async () => {
      await watcher.refreshProviders(userId, false, NOW);
      current = { indicator: "minor", description: "Minor service outage", incidents: [{ name: "Dashboard slow", impact: "minor", parts: ["Render Dashboard"] }] };
      await watcher.refreshProviders(userId, false, NOW + 6 * 60_000);
      assert.equal(notices.length, 0, "the dashboard isn't my app");
      const listed = listProviders(db, userId).find((p) => p.id === "render")!;
      assert.equal(listed.indicator, "minor");
      assert.equal(listed.relevantIndicator, "none");
      assert.equal(listed.incidents[0]!.affectsYou, false);

      current = { indicator: "major", description: "Partial outage", incidents: [{ name: "Deploys stuck", impact: "major", parts: ["Builds and Deploys"] }] };
      await watcher.refreshProviders(userId, false, NOW + 12 * 60_000);
      assert.equal(notices.length, 1);
      assert.equal(notices[0]!.body, "Deploys stuck (Builds and Deploys) · affects Star-Map");
      assert.equal(listProviders(db, userId).find((p) => p.id === "render")!.relevantIndicator, "major");
    });

    test("an account no app uses is listed with its status, never announced", async () => {
      current = { indicator: "critical", description: "Major outage", incidents: [{ name: "Everything down", impact: "critical" }] };
      await watcher.refreshProviders(userId, false, NOW);
      assert.ok(!notices.some((n) => n.title.startsWith("GitHub")));
      const gh = listProviders(db, userId).find((p) => p.id === "github")!;
      assert.deepEqual(gh.apps, []);
      assert.equal(gh.indicator, "critical");
      assert.equal(gh.relevantIndicator, "none");
    });

    test("an incident is announced once, naming my apps; recovery once", async () => {
      await watcher.refreshProviders(userId, false, NOW);
      assert.equal(notices.length, 0, "normal is silent");

      current = { indicator: "major", description: "Major outage", incidents: [{ name: "Deploys failing", impact: "major" }] };
      await watcher.refreshProviders(userId, false, NOW + 6 * 60_000);
      assert.equal(notices.length, 1);
      assert.equal(notices[0].title, "Render reports an incident");
      assert.equal(notices[0].body, "Deploys failing · affects Star-Map");

      await watcher.refreshProviders(userId, false, NOW + 12 * 60_000); // still down: no repeat
      assert.equal(notices.length, 1);

      current = { indicator: "none", description: "All Systems Operational", incidents: [] };
      await watcher.refreshProviders(userId, false, NOW + 18 * 60_000);
      assert.deepEqual(notices.map((n) => n.title), ["Render reports an incident", "Render is back to normal"]);
      assert.ok(notices.every((n) => !n.alarm), "no alarm unless asked for");
    });

    test("with the alarm on, the incident sounds it; the recovery doesn't", async () => {
      updateSettings(db, userId, { incidentAlarm: true });
      await watcher.refreshProviders(userId, false, NOW);
      current = { indicator: "major", description: "Major outage", incidents: [{ name: "Deploys failing", impact: "major" }] };
      await watcher.refreshProviders(userId, false, NOW + 6 * 60_000);
      current = { indicator: "none", description: "All Systems Operational", incidents: [] };
      await watcher.refreshProviders(userId, false, NOW + 12 * 60_000);
      assert.deepEqual(notices.map((n) => [n.title, n.alarm]), [["Render reports an incident", true], ["Render is back to normal", undefined]]);
    });

    test("an incident in a part no app uses sounds no alarm, as it isn't announced", async () => {
      updateSettings(db, userId, { incidentAlarm: true });
      current = { indicator: "minor", description: "Minor", incidents: [{ name: "Dashboard slow", impact: "minor", parts: ["Dashboard"] }] };
      await watcher.refreshProviders(userId, false, NOW);
      assert.deepEqual(notices, []);
    });

    test("maintenance is shown, not announced; an unreachable status page changes nothing", async () => {
      current = { indicator: "maintenance", description: "Scheduled maintenance", incidents: [] };
      await watcher.refreshProviders(userId, false, NOW);
      assert.equal(notices.length, 0);
      const render = () => listProviders(db, userId).find((p) => p.id === "render")!;
      assert.equal(render().indicator, "maintenance", "shown");
      current = new Error("status page down");
      await watcher.refreshProviders(userId, true, NOW + 10 * 60_000);
      assert.ok(fetched.length > 2, "it was asked again");
      assert.equal(notices.length, 0);
      assert.equal(render().indicator, "maintenance", "what was known is kept");
    });
  });
});

describe("expiry incidents (daily checks)", () => {
  let db: DatabaseSync;
  let notices: Notice[];
  let watcher: Watcher;
  let app: App;
  let conn: Connection;
  let daysLeft: number;

  beforeEach(() => {
    db = openDb(":memory:");
    notices = [];
    daysLeft = 60;
    // Half a day of margin: days left round up, so 8½ days reads "9 days"
    // however many milliseconds pass between here and the check. A negative
    // daysLeft is that many days past expiry.
    setCertFetcher(async () => ({ validTo: new Date(Date.now() + daysLeft * DAY - DAY / 2).toISOString(), authorized: true }));
    const user = store.createUser(db, "Me");
    app = store.createApp(db, user.id, { name: "Star-Map", url: "https://star-map.example" });
    conn = app.connections.find((c) => c.type === "ssl")!;
    watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true });
  });
  afterEach(() => setCertFetcher(undefined));

  test("a warning opens on the first check (not held back a day), once", async () => {
    await watcher.checkConnection(app, conn);
    assert.equal(notices.length, 0);
    daysLeft = 9;
    await watcher.checkConnection(app, conn);
    assert.equal(history.openIncidentFor(db, conn.id)?.kind, "expiry");
    assert.deepEqual(notices.map((n) => n.title), ["Star-Map: SSL certificate"]);
    assert.match(notices[0].body, /^Certificate expires in 9 days/);
    await watcher.checkConnection(app, conn);
    assert.equal(notices.length, 1);
  });

  test("renewal closes it and says so; uptime never counts expiry", async () => {
    daysLeft = 3;
    await watcher.checkConnection(app, conn);
    daysLeft = 90;
    await watcher.checkConnection(app, conn);
    assert.equal(notices.at(-1)?.title, "Star-Map: SSL certificate is fine again");
    assert.equal(history.openIncidentFor(db, conn.id), undefined);

    daysLeft = 2;
    await watcher.checkConnection(app, conn); // open again, still serving
    const id = history.startPeriod(db, Date.now() - 3_600_000);
    history.heartbeat(db, id, Date.now());
    assert.equal(history.uptime(db, app.id, Date.now() - 3_600_000, Date.now()).uptimePct, 100);
  });

  test("daily checks stay daily: a tick doesn't re-check a certificate checked minutes ago", async () => {
    let calls = 0;
    setCertFetcher(async () => {
      calls++;
      return { validTo: inDays(60), authorized: true };
    });
    const t = Date.now();
    await watcher.tick(t);
    const first = calls;
    assert.ok(first >= 1);
    await watcher.tick(t + 10 * 60_000);
    assert.equal(calls, first, "not checked again after 10 minutes");
    await watcher.tick(t + DAY + TICK_MS);
    assert.equal(calls, first + 1, "checked again after a day");
  });
});

describe("API: providers and the entered expiry date", () => {
  const TOKEN = "t".repeat(43);
  const BASE = "http://localhost:4100";
  let gc: ReturnType<typeof createApp>;
  let db: DatabaseSync;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    clearHttpCache();
    db = openDb(":memory:");
    const distDir = tempDir("periskopos-web-");
    writeFileSync(path.join(distDir, "index.html"), "");
    const watcher = new Watcher({
      db,
      notifier: { notify: async () => {} },
      baseUrl: BASE,
      status: new StatusService(0),
      isOnline: async () => true,
      fetchProvider: async () => ({ indicator: "minor", description: "Partial outage", incidents: [{ name: "Slow builds", impact: "minor" }] }),
    });
    gc = createApp({ db, token: TOKEN, port: 4100, distDir, watcher });
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as typeof fetch; // RDAP: not offered
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await gc.request(`${BASE}/api${p}`, { method, headers: { "x-periskopos-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
  };

  test("providers lists only those in use, with the apps that depend on them", async () => {
    await call("POST", "/setup", { name: "Me" });
    assert.deepEqual((await call("GET", "/providers")).body.providers, []);
    const svc = (await call("POST", "/services", { type: "render", name: "R", secretRef: "PERISKOPOS_TEST_SB_KEY" })).body.service;
    await call("POST", "/apps", { name: "Star-Map", url: "http://star-map.example" });
    await call("POST", "/apps/star-map/connections", { type: "render", serviceId: svc.id, resource: "srv-abc" });
    const { providers } = (await call("GET", "/providers")).body as { providers: ProviderStatus[] };
    assert.equal(providers.length, 1);
    assert.equal(providers[0].id, "render");
    assert.equal(providers[0].indicator, "minor");
    assert.deepEqual(providers[0].apps, [{ slug: "star-map", name: "Star-Map" }]);
  });

  test("a domain's expiry date can be entered, and only on a domain", async () => {
    await call("POST", "/setup", { name: "Me" });
    await call("POST", "/apps", { name: "Mine", url: "http://mine.example.org" });
    const { app } = (await call("GET", "/apps/mine")).body as { app: App };
    const d = app.connections.find((c) => c.type === "domain")!;
    const entered = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
    assert.equal((await call("PATCH", `/apps/mine/connections/${d.id}`, { expiresOn: entered })).status, 200);
    const after = ((await call("GET", "/apps/mine")).body as { app: App }).app.connections.find((c) => c.type === "domain")!;
    assert.equal(after.settings?.expiresOn, entered);
    assert.equal((await call("PATCH", `/apps/mine/connections/${d.id}`, { expiresOn: "soon" })).status, 400);
    // A status check has settings of its own to edit; an expiry date isn't one.
    const site = app.connections.find((c) => c.type === "site")!;
    assert.equal((await call("PATCH", `/apps/mine/connections/${site.id}`, { expiresOn: entered })).status, 200);
    const siteAfter = ((await call("GET", "/apps/mine")).body as { app: App }).app.connections.find((c) => c.id === site.id)!;
    assert.equal(siteAfter.settings?.expiresOn, undefined);
    const link = (await call("POST", "/apps/mine/connections", { type: "link", resource: "https://x.example", settings: { label: "X" } })).body as { connection: { id: string } };
    assert.equal((await call("PATCH", `/apps/mine/connections/${link.connection.id}`, { expiresOn: entered })).status, 400);
  });

  test("changing the URL adds or drops the certificate and domain checks", async () => {
    await call("POST", "/setup", { name: "Me" });
    await call("POST", "/apps", { name: "Moving", url: "http://localhost:3000" });
    let types = (((await call("GET", "/apps/moving")).body as { app: App }).app.connections).map((c) => c.type);
    assert.deepEqual(types, ["site"]);
    await call("PATCH", "/apps/moving", { url: "https://moving.example.org" });
    types = (((await call("GET", "/apps/moving")).body as { app: App }).app.connections).map((c) => c.type);
    assert.deepEqual(types, ["site", "ssl", "domain"]);
    await call("PATCH", "/apps/moving", { url: "http://localhost:3000" });
    types = (((await call("GET", "/apps/moving")).body as { app: App }).app.connections).map((c) => c.type);
    assert.deepEqual(types, ["site"]);
  });
});

describe("which parts of a provider my apps use", () => {
  const conn = (type: string, settings?: Record<string, unknown>): Connection => ({ id: "c", appId: "a", type, resource: "r", ...(settings ? { settings } : {}) });
  const appWith = (...connections: Connection[]) => ({ connections }) as unknown as App;

  test("a Worker cares about Workers, not WARP; a domain adds DNS, cache and certificates", () => {
    const worker = partsInUse("cloudflare", [appWith(conn("cloudflare", { kind: "worker" }))])!;
    assert.ok(worker.has("Workers") && worker.has("Workers Builds"));
    assert.ok(!affects(["WARP"], worker), "WARP isn't my Worker");
    assert.ok(!affects(["Authoritative DNS"], worker), "no domain connected: DNS isn't mine to watch");
    const withDomain = partsInUse("cloudflare", [appWith(conn("cloudflare", { kind: "worker" }), conn("cloudflare-zone"))])!;
    assert.ok(affects(["Authoritative DNS", "Zero Trust"], withDomain));
    assert.ok(affects(["Pages"], partsInUse("cloudflare", [appWith(conn("cloudflare", {}))])), "no kind is Pages");
  });

  test("an incident that names no parts counts; Supabase counts whole", () => {
    assert.ok(affects(undefined, new Set(["Actions"])));
    assert.ok(affects([], new Set(["Actions"])));
    assert.equal(partsInUse("supabase", []), undefined);
    assert.ok(affects(["eu-west-1"], undefined));
  });

  test("the state for my apps: the worst incident in my parts, or maintenance under way there", () => {
    const inUse = new Set(["Actions"]);
    const f = (incidents: ProviderIncident[], maintenance?: ProviderMaintenance[]) => ({ indicator: "major" as const, description: "x", incidents, ...(maintenance ? { maintenance } : {}) });
    assert.equal(relevantIndicator(f([{ name: "a", impact: "critical", parts: ["Copilot"] }, { name: "b", impact: "minor", parts: ["Actions"] }]), inUse), "minor");
    assert.equal(relevantIndicator(f([{ name: "a", impact: "major", parts: ["Copilot"] }]), inUse), "none");
    assert.equal(relevantIndicator(f([], [{ name: "m", status: "in_progress", parts: ["Actions"] }]), inUse), "maintenance");
    assert.equal(relevantIndicator(f([], [{ name: "m", status: "scheduled", parts: ["Actions"] }]), inUse), "none", "planned isn't happening yet");
  });

  test("parts, status, start and maintenance are read from the summary", () => {
    const parsed = parseSummary({
      status: { indicator: "minor", description: "Minor" },
      incidents: [{ name: "WARP geo", impact: "minor", status: "identified", started_at: "2026-10-17T10:00:00Z", shortlink: "https://stspg.io/x", components: [{ name: "WARP" }] }],
      scheduled_maintenances: [
        { name: "Later", status: "scheduled", scheduled_for: "2026-10-20T06:00:00Z", components: [{ name: "IAD" }] },
        { name: "Sooner", status: "in_progress", scheduled_for: "2026-10-19T06:00:00Z" },
        { name: "Done", status: "completed", scheduled_for: "2026-10-01T06:00:00Z" },
      ],
    });
    assert.deepEqual(parsed.incidents[0], { name: "WARP geo", impact: "minor", url: "https://stspg.io/x", status: "identified", startedAt: "2026-10-17T10:00:00Z", parts: ["WARP"] });
    assert.deepEqual(parsed.maintenance!.map((m) => m.name), ["Sooner", "Later"]);
  });
});
