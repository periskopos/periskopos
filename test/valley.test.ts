import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { App, AppState, AppStatus, ProviderStatus, WatcherLog } from "../shared/types.ts";
import { DISH_DOOR, HILL_REACH, hillRoad } from "../shared/valley/hill.ts";
import { bend, RISE_HEIGHT, riseAt, unbend } from "../shared/valley/lay.ts";
import { BLOCK, FREEWAY_HALF, MAIN_HALF, mainRoad, planKey, SERVICE_EDGE, SIGN_BASE_PAST_DISK, signFit, slotAt, SPINE, valleyPlan } from "../shared/valley/plan.ts";
import { checkRoute, deliveryRoute, makeRoute, placeOn, trafficRoute } from "../shared/valley/routes.ts";
import type { Place } from "../shared/valley/routes.ts";
import { heightAt } from "../shared/valley/terrain.ts";
import { notRunningNote, tripsFor, valleyStats } from "../shared/valley/trips.ts";
import { buildWorld, worldAt } from "../shared/world.ts";

const NOW = Date.parse("2026-11-05T12:00:00Z");
const app = (slug: string) => ({ slug, name: slug.toUpperCase(), connections: [{}, {}] }) as unknown as App;
const status = (slug: string, state: AppState, extra: Partial<AppStatus> = {}): AppStatus => ({ slug, state, checks: {}, ...extra });
const provider = (id: string, slugs: string[]) =>
  ({ id, label: id, description: "", relevantIndicator: "none", checkedAt: new Date(NOW - 60_000).toISOString(), apps: slugs.map((slug) => ({ slug, name: slug })) }) as ProviderStatus;
const make = (states: Record<string, AppState>, extra: { requests?: Map<string, number>; providers?: ProviderStatus[]; statuses?: AppStatus[]; readFailed?: boolean } = {}) => {
  const world = buildWorld({
    apps: Object.keys(states).map(app),
    statuses: new Map((extra.statuses ?? Object.entries(states).map(([s, state]) => status(s, state))).map((s) => [s.slug, s])),
    providers: extra.providers ?? [],
    now: NOW,
    ...(extra.requests ? { requests: extra.requests } : {}),
    ...(extra.readFailed ? { readFailed: true } : {}),
  });
  return { world, plan: valleyPlan(world) };
};
const row = (slug: string, agoMs: number, what = "Site"): WatcherLog["checks"][number] => ({ at: new Date(NOW - agoMs).toISOString(), state: "up", slug, app: slug.toUpperCase(), what });

