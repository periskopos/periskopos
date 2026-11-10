import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { App, AppState, AppStatus, DeployState, ProviderStatus } from "../shared/types.ts";
import { unbend } from "../shared/valley/lay.ts";
import { antennaLight, buildWorld, carsFor, changesBetween, duskAt, stateAt, worldAt, chooseLabels, feedRows, campusSize, LOWEST_DETAIL, newPace, stageRose, worldStage, nudgeLabels, paceAfter, placeApps, radarBlips, slotAt, utilityLook } from "../shared/world.ts";

const NOW = Date.parse("2026-11-04T12:00:00Z");
const app = (slug: string, connections = 1) => ({ slug, name: slug.toUpperCase(), connections: Array.from({ length: connections }) }) as App;
const status = (slug: string, state: AppState, deploy?: DeployState["state"]): AppStatus => ({ slug, state, checks: {}, ...(deploy ? { deploy: { state: deploy } } : {}) });
const provider = (over: Partial<ProviderStatus>) =>
  ({ id: "render", label: "Render", description: "", relevantIndicator: "none", checkedAt: new Date(NOW - 60_000).toISOString(), apps: [{ slug: "a", name: "A" }], ...over }) as ProviderStatus;
const world = (states: Record<string, AppState>, extra: Partial<Parameters<typeof buildWorld>[0]> = {}) =>
  buildWorld({
    apps: Object.keys(states).map((s) => app(s)),
    statuses: new Map(Object.entries(states).map(([slug, state]) => [slug, status(slug, state)])),
    providers: [],
    now: NOW,
    ...extra,
  });

describe("the world says only what the data says", () => {
  test("every state has its own look, and only a serving app shows life", () => {
    const { plots } = world({ a: "up", b: "attention", c: "down", d: "unknown", e: "stale", f: "none", g: "prelaunch" });
    assert.deepEqual(plots.map((p) => p.look), ["lit", "warning", "dark", "fog", "frozen", "empty", "scaffold"]);
    assert.deepEqual(plots.map((p) => p.moving), [true, true, false, false, false, false, false]);
  });

  test("an app not read yet is in the fog, not lit", () => {
    const { plots } = buildWorld({ apps: [app("a")], statuses: new Map(), providers: [], now: NOW });
    assert.equal(plots[0]!.state, "checking");
    assert.equal(plots[0]!.look, "fog");
    assert.equal(plots[0]!.moving, false);
  });

  test("a failed read fogs everything, whatever was known before", () => {
    const w = world({ a: "up", b: "down" }, { readFailed: true, providers: [provider({})] });
    assert.deepEqual(w.plots.map((p) => p.look), ["fog", "fog"]);
    assert.equal(w.utilities[0]!.look, "unknown");
    assert.equal(w.watching, false);
  });

  test("the dish only watches while checks are really running", () => {
    assert.equal(world({ a: "up", b: "stale" }).watching, true);
    assert.equal(world({ a: "stale", b: "stale" }).watching, false);
    assert.equal(world({ a: "stale", b: "prelaunch" }).watching, false, "an app not live yet is nothing being watched");
  });

  test("not knowing yet is neither watching nor stopped", () => {
    const unread = buildWorld({ apps: [app("a")], statuses: new Map(), providers: [], now: NOW });
    assert.deepEqual([unread.watching, unread.stopped], [false, false]);
    const unknown = world({ a: "unknown" });
    assert.deepEqual([unknown.watching, unknown.stopped], [false, false]);
    const nothing = world({});
    assert.deepEqual([nothing.watching, nothing.stopped], [false, false], "no apps is nothing to watch, not a fault");
    const failed = world({ a: "up" }, { readFailed: true });
    assert.deepEqual([failed.watching, failed.stopped], [false, false]);
  });

  test("the dish has stopped when every check has, or they're turned off", () => {
    assert.equal(world({ a: "stale" }).stopped, true);
    const off = world({ a: "up" }, { checksOff: true });
    assert.deepEqual([off.watching, off.stopped], [false, true], "an app still looks fresh for a while after checks are turned off");
  });

  test("an antenna has a light only for what's known, and the worse it is the faster", () => {
    assert.deepEqual(["fog", "frozen", "empty", "scaffold", "unknown", "past"].map((look) => antennaLight(look as "fog")), [null, null, null, null, null, null]);
    assert.equal(antennaLight("lit")?.tone, "up");
    assert.equal(antennaLight("ok")?.tone, "up");
    assert.equal(antennaLight("warning")?.tone, "attention");
    assert.equal(antennaLight("dark")?.tone, "down");
    assert.equal(antennaLight("trouble")?.tone, "down");
    assert.equal(antennaLight("maintenance")?.tone, "info");
    assert.ok(antennaLight("dark")!.every < antennaLight("warning")!.every && antennaLight("warning")!.every < antennaLight("lit")!.every);
  });

  test("a deploy shows only where the app is known to be serving", () => {
    const of = (state: AppState, deploy: DeployState["state"]) =>
      buildWorld({ apps: [app("a")], statuses: new Map([["a", status("a", state, deploy)]]), providers: [], now: NOW }).plots[0]!.work;
    assert.equal(of("up", "deploying"), "deploying");
    assert.equal(of("attention", "not-deployed"), "waiting");
    assert.equal(of("up", "live"), null);
    assert.equal(of("stale", "deploying"), null, "hours-old news of a deploy isn't a deploy");
    assert.equal(of("down", "deploying"), null);
  });

  test("floors count what's watched, within limits", () => {
    const floors = (n: number) => buildWorld({ apps: [app("a", n)], statuses: new Map(), providers: [], now: NOW }).plots[0]!.floors;
    assert.deepEqual([0, 1, 3, 7, 40].map(floors), [1, 1, 3, 7, 10]);
  });
});

