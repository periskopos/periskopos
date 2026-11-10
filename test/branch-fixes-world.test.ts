import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { appHistory, closeIncident, endedSince, heartbeat, openIncident, setFalseAlarm, startPeriod } from "../server/history.ts";
import { openDb } from "../server/db.ts";
import * as store from "../server/store.ts";
import type { App, AppHistory, AppState, AppStatus, DeployState, NotificationsView, WatcherLog } from "../shared/types.ts";
import { growthSince, parseSeen, seenNow } from "../shared/valley/growth.ts";
import { valleyPlan } from "../shared/valley/plan.ts";
import { checksLately, tripsFor, valleyStats } from "../shared/valley/trips.ts";
import { buildWorld, changesBetween, feedRows, placeApps, stateAt, worldAt } from "../shared/world.ts";
import type { Plot, World } from "../shared/world.ts";
import { servicePlacesFrom } from "../web/src/views/world/saved.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const app = (slug: string, name = slug.toUpperCase()) => ({ slug, name, connections: [{}] }) as unknown as App;
const status = (slug: string, state: AppState, deploy?: DeployState["state"]): AppStatus => ({ slug, state, checks: {}, ...(deploy ? { deploy: { state: deploy } } : {}) });
const worldOf = (rows: [string, AppState, DeployState["state"]?][], extra: Partial<Parameters<typeof buildWorld>[0]> = {}) =>
  buildWorld({ apps: rows.map(([s]) => app(s)), statuses: new Map(rows.map(([s, state, deploy]) => [s, status(s, state, deploy)])), providers: [], now: NOW, ...extra });

describe("places", () => {
  test("an app called constructor gets a real place", () => {
    const places = placeApps(["constructor", "to-string"], {});
    assert.deepEqual(places, { constructor: 0, "to-string": 1 });
    const w = buildWorld({ apps: [app("constructor")], statuses: new Map(), providers: [], places: {}, now: NOW });
    assert.ok(Number.isFinite(w.plots[0]!.x));
  });

  test("a place far past any real one is ignored, so the road isn't built for ever", () => {
    assert.deepEqual(placeApps(["a"], { a: 10_000_000 }), { a: 0 });
    assert.deepEqual(placeApps(["a"], { a: 9 }), { a: 9 }, "an ordinary place after others were removed stays");
    const w = worldOf([["a", "up"]], { places: placeApps(["a"], { a: 10_000_000 }) });
    assert.ok(Number.isFinite(valleyPlan(w).minX));
  });

  test("a new service doesn't take the place of one this read doesn't mention", () => {
    const places = servicePlacesFrom({ "service:neon": 0, "service:render": 1 }, ["render", "vercel"]);
    assert.equal(places.neon, 0);
    assert.equal(places.render, 1);
    assert.equal(places.vercel, 2);
  });
});

describe("the dish", () => {
  test("an app still saying it's down doesn't mean anything's watching", () => {
    assert.equal(worldOf([["a", "down"]]).watching, true);
    const halted = worldOf([["a", "down"]], { watcherStopped: true });
    assert.deepEqual([halted.watching, halted.stopped], [false, true]);
  });
});

describe("replay", () => {
  const at = (hour: number) => new Date(Date.parse("2026-11-06T00:00:00Z") + hour * 3_600_000).toISOString();
  const record = (over: Partial<AppHistory> = {}): AppHistory => ({ from: at(0), to: at(12), watchedMin: 60, incidents: [], gaps: [], watched: [{ from: at(4), to: at(6) }, { from: at(8), to: at(12) }], days: [], ...over });
  const when = (hour: number) => Date.parse(at(hour));

  test("before the app was watched isn't up", () => {
    assert.deepEqual(stateAt(record(), when(2), "up"), { state: "unknown", reason: "It wasn't being watched yet" });
  });
  test("a stretch its checks couldn't tell isn't up", () => {
    assert.deepEqual(stateAt(record(), when(7), "up"), { state: "unknown", reason: "The record doesn't say how it was then" });
  });
  test("a watched stretch is up, right to the moment the record was read and just after", () => {
    assert.deepEqual(stateAt(record(), when(5), "up"), { state: "up" });
    assert.deepEqual(stateAt(record(), when(12) + 2000, "up"), { state: "up" });
  });
  test("an incident on the record still counts where the checks couldn't tell", () => {
    const incidents = [{ id: "i", appId: "a", kind: "outage" as const, startedAt: at(6), endedAt: at(9), reason: "Down" }];
    assert.equal(stateAt(record({ incidents }), when(7), "up").state, "down");
  });
  test("what was read about pushes isn't carried into the past", () => {
    const live = worldOf([["a", "up", "live"]]);
    assert.equal(live.plots[0]!.deploy, "live");
    assert.equal("deploy" in worldAt(live, new Map([["a", record()]]), when(5)).plots[0]!, false);
  });

  test("the history says which stretches can speak", () => {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    const a = store.createApp(db, me, { name: "A", url: "https://a.example.org" });
    const started = Date.now() - 3_600_000; // before the app was added: not its record
    const period = startPeriod(db, started);
    const now = Date.now() + 60_000;
    heartbeat(db, period, now);
    const h = appHistory(db, a.id, now);
    assert.equal(h.watched.length, 1);
    assert.ok(Date.parse(h.watched[0]!.from) > started);
    assert.equal(h.watched[0]!.to, h.to);
  });
});

