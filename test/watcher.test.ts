import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import type { App } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { complement, intersect, merge, total } from "../server/intervals.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { updateSettings } from "../server/settings.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { duration } from "../shared/format.ts";
import { STOPPED_AFTER_TICKS, TICK_MS, Watcher, defaultIsOnline, settleLiveChecks } from "../server/watcher.ts";

// A site whose health the test controls.
let healthy = true;
let refusing = false;
let site: ReturnType<typeof createServer>;
let siteUrl = "";
before(async () => {
  site = createServer((_req, res) => {
    res.statusCode = refusing ? 403 : healthy ? 200 : 503;
    res.end();
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  siteUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
});
after(() => site.close());

let db: DatabaseSync;
let notices: Notice[];
let online: boolean;
let watcher: Watcher;
let app: App;
let userId: string;

beforeEach(() => {
  healthy = true;
  refusing = false;
  online = true;
  notices = [];
  db = openDb(":memory:");
  userId = store.createUser(db, "Me").id;
  app = store.createApp(db, userId, { name: "Test App", url: siteUrl });
  watcher = new Watcher({
    db,
    notifier: { notify: async (n) => void notices.push(n) },
    baseUrl: "http://localhost:4100",
    status: new StatusService(0),
    isOnline: async () => online,
  });
});

const site_ = () => app.connections[0];
const check = () => watcher.checkConnection(app, site_());

describe("incidents and notifications (FR-W3, FR-W4)", () => {
  test("one failure is only a failure; the second opens an incident and notifies once", async () => {
    healthy = false;
    const first = await check();
    assert.equal(notices.length, 0);
    assert.equal(history.openIncidentFor(db, site_().id), undefined);

    await check();
    const incident = history.openIncidentFor(db, site_().id);
    assert.ok(incident);
    assert.equal(incident.reason, "Answered HTTP 503");
    assert.equal(incident.startedAt, first!.at, "the outage began at the first failure");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].title, "Test App is down");
    assert.equal(notices[0].url, "http://localhost:4100/#/apps/test-app");

    await check();
    await check();
    assert.equal(notices.length, 1, "no repeat while it stays down");
  });

  test("the first success closes it and notifies once", async () => {
    healthy = false;
    await check();
    await check();
    healthy = true;
    await check();
    await check();
    assert.equal(history.openIncidentFor(db, site_().id), undefined);
    assert.deepEqual(notices.map((n) => n.title), ["Test App is down", "Test App is back up"]);
    assert.match(notices[1].body, /It was down for (\d+ min|under a minute)\./);
  });

  test("a single blip in between successes opens nothing", async () => {
    await check();
    healthy = false;
    await check();
    healthy = true;
    await check();
    assert.equal(notices.length, 0);
  });

  test("notifications can be switched off; incidents are still recorded", async () => {
    updateSettings(db, userId, { notificationsEnabled: false });
    healthy = false;
    await check();
    await check();
    assert.ok(history.openIncidentFor(db, site_().id));
    assert.equal(notices.length, 0);
  });
});

describe("an app that isn't live yet", () => {
  test("its site isn't checked, so a dead site opens no incident and sends nothing", async () => {
    const dead = store.createApp(db, userId, { name: "Soon", url: "http://127.0.0.1:1/", live: false });
    await watcher.tick(Date.parse("2026-10-06T08:00:00Z"));
    await watcher.tick(Date.parse("2026-10-06T08:02:00Z"));
    assert.equal(await watcher.checkConnection(dead, dead.connections[0]), undefined);
    assert.equal(history.latestCheck(db, dead.connections[0].id), undefined);
    assert.equal(notices.length, 0);
  });

  test("launching it makes the checks real", async () => {
    const soon = store.createApp(db, userId, { name: "Soon", url: "http://127.0.0.1:1/", live: false });
    const launched = store.updateApp(db, soon, { live: true });
    await watcher.checkConnection(launched, launched.connections[0]);
    await watcher.checkConnection(launched, launched.connections[0]);
    assert.equal(notices.length, 1);
  });

  test("marking a down app not live ends its outage without a notification", async () => {
    healthy = false;
    await check();
    await check();
    assert.ok(history.openIncidentFor(db, site_().id));
    // Even a duplicate open incident for the same connection is closed.
    history.openIncident(db, { appId: app.id, connectionId: site_().id, kind: "outage", startedAt: new Date().toISOString(), reason: "dup" });
    const before = notices.length;
    const parked = store.updateApp(db, app, { live: false });
    settleLiveChecks(db, parked);
    assert.equal(history.openIncidentFor(db, site_().id), undefined);
    assert.equal(history.openIncidents(db, [app.id]).size, 0);
    assert.equal(notices.length, before);
  });
});