describe("a sign needs to know whose it is", () => {
  test("an app's icon reaches its plot, and stays through a replay", () => {
    const apps = [{ ...app("shop"), icon: "/api/apps/shop/icon?v=1" }, app("blog")] as never;
    const live = buildWorld({ apps, statuses: new Map(), providers: [], now: NOW });
    assert.equal(live.plots[0]!.icon, "/api/apps/shop/icon?v=1");
    assert.equal("icon" in live.plots[1]!, false, "no icon: the sign shows its letter");
    assert.equal(worldAt(live, new Map(), NOW - 3_600_000).plots[0]!.icon, "/api/apps/shop/icon?v=1");
  });
});

describe("how much detail the picture can afford", () => {
  const FRAME = 33;
  const run = (start: ReturnType<typeof newPace>, gap: number, from: number, ms: number) => {
    let pace = start;
    for (let t = from; t < from + ms; t += gap) pace = paceAfter(pace, gap, FRAME, t);
    return pace;
  };

  test("a machine that keeps up stays at full detail", () => {
    assert.equal(run(newPace(0), 34, 0, 600_000).level, 0);
  });

  test("frames that stay late lower the detail, a level at a time, down to the lowest", () => {
    assert.equal(run(newPace(0), 80, 0, 1000).level, 0, "a moment's slowness doesn't count");
    assert.equal(run(newPace(0), 80, 0, 6000).level, 1);
    assert.equal(run(newPace(0), 200, 0, 120_000).level, LOWEST_DETAIL);
  });

  test("a long gap is the window asleep, not a slow machine", () => {
    assert.equal(run(newPace(0), 5000, 0, 600_000).level, 0);
    assert.equal(paceAfter(newPace(0), 80, 0, 10).average, 1, "no budget, no verdict");
  });

  test("it tries one level better later, and stays put if that doesn't hold", () => {
    const low = run(newPace(0), 80, 0, 6000);
    const climbed = run(low, 34, 6000, 130_000);
    assert.equal(climbed.level, 0, "it was only busy for a while");
    const fell = run(climbed, 80, 136_000, 6000);
    assert.equal(fell.level, 1);
    assert.equal(fell.settled, true);
    assert.equal(run(fell, 34, 142_000, 600_000).level, 1, "doesn't keep flickering between levels");
  });
});

describe("providers", () => {
  test("fine only when read lately and understood", () => {
    assert.equal(utilityLook(provider({}), NOW), "ok");
    assert.equal(utilityLook(provider({ relevantIndicator: "unknown" }), NOW), "unknown");
    assert.equal(utilityLook(provider({ checkedAt: undefined }), NOW), "unknown");
    assert.equal(utilityLook(provider({ checkedAt: new Date(NOW - 3 * 60 * 60_000).toISOString() }), NOW), "unknown", "read hours ago");
  });

  test("trouble only where it touches my apps", () => {
    assert.equal(utilityLook(provider({ indicator: "major", relevantIndicator: "none" }), NOW), "ok");
    assert.equal(utilityLook(provider({ relevantIndicator: "major" }), NOW), "trouble");
    assert.equal(utilityLook(provider({ relevantIndicator: "maintenance" }), NOW), "maintenance");
  });

  test("a provider no app uses isn't on the map", () => {
    const w = world({ a: "up" }, { providers: [provider({ apps: [] }), provider({ id: "vercel" })] });
    assert.deepEqual(w.utilities.map((u) => u.id), ["vercel"]);
  });
});