describe("what the feed says", () => {
  const plot = (slug: string, name: string, work: Plot["work"] = null, deploy?: DeployState["state"]): Plot => ({ slug, name, state: "up", look: "lit", moving: true, floors: 1, work, x: 0, y: 0, turn: 0, ...(deploy ? { deploy } : {}) });
  const worldWith = (plots: Plot[], utilities: World["utilities"] = []): World => ({ plots, utilities, watching: true, stopped: false, watcher: { x: 0, y: 0, turn: 0 }, failed: false });
  const utility = (look: World["utilities"][number]["look"]) => ({ id: "render", label: "Render", look, description: "", apps: [], x: 0, y: 0, turn: 0 });

  test("a push is only live when it's read as live", () => {
    const before = worldWith([plot("a", "A", "deploying")]);
    assert.equal(changesBetween(before, worldWith([plot("a", "A", null, "live")]), 1)[0]?.text, "finished deploying");
    assert.deepEqual(changesBetween(before, worldWith([plot("a", "A", null, "unknown")]), 1), []);
    assert.deepEqual(changesBetween(before, worldWith([plot("a", "A")]), 1), []);
    assert.equal(changesBetween(worldWith([plot("a", "A", "waiting")]), worldWith([plot("a", "A", null, "live")]), 1)[0]?.text, "has its push live");
    assert.deepEqual(changesBetween(worldWith([plot("a", "A", "waiting")]), worldWith([plot("a", "A", null, "unknown")]), 1), []);
  });

  test("a provider is only fine again if it wasn't", () => {
    const change = (from: World["utilities"][number]["look"], to: World["utilities"][number]["look"]) => changesBetween(worldWith([], [utility(from)]), worldWith([], [utility(to)]), 1)[0]?.text;
    assert.equal(change("trouble", "ok"), "is fine again");
    assert.equal(change("maintenance", "ok"), "is fine again");
    assert.equal(change("unknown", "ok"), undefined);
  });

  test("two apps of one name keep their own rows", () => {
    const view: NotificationsView = { now: [{ state: "down", title: "Shop", text: "Site is down", href: "#/apps/shop-eu", since: new Date(NOW).toISOString() }], earlier: [], accountsRead: true };
    const plots = [plot("shop-us", "Shop"), plot("shop-eu", "Shop")];
    assert.deepEqual(feedRows([], view, plots)[0]?.target, { kind: "app", id: "shop-eu" });
    const live = [{ key: "app:shop-us", kind: "app" as const, id: "shop-us", name: "Shop", text: "went down", state: "down" as const, at: NOW }];
    assert.equal(feedRows(live, view, plots).length, 2, "the other one's change isn't taken for this");
  });

  test("a false alarm didn't recover from anything", () => {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    const a = store.createApp(db, me, { name: "A", url: "https://a.example.org" });
    const real = openIncident(db, { appId: a.id, connectionId: a.connections[0]!.id, kind: "outage", startedAt: new Date(NOW - 3000).toISOString(), reason: "Real" });
    const wrong = openIncident(db, { appId: a.id, connectionId: a.connections[0]!.id, kind: "outage", startedAt: new Date(NOW - 2000).toISOString(), reason: "Wrong" });
    closeIncident(db, real.id, new Date(NOW - 1000).toISOString());
    closeIncident(db, wrong.id, new Date(NOW - 1000).toISOString());
    setFalseAlarm(db, a.id, wrong.id, true);
    assert.deepEqual(endedSince(db, [a.id], NOW - 10_000).map((i) => i.reason), ["Real"]);
  });
});

