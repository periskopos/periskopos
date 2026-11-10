import type { AppStatus, CheckState, WatcherLog } from "../types.ts";
import type { Plot, World } from "../world.ts";
import { carsFor } from "../world.ts";
import type { ValleyPlan } from "./plan.ts";
import { checkRoute, deliveryRoute, trafficRoute } from "./routes.ts";
import type { Route } from "./routes.ts";
import { hash } from "./terrain.ts";

// Everything on the road is a fact you can click. A patrol van is one real check, a
// delivery truck is a deploy under way, and a car is a share of an app's real requests.
// Nothing here moves for the look of it: no data, no vehicle.

export type TripFacts =
  | { kind: "traffic"; requests?: number; cars: number }
  | { kind: "check"; at: string; state: CheckState; what: string; ms?: number; httpStatus?: number; detail?: string }
  | { kind: "deploy"; from?: string };

export type Trip = {
  id: string;
  slug: string;
  name: string;
  route: Route;
  seed: number;
  speed: number; // units a second
  once: boolean; // there and back, then it's gone, rather than going on as long as the fact holds
  facts: TripFacts;
};

const ROAD_CARS_PER_READING = 3; // only where requests are read: more cars say more requests
const MAX_CARS = 120;
const MAX_VANS = 16;
const CHECK_WINDOW_MS = 2 * 60_000; // a check older than this is news already told

function carsOnRoad(plot: Plot): number {
  const cars = carsFor(plot);
  return plot.requests === undefined ? cars : cars * ROAD_CARS_PER_READING;
}

const SOURCE_CONTROL = new Set(["github", "gitlab"]);

export type TripInput = { world: World; plan: ValleyPlan; checks: WatcherLog["checks"]; now: number };

// Every check the log has from the last couple of minutes, which may be more than there's
// room for vans.
export function checksLately({ world, checks, now }: Omit<TripInput, "plan">): number {
  if (!world.watching || world.failed) return 0;
  const slugs = new Set(world.plots.map((p) => p.slug));
  return checks.filter((row) => slugs.has(row.slug) && now - Date.parse(row.at) <= CHECK_WINDOW_MS).length;
}

export function tripsFor({ world, plan, checks, now }: TripInput): Trip[] {
  const trips: Trip[] = [];
  // Short of room, everyone gives way alike, so more requests still means more cars. An app
  // that's serving keeps at least one, and one with nothing to show gets none.
  const wanted = world.plots.reduce((sum, plot) => sum + carsOnRoad(plot), 0);
  const room = wanted > MAX_CARS ? MAX_CARS / wanted : 1;
  for (const plot of world.plots) {
    const want = carsOnRoad(plot);
    const cars = want === 0 ? 0 : Math.max(1, Math.round(want * room));
    for (let i = 0; i < cars; i++) {
      const seed = hash(plot.slug, i + 11);
      trips.push({
        id: `traffic:${plot.slug}:${i}`,
        slug: plot.slug,
        name: plot.name,
        route: trafficRoute(plan, plot, seed),
        seed,
        speed: 3 + hash(plot.slug, i + 61) * 1.2,
        once: false,
        facts: { kind: "traffic", cars, ...(plot.requests === undefined ? {} : { requests: plot.requests }) },
      });
    }
    if (plot.work === "deploying") {
      const source = world.utilities.find((u) => SOURCE_CONTROL.has(u.id) && u.apps.some((a) => a.slug === plot.slug));
      const seed = hash(plot.slug, 7);
      trips.push({
        id: `deploy:${plot.slug}`,
        slug: plot.slug,
        name: plot.name,
        route: source ? deliveryRoute(source, plot) : trafficRoute(plan, plot, seed),
        seed,
        speed: 2.2,
        once: false,
        facts: { kind: "deploy", ...(source ? { from: source.label } : {}) },
      });
    }
  }
  // Not watching, or a failed read: the log has nothing current to say.
  if (!world.watching || world.failed) return trips;
  const plots = new Map(world.plots.map((p) => [p.slug, p]));
  let vans = 0;
  for (const row of checks) {
    if (vans >= MAX_VANS) break;
    const plot = plots.get(row.slug);
    if (!plot || now - Date.parse(row.at) > CHECK_WINDOW_MS) continue;
    const id = `check:${row.slug}:${row.what}:${row.at}`;
    vans++;
    trips.push({
      id,
      slug: row.slug,
      name: row.app,
      route: checkRoute(plan, plot),
      seed: hash(id),
      speed: 3.4,
      once: true,
      facts: { kind: "check", at: row.at, state: row.state, what: row.what, ...(row.ms === undefined ? {} : { ms: row.ms }), ...(row.httpStatus === undefined ? {} : { httpStatus: row.httpStatus }), ...(row.detail ? { detail: row.detail } : {}) },
    });
  }
  return trips;
}