describe("labels on a crowded map", () => {
  const box = (id: string, x: number, rank: number, always = false) => ({ id, x, y: 0, w: 10, h: 10, rank, always });

  test("what's clear of the others all shows", () => {
    assert.deepEqual([...chooseLabels([box("a", 0, 5), box("b", 20, 5)])].sort(), ["a", "b"]);
  });

  test("the better rank keeps a contested place", () => {
    assert.deepEqual([...chooseLabels([box("worse", 0, 5), box("better", 5, 1)])], ["better"]);
  });

  test("a problem always shows, even over another", () => {
    assert.deepEqual([...chooseLabels([box("a", 0, 0, true), box("b", 5, 0, true), box("c", 8, 3)])].sort(), ["a", "b"]);
  });
});

describe("the map keeps its shape", () => {
  const key = (p: { x: number; y: number }) => `${p.x},${p.y}`;

  test("no two places are the same, and none is on the freeway", () => {
    const seen = new Set(Array.from({ length: 200 }, (_, i) => key(slotAt(i))));
    assert.equal(seen.size, 200);
    assert.ok(Array.from({ length: 200 }, (_, i) => slotAt(i)).every((p) => unbend(p.x, p.y).v > 3), "the main road stays clear");
  });

  test("a new app leaves the others where they were, wherever its name sorts", () => {
    const placed = placeApps(["mango", "zebra"]);
    assert.deepEqual(placed, { mango: 0, zebra: 1 });
    assert.deepEqual(placeApps(["alpha", "mango", "zebra"], placed), { alpha: 2, mango: 0, zebra: 1 });
  });

  test("a removed app's place goes to the next new one, and bad saved places are ignored", () => {
    assert.deepEqual(placeApps(["b", "c"], { a: 0, b: 1 }), { b: 1, c: 0 });
    assert.deepEqual(placeApps(["a", "b"], { a: 0, b: 0 }), { a: 0, b: 1 }, "two apps can't share a place");
    assert.deepEqual(placeApps(["a"], { a: -1 }), { a: 0 });
  });

  test("the world draws an app at its place", () => {
    const w = buildWorld({ apps: [app("a")], statuses: new Map(), providers: [], places: { a: 5 }, now: NOW });
    assert.equal(key(w.plots[0]!), key(slotAt(5)));
  });

  test("a change of state moves nothing", () => {
    assert.deepEqual(world({ a: "down", b: "up" }).plots.map(key), world({ a: "up", b: "stale" }).plots.map(key));
  });

  test("providers stay clear of the apps", () => {
    const providers = ["a", "b", "c", "d", "e"].map((id) => provider({ id }));
    const w = world(Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, "up" as AppState])), { providers });
    const places = new Set(w.plots.map(key));
    assert.ok(w.utilities.every((u) => !places.has(key(u))));
    assert.equal(new Set(w.utilities.map(key)).size, 5);
  });
});

describe("labels that must show", () => {
  const box = (id: string, x: number, rank: number, always = true) => ({ id, x, y: 100, w: 20, h: 10, rank, always });

  test("stack rather than cover each other, the most urgent staying put", () => {
    const [first, second, third] = nudgeLabels([box("later", 5, 3), box("urgent", 0, 0), box("next", 10, 1)]);
    assert.deepEqual([first?.id, first?.y], ["urgent", 100]);
    assert.deepEqual([second?.id, second?.y], ["next", 88]);
    assert.deepEqual([third?.id, third?.y], ["later", 76]);
    assert.equal(chooseLabels([first!, second!, third!]).size, 3);
  });

  test("leave alone what doesn't collide, and what can yield", () => {
    const out = nudgeLabels([box("a", 0, 0), box("b", 50, 0), box("c", 5, 1, false)]);
    assert.deepEqual(out.map((b) => b.y), [100, 100, 100]);
  });
});