describe("what's grown", () => {
  const seeing = (look: Plot["look"], floors = 2) => [{ slug: "a", look, floors }];

  test("fog isn't built: a place that was seen stands, and comes back without rising", () => {
    const first = seenNow(null, seeing("lit"), "orchards");
    assert.equal(growthSince(first, seeing("fog")).plots.size, 0);
    const during = seenNow(first, seeing("fog", 9), "orchards");
    assert.deepEqual(during.plots.a, first.plots.a, "not knowing changes nothing that was known");
    assert.equal(growthSince(during, seeing("lit")).plots.size, 0);
  });

  test("a new app in the fog rises when it's known, not before", () => {
    const empty = seenNow(null, [], "orchards");
    assert.equal(growthSince(empty, seeing("fog")).plots.size, 0);
    assert.equal(growthSince(seenNow(empty, seeing("fog"), "orchards"), seeing("lit")).plots.get("a")?.rise, true);
  });

  test("an app called constructor isn't taken for one already seen", () => {
    const empty = seenNow(null, [], "orchards");
    assert.equal(growthSince(empty, [{ slug: "constructor", look: "lit", floors: 1 }]).plots.get("constructor")?.rise, true);
  });

  test("what's remembered has to be the right shape", () => {
    assert.equal(parseSeen({ stage: "town", plots: [] }), null);
    assert.equal(parseSeen({ stage: "town", plots: { a: { floors: 1, built: true, size: "huge" } } }), null);
    assert.ok(parseSeen({ stage: "town", plots: { a: { floors: 1, built: true, size: "large" } } }));
  });
});

describe("what's on the road", () => {
  const row = (slug: string, i: number): WatcherLog["checks"][number] => ({ at: new Date(NOW - 1000 - i).toISOString(), state: "up", slug, app: slug, what: `Check ${i}` });

  test("every recent check is counted, though only so many vans fit", () => {
    const w = worldOf([["a", "up"]]);
    const checks = Array.from({ length: 30 }, (_, i) => row("a", i));
    const trips = tripsFor({ world: w, plan: valleyPlan(w), checks, now: NOW });
    const stats = valleyStats(w, new Map(), trips, checksLately({ world: w, checks, now: NOW }));
    assert.equal(stats.checks, 30);
    assert.equal(stats.vans, 16);
  });

  test("not watching, nothing's counted", () => {
    const w = worldOf([["a", "stale"]]);
    assert.equal(checksLately({ world: w, checks: [row("a", 0)], now: NOW }), 0);
  });

  test("short of room, more requests still means more cars", () => {
    const slugs = Array.from({ length: 60 }, (_, i) => `a${i}`);
    const requests = new Map(slugs.map((s, i) => [s, i === 0 ? 1_000_000 : 10]));
    const w = buildWorld({ apps: slugs.map((s) => app(s)), statuses: new Map(slugs.map((s) => [s, status(s, "up")])), providers: [], requests, now: NOW });
    const trips = tripsFor({ world: w, plan: valleyPlan(w), checks: [], now: NOW });
    const cars = (slug: string) => trips.filter((t) => t.slug === slug && t.facts.kind === "traffic").length;
    assert.ok(cars("a0") > cars("a1"), `${cars("a0")} against ${cars("a1")}`);
    assert.ok(cars("a1") >= 1);
    assert.ok(trips.length <= 130, String(trips.length));
    const facts = trips.find((t) => t.slug === "a1")!.facts;
    assert.equal(facts.kind === "traffic" && facts.cars, cars("a1"), "it says how many there really are");
  });

  test("the lowest uptime brings what it rests on", () => {
    const statuses = new Map([["a", { ...status("a", "up"), uptime30d: 99, uptimeWatchedMs: 5000 }], ["b", { ...status("b", "up"), uptime30d: 100, uptimeWatchedMs: 9e9 }]]);
    const stats = valleyStats(worldOf([["a", "up"], ["b", "up"]]), statuses, []);
    assert.deepEqual([stats.lowestUptime, stats.lowestUptimeWatchedMs], [99, 5000]);
  });
});