describe("offline PC", () => {
  test("a failure with no answer while this PC is offline doesn't count", async () => {
    const dead = store.createApp(db, userId, { name: "Dead", url: "http://127.0.0.1:1/" });
    online = false;
    const r1 = await watcher.checkConnection(dead, dead.connections[0]);
    const r2 = await watcher.checkConnection(dead, dead.connections[0]);
    assert.equal(r1?.state, "unknown");
    assert.equal(r2?.state, "unknown");
    assert.equal(history.openIncidentFor(db, dead.connections[0].id), undefined);
    assert.equal(notices.length, 0);
  });

  test("an HTTP error is the site's problem even when the probe fails", async () => {
    healthy = false;
    online = false;
    assert.equal((await check())?.state, "down");
  });
});

describe("watch periods and gaps (FR-W6)", () => {
  const T0 = Date.parse("2026-10-06T08:00:00Z");

  test("regular ticks extend one period; a long silence starts a new one", async () => {
    await watcher.tick(T0);
    await watcher.tick(T0 + 30_000);
    await watcher.tick(T0 + 60_000);
    await watcher.tick(T0 + 60 * 60_000); // an hour later: the PC slept
    const periods = db.prepare("SELECT started_at, last_seen_at FROM watch_periods ORDER BY id").all();
    assert.equal(periods.length, 2);
    assert.equal(periods[0].last_seen_at, new Date(T0 + 60_000).toISOString());
  });

  test("switched off means no heartbeat, so the time isn't watched", async () => {
    updateSettings(db, userId, { watcherEnabled: false });
    await watcher.tick(T0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_periods").get()!.n, 0);
  });

  test("offline: no heartbeat until the PC is back", async () => {
    const dead = store.createApp(db, userId, { name: "Dead", url: "http://127.0.0.1:1/" });
    online = false;
    await watcher.checkConnection(dead, dead.connections[0]);
    await watcher.tick(T0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_periods").get()!.n, 0);
    online = true;
    await watcher.tick(T0 + 30_000);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM watch_periods").get()!.n, 1);
  });
});

describe("is this PC online?", () => {
  test("one probe answering is enough; offline only when none does", async () => {
    const dead = "http://127.0.0.1:1/";
    assert.equal(await defaultIsOnline([dead, siteUrl]), true);
    assert.equal(await defaultIsOnline([dead, dead]), false);
  });
});

describe("a site that goes on refusing the check", () => {
  const refusedAt = (minAgo: number) => history.recordCheck(db, app.id, site_().id, { state: "unknown", at: new Date(Date.now() - minAgo * 60_000).toISOString(), httpStatus: 403 });

  test("nothing for the first hour", async () => {
    refusing = true;
    refusedAt(30);
    await check();
    assert.equal(notices.length, 0);
    assert.equal(history.openIncidentFor(db, site_().id), undefined, "still no incident");
  });

  test("told once past the hour, not again, and no incident", async () => {
    refusing = true;
    refusedAt(70);
    await check();
    assert.equal(notices.length, 1);
    assert.equal(notices[0]!.title, "Test App is refusing Periskopos's checks");
    assert.match(notices[0]!.body, /answered HTTP 403 for over an hour/);
    await check();
    assert.equal(notices.length, 1, "no repeat while it goes on");
    assert.equal(history.openIncidentFor(db, site_().id), undefined);
  });

  test("an offline verdict isn't a refusal", async () => {
    healthy = false;
    online = false;
    history.recordCheck(db, app.id, site_().id, { state: "unknown", at: new Date(Date.now() - 70 * 60_000).toISOString(), detail: "This PC is offline, so this check doesn't count" });
    await watcher.checkConnection(app, site_());
    assert.equal(notices.length, 0);
  });
});

describe("how long an outage is said to have lasted", () => {
  test("only the time watched, and it says part wasn't", async () => {
    const H = 3_600_000;
    const now = Date.now();
    history.recordCheck(db, app.id, site_().id, { state: "down", at: new Date(now - 72 * H).toISOString(), detail: "x" });
    history.openIncident(db, { appId: app.id, connectionId: site_().id, kind: "outage", startedAt: new Date(now - 72 * H).toISOString(), reason: "Answered HTTP 503" });
    history.heartbeat(db, history.startPeriod(db, now - 72 * H), now - 72 * H + 10 * 60_000); // watched 10 min, then the PC slept
    history.heartbeat(db, history.startPeriod(db, now - 60_000), now);
    await check();
    const said = notices.at(-1)!;
    assert.equal(said.title, "Test App is back up");
    assert.match(said.body, /^It was down for 1\d min\. Periskopos wasn't watching for another 2 d 23 h/);
  });

  test("watched throughout: just how long", async () => {
    const now = Date.now();
    history.openIncident(db, { appId: app.id, connectionId: site_().id, kind: "outage", startedAt: new Date(now - 10 * 60_000).toISOString(), reason: "Answered HTTP 503" });
    history.heartbeat(db, history.startPeriod(db, now - 20 * 60_000), now);
    await check();
    assert.equal(notices.at(-1)!.body, "It was down for 10 min.");
  });
});

describe("when the checks themselves stop", () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  test("ticks stuck behind a check that never ends are news, once, and so is the recovery", async () => {
    let hold: Promise<void> | undefined;
    class Stuck extends StatusService {
      override async check(...args: Parameters<StatusService["check"]>) {
        await hold;
        return super.check(...args);
      }
    }
    const stuck = new Watcher({
      db,
      notifier: { notify: async (n) => void notices.push(n) },
      baseUrl: "http://localhost:4100",
      status: new Stuck(0),
      isOnline: async () => true,
    });
    const T0 = Date.now();
    await stuck.tick(T0);

    let release = () => {};
    hold = new Promise((resolve) => (release = resolve));
    const later = T0 + 60 * 60_000; // the next check is due, and never ends
    const hung = stuck.tick(later);
    for (let i = 1; i < STOPPED_AFTER_TICKS; i++) await stuck.tick(later + i * TICK_MS);
    assert.equal(stuck.stoppedSince, undefined, "one short of the limit");
    await stuck.tick(later + STOPPED_AFTER_TICKS * TICK_MS);
    assert.equal(stuck.stoppedSince, new Date(T0).toISOString(), "since the last tick that got through");
    await stuck.tick(later + (STOPPED_AFTER_TICKS + 1) * TICK_MS);
    await settle();
    assert.deepEqual(notices.map((n) => n.title), ["Periskopos has stopped checking your apps"]);

    release();
    await hung;
    await settle();
    assert.equal(stuck.stoppedSince, undefined);
    assert.equal(notices.at(-1)?.title, "Periskopos is checking your apps again");
  });

  test("a PC that slept missed no ticks: nothing to say", async () => {
    const T0 = Date.now();
    await watcher.tick(T0);
    await watcher.tick(T0 + 8 * 60 * 60_000);
    assert.equal(watcher.stoppedSince, undefined);
    assert.equal(notices.length, 0);
  });
});

describe("uptime counts watched time only", () => {
  const H = 3_600_000;
  const T0 = Date.parse("2026-10-06T00:00:00Z");

  function period(from: number, to: number) {
    const id = history.startPeriod(db, from);
    history.heartbeat(db, id, to);
  }

  test("an outage while not watched doesn't count; one while watched does", () => {
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(T0).toISOString());
    period(T0, T0 + 10 * H); // watched 10 h
    // Down 1 h inside the watched time, and on through an unwatched night.
    const incident = history.openIncident(db, {
      appId: app.id,
      connectionId: site_().id,
      kind: "outage",
      startedAt: new Date(T0 + 9 * H).toISOString(),
      reason: "x",
    });
    history.closeIncident(db, incident.id, new Date(T0 + 20 * H).toISOString());
    const { uptimePct, watchedMs } = history.uptime(db, app.id, T0, T0 + 24 * H, T0 + 24 * H);
    assert.equal(watchedMs, 10 * H);
    assert.equal(uptimePct, 90);
  });

  test("an app added or gone live an hour ago has an hour of uptime, not a month", () => {
    const now = T0 + 30 * 24 * H;
    period(T0, now);
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(T0).toISOString());
    history.recordCheck(db, app.id, site_().id, { state: "up", at: new Date(now - H).toISOString() });
    assert.equal(history.uptime(db, app.id, T0, now, now).watchedMs, H, "from the site's first check");
    db.prepare("DELETE FROM checks").run();
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(now - 2 * H).toISOString());
    assert.equal(history.uptime(db, app.id, T0, now, now).watchedMs, 2 * H, "from when it was added");
    assert.equal(history.appHistory(db, app.id, now).watchedMin, 120, "the history page agrees");
  });

  test("while the site's checks couldn't tell, it's neither up nor down", () => {
    const now = T0 + 10 * H;
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(T0).toISOString());
    period(T0, now);
    const record = (state: "up" | "unknown", at: number) => history.recordCheck(db, app.id, site_().id, { state, at: new Date(at).toISOString() });
    record("up", T0);
    record("unknown", T0 + 2 * H);
    record("unknown", T0 + 3 * H);
    record("up", T0 + 5 * H);
    record("unknown", T0 + 9 * H);
    assert.equal(history.uptime(db, app.id, T0, now, now).watchedMs, 6 * H, "3 h, and the last hour still can't tell");
    const gaps = history.appHistory(db, app.id, now).gaps;
    assert.ok(gaps.every((g) => Date.parse(g.from) >= now), "it's not time the watcher wasn't running");
  });

  test("never watched: no uptime figure at all", () => {
    assert.equal(history.uptime(db, app.id, T0, T0 + H, T0 + H).uptimePct, undefined);
  });

  test("history lists gaps and per-day figures", () => {
    const now = Date.now();
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(now - 10 * H).toISOString());
    period(now - 5 * H, now - 3 * H);
    period(now - H, now);
    const h = history.appHistory(db, app.id, now, 30);
    assert.equal(h.days.length, 30);
    assert.ok(h.gaps.some((g) => Date.parse(g.to) - Date.parse(g.from) === 2 * H));
    // The earliest gap starts when the app was added, not 30 days back.
    assert.equal(Date.parse(h.gaps.at(-1)!.from), now - 10 * H);
    assert.equal(h.uptimePct, 100);
  });
});

