import { DISH_DOOR, hillRoad } from "./hill.ts";
import { bend, unbend } from "./lay.ts";
import { BLOCK, HIGHWAY_FROM, LOT_END_X, LOT_Z, SERVICE_EDGE, SPINE } from "./plan.ts";
import type { Spot, ValleyPlan } from "./plan.ts";

// The roads a vehicle takes, along the middle of each road. Which side of the road it
// keeps to is worked out as it goes, so going back is the same route in reverse.

export type Waypoint = { x: number; z: number; lane: number }; // lane: how far right of the middle, from this point on
export type Route = { points: Waypoint[]; at: number[]; length: number };

export const STREET_LANE = 0.14;
const FREEWAY_LANES = [0.72, 1.18];
const MAIN_LANE = 0.5;
const ALONG_STEP = 2; // how close together points are on a road that curves
const FAR = 45; // how far along the freeway, past the district, traffic comes from
const ROUND = 0.3; // how sharply it takes a corner
const LANE_CHANGE = 2;

export function makeRoute(raw: Waypoint[]): Route {
  const points = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1]!.x, p.z - raw[i - 1]!.z) > 0.001);
  const at = [0];
  for (let i = 1; i < points.length; i++) at.push(at[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.z - points[i - 1]!.z));
  return { points, at, length: at[at.length - 1]! };
}

function middle(route: Route, s: number): { x: number; z: number; segment: number } {
  const d = Math.max(0, Math.min(route.length, s));
  let i = 1;
  while (i < route.points.length - 1 && route.at[i]! < d) i++;
  const a = route.points[i - 1]!;
  const b = route.points[i]!;
  const span = route.at[i]! - route.at[i - 1]! || 1;
  const t = (d - route.at[i - 1]!) / span;
  return { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t, segment: i - 1 };
}

export type Place = { x: number; z: number; heading: number };

// Where a vehicle is at distance s, going forward or back. Averaging either side of it
// rounds the corners, and on a straight changes nothing.
export function placeOn(route: Route, s: number, back: boolean, out: Place): Place {
  const ahead = middle(route, s + ROUND);
  const behind = middle(route, s - ROUND);
  let dx = ahead.x - behind.x;
  let dz = ahead.z - behind.z;
  const span = Math.hypot(dx, dz) || 1;
  dx /= span;
  dz /= span;
  const here = middle(route, s);
  const start = route.at[here.segment]!;
  const lane = route.points[here.segment]!.lane;
  const before = route.points[Math.max(0, here.segment - 1)]!.lane;
  const eased = lane + (before - lane) * Math.max(0, 1 - (Math.max(0, Math.min(route.length, s)) - start) / LANE_CHANGE);
  const towards = back ? -1 : 1;
  const fx = dx * towards;
  const fz = dz * towards;
  // To the right of the way it's heading, with up being up.
  out.x = (ahead.x + behind.x) / 2 - fz * eased;
  out.z = (ahead.z + behind.z) / 2 + fx * eased;
  out.heading = Math.atan2(fx, fz);
  return out;
}

// Along a road on the straight lines, bent onto the ground. Avenues run straight, so only
// this needs more than its two ends.
function along(fromU: number, toU: number, v: number, lane: number): Waypoint[] {
  const steps = Math.max(1, Math.ceil(Math.abs(toU - fromU) / ALONG_STEP));
  return Array.from({ length: steps + 1 }, (_, i) => ({ ...bend(fromU + ((toU - fromU) * i) / steps, v), lane }));
}

const avenueBeside = (spot: Spot) => unbend(spot.x, spot.y).u + BLOCK / 2;

// Off the avenue, along the row of the car park as the campus is turned, to the driveway's end.
function intoLot(spot: Spot): Waypoint[] {
  const s = Math.sin(spot.turn);
  const c = Math.cos(spot.turn);
  const onCampus = (x: number) => ({ x: spot.x + x * c + LOT_Z * s, z: spot.y - x * s + LOT_Z * c, lane: STREET_LANE });
  const avenue = bend(avenueBeside(spot), 0).x;
  return [onCampus((avenue - spot.x - LOT_Z * s) / c), onCampus(LOT_END_X)];
}

// Along the main road from where it was joined, up the avenue and into the car park.
const toLot = (fromU: number, spot: Spot): Waypoint[] => {
  const u = avenueBeside(spot);
  return [...along(fromU, u, 0, MAIN_LANE), ...intoLot(spot)];
};

// In along the highway from out past the hills, and along the main road to the car park.
export function trafficRoute(plan: ValleyPlan, spot: Spot, seed: number): Route {
  const edge = unbend(plan.maxX + FAR, 0).u;
  const lane = FREEWAY_LANES[seed * 10 % 1 < 0.5 ? 0 : 1]!;
  return makeRoute([...along(edge, HIGHWAY_FROM, 0, lane), ...toLot(HIGHWAY_FROM, spot)]);
}

// From the dish: down the road round the hill, down the spine to the main road, and along it.
export function checkRoute(plan: ValleyPlan, spot: Spot): Route {
  const down = hillRoad(plan.watcher, 0.9).reverse().map((p) => ({ x: p.x, z: p.z, lane: STREET_LANE }));
  return makeRoute([{ x: plan.watcher.x + DISH_DOOR.x, z: plan.watcher.y + DISH_DOOR.z, lane: STREET_LANE }, ...down, ...toLot(SPINE, spot)]);
}

// From a service's yard: up its avenue, along the front of the yard to the spine, down to the
// main road, and along it.
export function deliveryRoute(source: Spot, spot: Spot): Route {
  const [door, end] = intoLot(source) as [Waypoint, Waypoint];
  const avenue = avenueBeside(source);
  return makeRoute([end, door, ...along(avenue, SPINE, SERVICE_EDGE, STREET_LANE), ...toLot(SPINE, spot)]);
}