// The figures across the top, each from the same data as the Apps page. A figure
// that can't be read is absent, never zero.
type NamedApp = { slug: string; name: string };
export type ValleyStats = { total: number; running: number; requests?: number; requestsFrom: number; lowestUptime?: number; lowestUptimeWatchedMs?: number; lowestUptimeApp?: NamedApp; notRunning: { slug: string; state: Plot["state"] }[]; deploying: NamedApp[]; cars: number; vans: number; checks: number; trucks: number };

// Worst first: the first is the one to go and look at.
const NOT_RUNNING: [Plot["state"], string][] = [
  ["down", "down"],
  ["unknown", "unknown"],
  ["stale", "with no recent data"],
  ["prelaunch", "not live yet"],
  ["none", "with no checks"],
];
const worstness = (state: Plot["state"]) => {
  const at = NOT_RUNNING.findIndex(([known]) => known === state);
  return at === -1 ? NOT_RUNNING.length : at;
};

// What the rest of them are, shortly: "1 down, 2 not live yet".
export function notRunningNote(notRunning: ValleyStats["notRunning"]): string | undefined {
  const parts: string[] = [];
  let others = 0;
  for (const [state, word] of NOT_RUNNING) {
    const count = notRunning.filter((p) => p.state === state).length;
    if (count) parts.push(`${count} ${word}`);
  }
  others = notRunning.filter((p) => worstness(p.state) === NOT_RUNNING.length).length;
  if (others) parts.push(`${others} not serving`);
  if (parts.length <= 2) return parts.join(", ") || undefined;
  return `${parts.slice(0, 2).join(", ")} and more`;
}

export function valleyStats(world: World, statuses: Map<string, AppStatus>, trips: Trip[], checks = 0): ValleyStats {
  const read = world.plots.flatMap((p) => (p.requests === undefined ? [] : [p.requests]));
  const uptimes = world.plots.flatMap((p) => {
    const status = statuses.get(p.slug);
    return status?.uptime30d === undefined ? [] : [{ pct: status.uptime30d, watchedMs: status.uptimeWatchedMs, app: { slug: p.slug, name: p.name } }];
  });
  const lowest = world.failed ? undefined : uptimes.reduce<(typeof uptimes)[number] | undefined>((low, u) => (!low || u.pct < low.pct ? u : low), undefined);
  const count = (kind: TripFacts["kind"]) => trips.filter((t) => t.facts.kind === kind).length;
  return {
    total: world.plots.length,
    running: world.plots.filter((p) => p.moving).length,
    ...(read.length ? { requests: read.reduce((a, b) => a + b, 0) } : {}),
    requestsFrom: read.length,
    ...(lowest ? { lowestUptime: lowest.pct, lowestUptimeApp: lowest.app, ...(lowest.watchedMs === undefined ? {} : { lowestUptimeWatchedMs: lowest.watchedMs }) } : {}),
    notRunning: world.plots.filter((p) => !p.moving).map((p) => ({ slug: p.slug, state: p.state })).sort((a, b) => worstness(a.state) - worstness(b.state)),
    deploying: world.plots.filter((p) => p.work === "deploying").map((p) => ({ slug: p.slug, name: p.name })),
    cars: count("traffic"),
    vans: count("check"),
    checks,
    trucks: count("deploy"),
  };
}