describe("the valley's layout", () => {
  test("every app stands in front of the main road, clear of it, the first ones by the highway", () => {
    const all = Array.from({ length: 200 }, (_, i) => slotAt(i));
    assert.ok(all.every((s) => unbend(s.x, s.y).v - 2.6 > MAIN_HALF));
    assert.ok(all.slice(0, 2).every((s) => Math.abs(s.x - SPINE) <= BLOCK * 2));
  });

  test("bending can be undone, so a place on the ground is known on the plan", () => {
    for (const [u, v] of [[0, 3.9], [-120, 40], [50, -30]] as const) {
      const { x, z } = bend(u, v);
      const back = unbend(x, z);
      assert.ok(Math.abs(back.u - u) < 1e-6 && Math.abs(back.v - v) < 1e-6);
    }
  });

  test("the road curves, the blocks vary, and neither enough to squeeze a campus", () => {
    const roadAt = (i: number) => bend(-i * BLOCK, 0);
    const zs = Array.from({ length: 30 }, (_, i) => roadAt(i).z);
    assert.ok(Math.max(...zs) - Math.min(...zs) > 3, "the main road curves");
    const widths = Array.from({ length: 30 }, (_, i) => roadAt(i).x - roadAt(i + 1).x);
    assert.ok(Math.max(...widths) - Math.min(...widths) > 0.1, "the blocks aren't all alike");
    assert.ok(Math.min(...widths) > BLOCK - 0.5, "room for a campus in the narrowest");
    assert.ok(Array.from({ length: 200 }, (_, i) => slotAt(i)).every((s) => Math.abs(s.turn) < 0.12), "turned a little, not much");
  });

  test("it grows along the valley faster than across it", () => {
    const all = Array.from({ length: 40 }, (_, i) => slotAt(i));
    assert.ok(Math.max(...all.map((s) => Math.abs(s.x))) > Math.max(...all.map((s) => Math.abs(s.y))));
  });

  const providers = ["render", "github", "cloudflare", "supabase", "stripe", "sentry", "neon"].map((id) => provider(id, ["a0"]));
  const apps = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`a${i}`, "up" as const]));

  test("the services stand straight behind the apps, past the belt, and the dish behind them", () => {
    const { world } = make(apps(14), { providers });
    const where = (s: { x: number; y: number }) => unbend(s.x, s.y);
    assert.ok(world.utilities.every((u) => where(u).v < SERVICE_EDGE));
    assert.ok(world.plots.every((p) => where(p).v > 0));
    assert.equal(world.utilities[0]!.x, world.plots[0]!.x, "the first of each, one behind the other");
    assert.ok(world.watcher.y < Math.min(...world.utilities.map((u) => u.y)));
    assert.ok(world.utilities.every((u) => Math.hypot(u.x - world.watcher.x, u.y - world.watcher.y) > HILL_REACH + BLOCK / 2 * Math.SQRT2 - 2.6), "the hill's foot is clear of the service zone");
  });

  test("the highway comes in from one side only and narrows into the main road", () => {
    const { plan } = make(apps(14), { providers });
    const road = mainRoad(plan, 300);
    assert.ok(road[0]!.u <= plan.apps.minU + 0.01, "the main road reaches the last of the apps");
    assert.equal(road[0]!.half, MAIN_HALF);
    assert.equal(road.at(-1)!.half, FREEWAY_HALF);
    assert.ok(bend(road.at(-1)!.u, 0).x > plan.maxX + 100, "out past the valley on that side");
    assert.ok(heightAt(plan, plan.minX - plan.floor * 1.5 - 150, bend(plan.minX - 150, 0).z) > 8, "and the other end is closed by the hills");
  });

  test("the services stand on higher ground, flat under them, and the apps on the floor", () => {
    const { world, plan } = make(apps(14), { providers });
    for (const u of world.utilities) assert.equal(heightAt(plan, u.x, u.y), RISE_HEIGHT);
    for (const p of world.plots) assert.equal(heightAt(plan, p.x, p.y), 0);
    assert.equal(riseAt(bend(50, 0).x, bend(50, 0).z), 0, "the main road and the highway are on the floor");
  });

  test("adding an app moves no service and not the dish", () => {
    const few = make(apps(2), { providers }).world;
    const many = make(apps(60), { providers }).world;
    assert.deepEqual(many.utilities.map((u) => [u.x, u.y]), few.utilities.map((u) => [u.x, u.y]));
    assert.deepEqual(many.watcher, few.watcher);
  });

  test("a service keeps its own place when another one goes", () => {
    const places = { render: 0, github: 1, neon: 2 };
    const at = (ids: string[]) => buildWorld({ apps: [app("a0")], statuses: new Map(), providers: ids.map((id) => provider(id, ["a0"])), servicePlaces: places, now: NOW }).utilities.find((u) => u.id === "neon")!;
    const all = at(["render", "github", "neon"]);
    const fewer = at(["neon"]);
    assert.deepEqual([fewer.x, fewer.y], [all.x, all.y]);
  });

  test("a road runs round every campus and every service", () => {
    const { world, plan } = make(apps(14), { providers });
    const onARoad = (u: number, v: number) => Math.abs(v) < MAIN_HALF + 2.6 || plan.roads.some((r) => u >= Math.min(r.x1, r.x2) - 0.01 && u <= Math.max(r.x1, r.x2) + 0.01 && v >= Math.min(r.z1, r.z2) - 0.01 && v <= Math.max(r.z1, r.z2) + 0.01);
    const half = BLOCK / 2;
    for (const s of [...world.plots, ...world.utilities]) {
      const { u, v } = unbend(s.x, s.y);
      for (const [a, b] of [[u - half, v], [u + half, v], [u, v - half], [u, v + half]] as const) assert.ok(onARoad(a, b), `no road at ${a},${b}`);
    }
  });

  test("only the spine climbs the belt from the main road to the services", () => {
    const { plan } = make(apps(14), { providers });
    const climbing = plan.roads.filter((r) => Math.min(r.z1, r.z2) < -2 && Math.max(r.z1, r.z2) > SERVICE_EDGE + 0.1);
    assert.equal(climbing.length, 1);
    assert.equal(climbing[0]!.x1, SPINE);
  });

  test("the road up the hill starts on the spine, follows the ground, and is a grade a road could be", () => {
    const { plan } = make(apps(5), { providers });
    const road = hillRoad(plan.watcher);
    assert.ok(Math.hypot(road[0]!.x - bend(SPINE, 0).x, road[0]!.z - plan.watcher.y) < 0.01);
    assert.ok(Math.hypot(road.at(-1)!.x - plan.watcher.x, road.at(-1)!.z - plan.watcher.y) < 2);
    for (let i = 1; i < road.length; i++) {
      const p = road[i]!;
      const run = Math.hypot(p.x - road[i - 1]!.x, p.z - road[i - 1]!.z);
      assert.ok(Math.abs(p.y - road[i - 1]!.y) / run < 0.25, "too steep");
      assert.ok(Math.abs(heightAt(plan, p.x, p.z) - (p.y + riseAt(p.x, p.z))) < 0.03, `the road leaves the ground at ${i}`);
    }
  });

  test("the road up the rise is a grade a road could be", () => {
    const { plan } = make(apps(5), { providers });
    const x = bend(SPINE, 0).x;
    const at = (v: number) => heightAt(plan, x, bend(SPINE, v).z);
    for (let v = -1; v > SERVICE_EDGE; v -= 0.25) assert.ok(Math.abs(at(v - 0.25) - at(v)) / 0.25 < 0.4, `too steep at ${v}`);
  });

  test("the land's signature changes only when the land does", () => {
    const up = make({ a: "up", b: "up" });
    const down = make({ a: "down", b: "stale" });
    assert.equal(planKey(up.plan), planKey(down.plan), "a change of state rebuilds no land");
    assert.notEqual(planKey(up.plan), planKey(make({ a: "up", b: "up", c: "up" }).plan));
  });
});