describe("what changed", () => {
  const plot = (state: AppState | "checking", work: "deploying" | "waiting" | null = null, deploy?: DeployState["state"]) => ({ slug: "a", name: "A", state, look: "lit" as const, moving: true, floors: 1, work, x: 0, y: 0, turn: 0, ...(deploy ? { deploy } : {}) });
  const world = (p: ReturnType<typeof plot>, failed = false) => ({ plots: [p], utilities: [], watching: true, stopped: false, watcher: { x: 0, y: 0, turn: 0 }, failed });

  test("says when an app goes down and comes back", () => {
    assert.equal(changesBetween(world(plot("up")), world(plot("down")), 1)[0]?.text, "went down");
    assert.equal(changesBetween(world(plot("down")), world(plot("up")), 1)[0]?.text, "is back up");
  });
  test("a first reading isn't a change, nor is a failed read or the read after it", () => {
    assert.deepEqual(changesBetween(world(plot("checking")), world(plot("down")), 1), []);
    assert.deepEqual(changesBetween(world(plot("up")), world(plot("unknown"), true), 1), []);
    assert.deepEqual(changesBetween(world(plot("unknown"), true), world(plot("up")), 1), []);
  });
  test("a deploy starting and finishing are changes, nothing changing isn't", () => {
    assert.equal(changesBetween(world(plot("up")), world(plot("up", "deploying")), 1)[0]?.text, "started deploying");
    assert.equal(changesBetween(world(plot("up", "deploying")), world(plot("up", null, "live")), 1)[0]?.text, "finished deploying");
    assert.deepEqual(changesBetween(world(plot("up")), world(plot("up")), 1), []);
  });
  test("the feed prefers the server's record, and goes newest first", () => {
    const at = Date.parse("2026-11-04T12:00:00Z");
    const live = [{ key: "app:a", kind: "app" as const, id: "a", name: "A", text: "went down", state: "down" as const, at }];
    const view = { now: [{ state: "down" as const, title: "A", text: "Site is down", href: "#/apps/a", since: new Date(at - 60_000).toISOString() }], earlier: [{ title: "A", text: "Slow", href: "#/apps/a", startedAt: new Date(at - 9e6).toISOString(), endedAt: new Date(at - 8e6).toISOString() }] };
    const rows = feedRows(live, view, [plot("down")]);
    assert.deepEqual(rows.map((r) => r.text), ["Site is down", "recovered: Slow"]);
    assert.deepEqual(rows[0]?.target, { kind: "app", id: "a" });
    assert.equal(feedRows(live, undefined, [plot("down")])[0]?.text, "went down");
  });
  test("the feed leaves out what's about Periskopos's own checks", () => {
    const view = { now: [{ state: "attention" as const, title: "Periskopos", text: "Off", href: "#/settings", watching: true as const, since: "2026-11-04T12:00:00Z" }], earlier: [] };
    assert.deepEqual(feedRows([], view, []), []);
  });
});

describe("traffic", () => {
  test("follows real requests where they can be read", () => {
    assert.equal(carsFor({ moving: true, requests: 9 }), 1);
    assert.equal(carsFor({ moving: true, requests: 12_000 }), 5);
    assert.equal(carsFor({ moving: true, requests: 1e12 }), 8);
    assert.equal(carsFor({ moving: true, requests: 0 }), 0, "nobody came: an empty street");
  });
  test("an app that can't be read just shows it's serving; one not serving shows nothing", () => {
    assert.equal(carsFor({ moving: true }), 2);
    assert.equal(carsFor({ moving: false, requests: 12_000 }), 0);
  });
});

describe("replay", () => {
  const t = (hour: number) => Date.parse(`2026-11-04T${String(hour).padStart(2, "0")}:00:00Z`);
  const iso = (hour: number) => new Date(t(hour)).toISOString();
  const incident = (kind: "outage" | "ci", from: number, to?: number, falseAlarm = false) => ({ id: "i", appId: "a", kind, startedAt: iso(from), reason: `${kind} problem`, ...(to === undefined ? {} : { endedAt: iso(to) }), ...(falseAlarm ? { falseAlarm: true as const } : {}) });
  const history = (incidents: ReturnType<typeof incident>[], gaps: { from: string; to: string }[] = []) => ({ from: iso(0), to: iso(23), watchedMin: 100, incidents, gaps, watched: [{ from: iso(0), to: iso(23) }], days: [] });

  test("an outage is down, any other incident needs attention, otherwise up", () => {
    const h = history([incident("outage", 5, 6), incident("ci", 8, 9)]);
    assert.deepEqual(stateAt(h, t(5), "up"), { state: "down", reason: "outage problem" });
    assert.deepEqual(stateAt(h, t(8), "up"), { state: "attention", reason: "ci problem" });
    assert.deepEqual(stateAt(h, t(6), "up"), { state: "up" }, "over at its end");
  });
  test("an incident still open counts, one marked a false alarm doesn't", () => {
    assert.equal(stateAt(history([incident("outage", 5)]), t(20), "down").state, "down");
    assert.equal(stateAt(history([incident("outage", 5, 7, true)]), t(6), "up").state, "up");
  });
  test("a stretch nobody watched is no data, never up", () => {
    assert.equal(stateAt(history([], [{ from: iso(2), to: iso(3) }]), t(2), "up").state, "stale");
    assert.equal(stateAt({ ...history([]), watched: [] }, t(2), "up").state, "unknown");
  });
  test("an app that isn't live stays as it is", () => {
    assert.equal(stateAt(history([incident("outage", 5, 6)]), t(5), "prelaunch").state, "prelaunch");
  });
  test("nothing in a replay moves or claims to be current", () => {
    const plot = { slug: "a", name: "A", state: "up" as const, look: "lit" as const, moving: true, floors: 1, work: "deploying" as const, requests: 500, x: 0, y: 0, turn: 0 };
    const utility = { id: "p", label: "P", look: "ok" as const, description: "", apps: [], x: 0, y: 0, turn: 0 };
    const then = worldAt({ plots: [plot], utilities: [utility], watching: true, stopped: false, watcher: { x: 0, y: 0, turn: 0 }, failed: false }, new Map([["a", history([incident("outage", 5, 6)])]]), t(5));
    assert.equal(then.watching, false);
    assert.equal(then.utilities[0]?.look, "past");
    assert.equal(then.plots[0]?.look, "dark");
    assert.equal(then.plots[0]?.moving, false);
    assert.equal(then.plots[0]?.work, null);
    assert.equal(then.plots[0]?.requests, undefined);
  });
  test("an app with no record to read is unknown, not fine", () => {
    const plot = { slug: "a", name: "A", state: "up" as const, look: "lit" as const, moving: true, floors: 1, work: null, x: 0, y: 0, turn: 0 };
    assert.equal(worldAt({ plots: [plot], utilities: [], watching: true, stopped: false, watcher: { x: 0, y: 0, turn: 0 }, failed: false }, new Map(), t(5)).plots[0]?.look, "fog");
  });
});

