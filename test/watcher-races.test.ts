import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { AppIcons } from "../server/icons.ts";
import { setCertFetcher } from "../server/integrations/ssl.ts";
import type { Notice } from "../server/alerts/notify.ts";
import type { Fetched } from "../server/providers.ts";
import { store_ as storeProvider } from "../server/providers.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";

// The watcher when things happen at once, or long apart: duplicate checks,
// stale confirmations, providers flickering, and a URL that moved. Every
// network call is faked.

const DAY = 86_400_000;
const realFetch = globalThis.fetch;

let db: DatabaseSync;
let notices: Notice[];
let userId: string;
let healthy: boolean;
let siteCalls: string[];
let current: Fetched;
let providerFetches: number;

const watcherFor = () =>
  new Watcher({
    db,
    notifier: { notify: async (n) => void notices.push(n) },
    baseUrl: "http://localhost:4100",
    status: new StatusService(0),
    isOnline: async () => true,
    fetchProvider: async () => {
      providerFetches++;
      // Slow enough that a second caller arrives while this one is out.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return current;
    },
  });

beforeEach(() => {
  db = openDb(":memory:");
  notices = [];
  healthy = true;
  siteCalls = [];
  providerFetches = 0;
  current = { indicator: "none", description: "All Systems Operational", incidents: [] };
  userId = store.createUser(db, "Me").id;
  globalThis.fetch = (async (input: string | URL | Request) => {
    siteCalls.push(String(input instanceof Request ? input.url : input));
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response("", { status: healthy ? 200 : 503 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  setCertFetcher(undefined);
});

describe("confirming a failure", () => {
  test("a down check from days ago doesn't confirm a new failure or backdate it", async () => {
    const app = store.createApp(db, userId, { name: "Old", url: "http://old.test/" });
    const site = app.connections[0];
    history.recordCheck(db, app.id, site.id, { state: "down", at: new Date(Date.now() - 10 * DAY).toISOString(), httpStatus: 503 });
    const watcher = watcherFor();
    healthy = false;

    await watcher.checkConnection(app, site);
    assert.equal(history.openIncidentFor(db, site.id), undefined, "one fresh failure is only a failure");
    assert.equal(notices.length, 0);

    await watcher.checkConnection(app, site);
    const incident = history.openIncidentFor(db, site.id);
    assert.ok(incident);
    assert.ok(Date.now() - Date.parse(incident.startedAt) < 60_000, "dated from the recent failure, not 10 days back");
    assert.equal(notices.length, 1);
  });

  test("the tick and Check now at the same moment record one check, which doesn't confirm itself", async () => {
    const app = store.createApp(db, userId, { name: "Twice", url: "http://twice.test/" });
    const site = app.connections[0];
    const watcher = watcherFor();
    healthy = false;

    const [a, b] = await Promise.all([watcher.checkConnection(app, site), watcher.checkConnection(app, site)]);
    assert.equal(a, b);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get()!.n, 1);
    assert.equal(history.openIncidentFor(db, site.id), undefined);
    assert.equal(notices.length, 0);
  });
});

describe("provider status pages", () => {
  beforeEach(() => {
    const service = store.createService(db, userId, { type: "render", name: "My Render", secretRef: "X", canWrite: false });
    const app = store.createApp(db, userId, { name: "Star-Map", url: "http://star-map.test" });
    store.addConnection(db, app, { type: "render", serviceId: service.id, resource: "srv-abc" });
  });

  const major: Fetched = { indicator: "major", description: "Major outage", incidents: [{ name: "Deploys failing", impact: "major" }] };
  const maintenance: Fetched = { indicator: "maintenance", description: "Scheduled maintenance", incidents: [] };

  test("overlapping refreshes (two windows and a tick) fetch once and announce once", async () => {
    const watcher = watcherFor();
    current = major;
    await Promise.all([watcher.refreshProviders(userId, true), watcher.refreshProviders(userId, true), watcher.refreshProviders(userId, false)]);
    assert.equal(providerFetches, 1);
    assert.deepEqual(notices.map((n) => n.title), ["Render reports an incident"]);
  });

  test("degraded → maintenance → normal still announces the recovery", async () => {
    const watcher = watcherFor();
    for (const f of [major, maintenance, current]) {
      current = f;
      await watcher.refreshProviders(userId, true);
    }
    assert.deepEqual(notices.map((n) => n.title), ["Render reports an incident", "Render is back to normal"]);
  });

  test("degraded → maintenance → degraded doesn't announce the same trouble twice", async () => {
    const watcher = watcherFor();
    for (const f of [major, maintenance, major]) {
      current = f;
      await watcher.refreshProviders(userId, true);
    }
    assert.deepEqual(notices.map((n) => n.title), ["Render reports an incident"]);
  });

  test("an incident stored before a restart counts as announced", async () => {
    storeProvider(db, "render", major, new Date(Date.now() - DAY).toISOString());
    const watcher = watcherFor();
    current = major;
    await watcher.refreshProviders(userId, true);
    assert.equal(notices.length, 0);
    current = { indicator: "none", description: "All Systems Operational", incidents: [] };
    await watcher.refreshProviders(userId, true);
    assert.deepEqual(notices.map((n) => n.title), ["Render is back to normal"]);
  });
});

describe("certificate expiry escalates", () => {
  test("expiring soon, then expired: the expiry is notified as its own incident", async () => {
    let daysLeft = 5;
    setCertFetcher(async () => ({ validTo: new Date(Date.now() + daysLeft * DAY - DAY / 2).toISOString(), authorized: true }));
    const app = store.createApp(db, userId, { name: "Star-Map", url: "https://star-map.test" });
    const ssl = app.connections.find((c) => c.type === "ssl")!;
    const watcher = watcherFor();

    await watcher.checkConnection(app, ssl);
    const warning = history.openIncidentFor(db, ssl.id);
    assert.match(warning!.reason, /expires in 5 days/);

    daysLeft = 0; // expired half a day ago
    await watcher.checkConnection(app, ssl);
    const expired = history.openIncidentFor(db, ssl.id);
    assert.ok(expired && expired.id !== warning!.id);
    assert.match(expired.reason, /^Certificate expired today/);
    assert.deepEqual(notices.map((n) => n.body.replace(/ \(.*/, "")), ["Certificate expires in 5 days", "Certificate expired today"]);

    await watcher.checkConnection(app, ssl);
    assert.equal(notices.length, 2, "no repeat while it stays expired");
  });
});

describe("changing an app's URL", () => {
  test("ends the old host's incidents quietly, and checks the new host at once", async () => {
    const hosts: string[] = [];
    setCertFetcher(async (host) => {
      hosts.push(host);
      return { validTo: new Date(Date.now() + 90 * DAY).toISOString(), authorized: true };
    });
    const app = store.createApp(db, userId, { name: "Moving", url: "https://one.test/" });
    const site: Connection = app.connections.find((c) => c.type === "site")!;
    const watcher = watcherFor();
    healthy = false;
    await watcher.checkConnection(app, site);
    await watcher.checkConnection(app, site);
    assert.ok(history.openIncidentFor(db, site.id));
    await watcher.checkApp(app);
    assert.deepEqual(hosts, ["one.test"]);
    const before = notices.length;

    const moved: App = store.updateApp(db, app, { url: "https://two.test/" });
    assert.equal(history.openIncidentFor(db, site.id), undefined, "the old host's outage is over");
    assert.equal(notices.length, before, "without a notification");

    healthy = true;
    siteCalls = [];
    await watcher.checkApp(moved, true); // only what hasn't been checked
    assert.deepEqual(hosts, ["one.test", "two.test"], "the daily certificate check doesn't wait a day");
    assert.deepEqual(siteCalls, ["https://two.test/"]);
  });

  test("the old host's failure doesn't confirm the new host's first one", async () => {
    setCertFetcher(async () => ({ validTo: new Date(Date.now() + 90 * DAY).toISOString(), authorized: true }));
    const app = store.createApp(db, userId, { name: "Moving", url: "https://one.test/" });
    const site: Connection = app.connections.find((c) => c.type === "site")!;
    const watcher = watcherFor();
    healthy = false;
    await watcher.checkConnection(app, site); // one failure of the old host, moments ago
    const moved: App = store.updateApp(db, app, { url: "https://two.test/" });
    const newSite = moved.connections.find((c) => c.id === site.id)!;

    await watcher.checkConnection(moved, newSite); // the new host fails once
    assert.equal(history.openIncidentFor(db, site.id), undefined, "one failure of the new host is only one");
    await watcher.checkConnection(moved, newSite); // and again: now it's confirmed
    const opened = history.openIncidentFor(db, site.id);
    assert.ok(opened);
    assert.equal(notices.filter((n) => /failing|down/i.test(n.title)).length, 1);
  });
});

describe("deleted or changed while a check is out", () => {
  test("an app deleted mid-check: nothing recorded, no failure, no notice", async () => {
    const app = store.createApp(db, userId, { name: "Gone", url: "http://gone.test/" });
    const watcher = watcherFor();
    healthy = false;
    const pending = watcher.checkConnection(app, app.connections[0]);
    store.deleteApp(db, app);
    assert.equal(await pending, undefined);
    assert.equal(notices.length, 0);
  });

  test("an app marked not live yet mid-check: its failure doesn't open an incident", async () => {
    const app = store.createApp(db, userId, { name: "Soon", url: "http://soon.test/" });
    const site = app.connections[0];
    const watcher = watcherFor();
    healthy = false;
    await watcher.checkConnection(app, site); // the first failure
    const pending = watcher.checkConnection(app, site); // would confirm it
    store.updateApp(db, app, { live: false });
    assert.equal(await pending, undefined);
    assert.equal(history.openIncidentFor(db, site.id), undefined);
    assert.equal(notices.length, 0);
  });

  test("an app deleted while its icon is fetched: no crash, nothing stored", async () => {
    const app = store.createApp(db, userId, { name: "Icon", url: "http://icon.test/" });
    let release!: () => void;
    const icons = new AppIcons({ db, fetchIcon: () => new Promise((resolve) => (release = () => resolve({ type: "image/png", data: new Uint8Array([1]) }))) });
    const pending = icons.refresh(app);
    store.deleteApp(db, app);
    release();
    await pending; // used to throw: FOREIGN KEY constraint failed
    assert.equal(store.getAppIcon(db, app.id), undefined);
  });
});