describe("a roof sign", () => {
  const RAISED_EDGE = 0.0225; // half the rim's thickness, inside the roof

  test("clears the roof's raised edge on any roof a building has, as it swings round", () => {
    // The short side of every roof there is, at every footprint, and a deck and a hall.
    const rooms = [1.3, 1, 1.45, 0.8].flatMap((d, i) => [0.84, 1, 1.14].map((f) => Math.min(d, [1.75, 1.15, 1.15, 1.72][i]!) * f));
    for (const room of [...rooms, 1.28, 1.3]) {
      const { size, radius } = signFit(room, 0.8);
      assert.ok(radius + SIGN_BASE_PAST_DISK < room / 2 - RAISED_EDGE, `the base hits the edge of a roof ${room} across`);
      assert.ok((size + 0.06) / 2 < room / 2 - RAISED_EDGE, `the board swings over the edge of a roof ${room} across`);
      assert.ok(size >= 0.5, `too small to read on a roof ${room} across`);
    }
  });

  test("is only as big as asked for on a big roof, and its posts stay on its disk", () => {
    assert.equal(signFit(2.5, 0.72).size, 0.72);
    for (const room of [0.67, 0.8, 1, 1.3, 2.5]) {
      const { size, radius } = signFit(room, 0.8);
      assert.ok(size * 0.3 < radius * 0.9, `posts off the disk on a roof ${room} across`);
    }
  });
});

describe("the land", () => {
  const { plan } = make({ a: "up", b: "up", c: "up", d: "up", e: "up" });

  test("is flat under the district and the freeway, and rises to the ranges", () => {
    for (const p of plan.taken) assert.equal(heightAt(plan, p.x, p.y), 0);
    const far = bend(unbend(plan.maxX + 150, 0).u, 0);
    assert.equal(heightAt(plan, far.x, far.z), 0, "the highway leaves on the level");
    assert.ok(heightAt(plan, 0, plan.minZ - plan.floor - 100) > 8, "mountains to the north");
    assert.ok(heightAt(plan, 0, plan.maxZ + plan.floor + 100) > 8, "and to the south: no sea");
  });

  test("the dish stands on a hill", () => {
    assert.ok(heightAt(plan, plan.watcher.x, plan.watcher.y) > 2);
  });

  test("is the same every time", () => {
    assert.equal(heightAt(plan, 123.4, 56.7), heightAt(plan, 123.4, 56.7));
  });
});