describe("the land grows with your apps", () => {
  test("orchards, then a town, then a valley", () => {
    assert.equal(worldStage(0), "orchards");
    assert.equal(worldStage(3), "orchards");
    assert.equal(worldStage(4), "town");
    assert.equal(worldStage(9), "town");
    assert.equal(worldStage(10), "valley");
    assert.equal(worldStage(500), "valley");
  });

  test("going up is news, the first look and going down aren't", () => {
    assert.equal(stageRose("orchards", "town"), true);
    assert.equal(stageRose("orchards", "valley"), true);
    assert.equal(stageRose("town", "valley"), true);
    assert.equal(stageRose(null, "valley"), false, "nothing to compare with");
    assert.equal(stageRose("nonsense", "valley"), false, "nor with something unreadable");
    assert.equal(stageRose("valley", "town"), false);
    assert.equal(stageRose("town", "town"), false);
  });
});

describe("a headquarters' size", () => {
  test("follows real traffic", () => {
    assert.equal(campusSize({ requests: 0 }), "small");
    assert.equal(campusSize({ requests: 999 }), "small");
    assert.equal(campusSize({ requests: 1_000 }), "standard");
    assert.equal(campusSize({ requests: 99_999 }), "standard");
    assert.equal(campusSize({ requests: 100_000 }), "large");
  });

  test("traffic that can't be read claims nothing either way", () => {
    assert.equal(campusSize({}), "standard");
  });
});

describe("the radar", () => {
  test("each thing is where it is on the map, seen from the dish", () => {
    const w = world({ shop: "up", blog: "down", docs: "attention" }, { providers: [provider({ apps: [{ slug: "shop", name: "SHOP" }] })] });
    const blips = radarBlips(w);
    assert.equal(blips.length, w.plots.length + w.utilities.length);
    for (const plot of w.plots) {
      const blip = blips.find((b) => b.kind === "app" && b.id === plot.slug)!;
      assert.deepEqual([blip.x, blip.z], [plot.x - w.watcher.x, plot.y - w.watcher.y]);
    }
    assert.ok(blips.every((b) => b.reach > 0 && b.reach <= 0.9), "nothing on the dish or the rim");
    assert.equal(Math.max(...blips.map((b) => b.reach)), 0.9);
  });

  test("a blip's colour is its state, and a provider's is what's known of it", () => {
    const w = world({ shop: "up", blog: "down" }, { providers: [provider({ apps: [{ slug: "shop", name: "SHOP" }] })] });
    const tone = (id: string) => radarBlips(w).find((b) => b.id === id)?.tone;
    assert.equal(tone("shop"), "up");
    assert.equal(tone("blog"), "down");
    assert.equal(tone("render"), "up");
  });

  test("an empty map has an empty radar", () => {
    assert.deepEqual(radarBlips(world({})), []);
  });
});

describe("the sky by the clock", () => {
  test("is daylight from seven until six", () => {
    assert.deepEqual([6, 7, 12, 17, 18, 23].map(duskAt), [true, false, false, false, true, true]);
  });
});