describe("days across a clock change", () => {
  test("30 days of history are 30 calendar days, even over a 23-hour day", () => {
    const tz = process.env.TZ;
    process.env.TZ = "America/New_York"; // clocks went forward on 8 March 2026
    try {
      const now = new Date(2026, 3, 6, 0, 30).getTime(); // 6 April, half past midnight
      assert.equal(new Date(history.localDaysBefore(now, 29)).getDate(), 8);
      const h = history.appHistory(db, app.id, now, 30);
      assert.equal(h.days.length, 30);
      assert.equal(h.days[0].day, "2026-03-08");
      assert.equal(h.days.at(-1)!.day, "2026-04-06");
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe("intervals", () => {
  test("merge, intersect, complement, total", () => {
    assert.deepEqual(merge([[5, 8], [1, 3], [2, 4]]), [[1, 4], [5, 8]]);
    assert.deepEqual(intersect([[0, 10]], [[2, 3], [8, 12]]), [[2, 3], [8, 10]]);
    assert.deepEqual(complement([[2, 3], [5, 6]], 0, 10), [[0, 2], [3, 5], [6, 10]]);
    assert.equal(total([[0, 2], [1, 5]]), 5);
  });

  test("durations read naturally", () => {
    assert.equal(duration(20_000), "under a minute");
    assert.equal(duration(Number.NaN), "under a minute");
    assert.equal(duration(30_000), "1 min");
    assert.equal(duration(14 * 60_000), "14 min");
    assert.equal(duration(125 * 60_000), "2 h 5 min");
    assert.equal(duration(27 * 3_600_000), "1 d 3 h");
  });
});

describe("roll-up and pruning (FR-W2)", () => {
  test("finished days are summarized once; old checks are pruned", () => {
    const now = Date.now();
    db.prepare("UPDATE apps SET created_at = ?").run(new Date(now - 40 * 86_400_000).toISOString());
    history.recordCheck(db, app.id, site_().id, { state: "up", at: new Date(now - 35 * 86_400_000).toISOString(), ms: 10 });
    history.recordCheck(db, app.id, site_().id, { state: "up", at: new Date(now - 2 * 86_400_000).toISOString(), ms: 10 });
    history.rollUp(db, now);
    history.rollUp(db, now);
    const n = db.prepare("SELECT COUNT(*) AS n FROM daily_summaries").get()!.n as number;
    assert.equal(n, 29, "the 29 finished days still covered by raw checks");
    history.prune(db, now);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checks").get()!.n, 1);
  });
});