describe("routes", () => {
  const out: Place = { x: 0, z: 0, heading: 0 };

  test("a straight is exact, on the right of the way it's going", () => {
    const route = makeRoute([{ x: 0, z: 0, lane: 0.5 }, { x: 10, z: 0, lane: 0.5 }]);
    placeOn(route, 5, false, out);
    assert.deepEqual([out.x, out.z], [5, 0.5]);
    placeOn(route, 5, true, out);
    assert.deepEqual([out.x, out.z], [5, -0.5], "coming back is the other side of the road");
  });

  test("corners are rounded, never cut across a block", () => {
    const route = makeRoute([{ x: 0, z: 0, lane: 0 }, { x: 10, z: 0, lane: 0 }, { x: 10, z: 10, lane: 0 }]);
    placeOn(route, 10, false, out);
    assert.ok(out.x < 10 && out.x > 9.7 && out.z > 0 && out.z < 0.3);
  });

  test("traffic comes along the freeway, the check from the dish, and both end in the car park", () => {
    const { world, plan } = make({ a: "up" });
    const plot = world.plots[0]!;
    const cars = trafficRoute(plan, plot, 0.2);
    assert.ok(cars.points[0]!.x > plan.maxX + 40, "from out past the valley, on the highway's side");
    const van = checkRoute(plan, plot);
    const [x, z] = [van.points[0]!.x - world.watcher.x, van.points[0]!.z - world.watcher.y];
    assert.ok(Math.hypot(x - DISH_DOOR.x, z - DISH_DOOR.z) < 0.01, "from the door of the dish's shed");
    assert.ok(Math.hypot(x, z) > 0.7, "not out of the pedestal, which stands in the middle");
    for (const route of [cars, van]) {
      const end = route.points[route.points.length - 1]!;
      assert.ok(Math.abs(end.x - plot.x) < BLOCK / 2 && Math.abs(end.z - plot.y) < BLOCK / 2);
    }
  });
});

describe("no vehicle drives through a building", () => {
  const providers = [provider("github", ["a0"]), provider("render", ["a1"]), provider("stripe", ["a2"]), provider("neon", ["a3"]), provider("sentry", ["a4"]), provider("resend", ["a5"])];
  const { world, plan } = make(Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`a${i}`, "up" as const])), { providers });
  const buildings = [...world.plots, ...world.utilities];
  const out: Place = { x: 0, z: 0, heading: 0 };
  const clear = (route: ReturnType<typeof makeRoute>, what: string) => {
    for (let d = 0; d <= route.length; d += 0.25) {
      placeOn(route, d, false, out);
      assert.ok(Number.isFinite(out.x) && Number.isFinite(out.z), `${what}: nowhere at ${d}`);
      const hit = buildings.find((b) => Math.abs(b.x - out.x) < 1.5 && Math.abs(b.y - out.z) < 1.5);
      assert.equal(hit, undefined, `${what} is inside a building at ${out.x},${out.z}`);
    }
  };

  test("the van from the dish, to every app", () => {
    for (const p of world.plots) clear(checkRoute(plan, p), `van to ${p.slug}`);
  });

  test("traffic, to every app", () => {
    for (const p of world.plots) clear(trafficRoute(plan, p, 0.2), `car to ${p.slug}`);
  });

  test("a truck from every service, down the spine", () => {
    for (const u of world.utilities) {
      const route = deliveryRoute(u, world.plots[0]!);
      clear(route, `truck from ${u.id}`);
      assert.ok(route.points.some((q) => Math.abs(unbend(q.x, q.z).u - SPINE) < 0.8 && unbend(q.x, q.z).v < -3), "by the spine");
    }
  });
});

describe("what's on the road is what's true", () => {
  test("no traffic to an app not known to be serving, and none where no requests came", () => {
    const { world, plan } = make({ a: "down", b: "stale", c: "unknown", d: "none", e: "prelaunch" });
    assert.deepEqual(tripsFor({ world, plan, checks: [], now: NOW }), []);
    const idle = make({ a: "up" }, { requests: new Map([["a", 0]]) });
    assert.deepEqual(tripsFor({ world: idle.world, plan: idle.plan, checks: [], now: NOW }), []);
  });

  test("more requests, more cars, and an unread app gets the two that say only it's serving", () => {
    const cars = (requests?: number) => {
      const { world, plan } = make({ a: "up" }, requests === undefined ? {} : { requests: new Map([["a", requests]]) });
      return tripsFor({ world, plan, checks: [], now: NOW }).length;
    };
    assert.equal(cars(), 2);
    assert.ok(cars(100) < cars(100_000));
  });

  test("each recent check is one van, and an old one is none", () => {
    const { world, plan } = make({ a: "up", b: "down" });
    const trips = tripsFor({ world, plan, checks: [row("b", 5_000), row("a", 20_000), row("a", 10 * 60_000)], now: NOW }).filter((t) => t.facts.kind === "check");
    assert.deepEqual(trips.map((t) => t.slug), ["b", "a"]);
    assert.ok(trips.every((t) => t.once));
  });

  test("a check stays the same trip on the next read, so it isn't sent twice", () => {
    const { world, plan } = make({ a: "up" });
    const read = () => tripsFor({ world, plan, checks: [row("a", 5_000)], now: NOW }).find((t) => t.facts.kind === "check")!.id;
    assert.equal(read(), read());
  });

  test("not watching, a failed read and a replay send nobody out", () => {
    const checks = [row("a", 5_000)];
    const failed = make({ a: "up" }, { readFailed: true });
    assert.deepEqual(tripsFor({ world: failed.world, plan: failed.plan, checks, now: NOW }), []);
    const stopped = make({ a: "stale" });
    assert.deepEqual(tripsFor({ world: stopped.world, plan: stopped.plan, checks, now: NOW }), []);
    const live = make({ a: "up" });
    const past = worldAt(live.world, new Map(), NOW - 60_000);
    assert.deepEqual(tripsFor({ world: past, plan: live.plan, checks, now: NOW }), []);
  });

  test("a truck runs only while a deploy is under way, from source control where it's known", () => {
    const providers = [provider("github", ["a"])];
    const deploying = make({ a: "up" }, { providers, statuses: [status("a", "up", { deploy: { state: "deploying" } })] });
    const truck = tripsFor({ world: deploying.world, plan: deploying.plan, checks: [], now: NOW }).find((t) => t.facts.kind === "deploy")!;
    assert.deepEqual(truck.facts, { kind: "deploy", from: "github" });
    const live = make({ a: "up" }, { providers, statuses: [status("a", "up", { deploy: { state: "live" } })] });
    assert.equal(tripsFor({ world: live.world, plan: live.plan, checks: [], now: NOW }).some((t) => t.facts.kind === "deploy"), false);
  });

  test("however many apps, the road has a limit, and every serving app keeps a car", () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`a${i}`, "up" as const]));
    const { world, plan } = make(many, { requests: new Map(Object.keys(many).map((s) => [s, 1_000_000])) });
    const trips = tripsFor({ world, plan, checks: [], now: NOW });
    assert.equal(new Set(trips.map((t) => t.slug)).size, 200);
  });
});

describe("the figures across the top", () => {
  test("a figure that can't be read is absent, not zero", () => {
    const { world } = make({ a: "up", b: "down" });
    const stats = valleyStats(world, new Map(), []);
    assert.deepEqual([stats.total, stats.running], [2, 1]);
    assert.equal("requests" in stats, false);
    assert.equal("lowestUptime" in stats, false);
  });

  test("requests add up and uptime is the lowest", () => {
    const statuses = [status("a", "up", { uptime30d: 99.5 }), status("b", "up", { uptime30d: 100 })];
    const { world } = make({ a: "up", b: "up" }, { statuses, requests: new Map([["a", 10], ["b", 5]]) });
    const stats = valleyStats(world, new Map(statuses.map((s) => [s.slug, s])), []);
    assert.deepEqual([stats.requests, stats.lowestUptime], [15, 99.5]);
    assert.equal(stats.lowestUptimeApp?.slug, "a");
  });

  test("what isn't running comes worst first, and is said shortly", () => {
    const { world } = make({ a: "prelaunch", b: "down", c: "up" });
    const stats = valleyStats(world, new Map(), []);
    assert.deepEqual(stats.notRunning.map((p) => p.slug), ["b", "a"]);
    assert.equal(notRunningNote(stats.notRunning), "1 down, 1 not live yet");
    assert.equal(notRunningNote([]), undefined);
    const many = [{ slug: "a", state: "down" }, { slug: "b", state: "unknown" }, { slug: "c", state: "prelaunch" }] as const;
    assert.equal(notRunningNote([...many]), "1 down, 1 unknown and more");
  });

  test("names only what's really deploying", () => {
    const { world } = make({ a: "up", b: "up" });
    const plots = world.plots.map((p) => (p.slug === "b" ? { ...p, work: "deploying" as const } : p));
    assert.deepEqual(valleyStats({ ...world, plots }, new Map(), []).deploying.map((p) => p.slug), ["b"]);
    assert.deepEqual(valleyStats(world, new Map(), []).deploying, []);
  });
});

describe("the layering", () => {
  test("the pure core imports neither the page nor three.js", () => {
    const dir = path.join(import.meta.dirname, "..", "shared", "valley");
    for (const file of [...readdirSync(dir).map((f) => path.join(dir, f)), path.join(dir, "..", "world.ts")]) {
      const source = readFileSync(file, "utf8");
      assert.doesNotMatch(source, /from "three|from "\.\.\/\.\.\/web|from "\.\.\/web/, file);
      assert.doesNotMatch(source, /\b(document|window)\./, file);
    }
  });
});
