import { HILL_REACH } from "./hill.ts";

import { bend, CURVE_REACH, turnAt, unbend } from "./lay.ts";

// The valley's layout: where everything stands. No drawing here, so Node can test it.
// A highway comes in from one side and becomes the main road, and everything hangs off that:
// your apps in front of it, the services behind them across a green belt on higher ground,
// and the watcher's dish on a hill behind those. A road up from the main road, the spine,
// runs past the services to the hill. Every place depends only on its own number, so adding
// one never moves another, and a problem never rearranges the map.
//
// Worked out on straight lines, u along the valley and v across it; lay.ts bends them onto
// the ground. A Spot is where something really stands.

export const BLOCK = 6.6; // from one campus to the next, roads included
const FIRST_ROW = 3.9; // from the main road's middle to the first campuses
export const MAIN_HALF = 1;
export const FREEWAY_HALF = 1.7;
export const STREET_HALF = 0.3;
export const CAMPUS_SCALE = 2; // a campus is modelled a unit or so across, then scaled
export const LOT_Z = 2.04; // from a campus's middle to its car park
export const LOT_END_X = 1; // how far into the car park a driveway reaches

export const SPINE = BLOCK / 2; // u of the road up to the hill
export const SERVICE_EDGE = -9.4; // v of the street along the front of the services' yard
export const HIGHWAY_FROM = SPINE + BLOCK; // u where the highway has become the main road
const COLUMNS = 40;
const ROWS = 12;
const SERVICES_IN_A_ROW = 6;
const HILL_CLEARANCE = 2; // from the last road to the foot of the hill

export type Spot = { x: number; y: number; turn: number };
export type Zone = { minU: number; maxU: number; minV: number; maxV: number };
export type Box = { minX: number; maxX: number; minZ: number; maxZ: number };
export type Segment = { x1: number; z1: number; x2: number; z2: number };
// A road on the straight lines: x along the valley and z across, before they're bent.
export type Road = Segment;

const standAt = (u: number, v: number): Spot => {
  const { x, z } = bend(u, v);
  return { x, y: z, turn: turnAt(x) };
};
const rowV = (row: number) => FIRST_ROW + (row - 1) * BLOCK;

// Nearest the highway first, filling along the road much faster than away from it, so the
// apps stay wide and shallow and hide as little as they can of what's behind them.
const SLOTS: Spot[] = (() => {
  const all: { col: number; row: number; score: number }[] = [];
  for (let col = 0; col <= COLUMNS; col++) {
    for (let row = 1; row <= ROWS; row++) all.push({ col, row, score: col + (row - 1) * 2.5 });
  }
  all.sort((a, b) => a.score - b.score || a.col - b.col || a.row - b.row);
  return all.map(({ col, row }) => standAt(-col * BLOCK, rowV(row)));
})();

export function slotAt(index: number): Spot {
  return SLOTS[index] ?? standAt(-(COLUMNS + 1 + index - SLOTS.length) * BLOCK, rowV(1));
}

// The services' zone, straight behind the apps across the belt, from the same end.
export function serviceSpot(index: number): Spot {
  const col = index % SERVICES_IN_A_ROW;
  const row = Math.floor(index / SERVICES_IN_A_ROW);
  return standAt(-col * BLOCK, SERVICE_EDGE - BLOCK / 2 - row * BLOCK);
}

// The dish: its hill's foot is on the spine, so the road carries straight on up it. It only
// moves back if the services need another row.
export function watcherSpot(services: Spot[]): Spot {
  const rear = Math.min(SERVICE_EDGE, ...services.map((s) => unbend(s.x, s.y).v - BLOCK / 2));
  const foot = bend(SPINE, rear - HILL_CLEARANCE - HILL_REACH);
  return { x: foot.x - HILL_REACH, y: foot.z, turn: 0 };
}

// How big a roof sign can be on a roof whose short side is this long (in a campus's own
// units), so that nothing touches the roof's raised edge, even as the sign swings round.
const SIGN_EDGE = 0.05; // the raised edge, and a little air
const SIGN_FRAME = 0.03; // the board's frame, past the screen, each side
export const SIGN_BASE_PAST_DISK = 0.04; // the fixed base, past the turning disk, each side
const SMALLEST_SIGN = 0.3;

export function signFit(room: number, wanted: number): { size: number; radius: number } {
  const size = Math.max(SMALLEST_SIGN, Math.min(wanted, room - 2 * (SIGN_EDGE + SIGN_FRAME)));
  return { size, radius: Math.min(size * 0.56, room / 2 - SIGN_EDGE - SIGN_BASE_PAST_DISK) };
}

// The land grows with how many apps there are. It's all one world on one screen, so
// nothing's ever out of sight behind a level, and it only says how many apps you have.
export type WorldStage = "orchards" | "town" | "valley";
export const STAGE_ORDER: WorldStage[] = ["orchards", "town", "valley"];

export function worldStage(apps: number): WorldStage {
  return apps <= 3 ? "orchards" : apps <= 9 ? "town" : "valley";
}

// How far the flat valley floor reaches past the district.
const FLOOR: Record<WorldStage, number> = { orchards: 12, town: 22, valley: 36 };

export type ValleyPlan = Box & {
  stage: WorldStage;
  floor: number;
  apps: Zone;
  services: Zone | null; // none yet: nothing's there but the spine
  roads: Road[];
  junctions: { u: number; v: number }[]; // where a street meets a street
  watcher: Spot;
  taken: Spot[]; // the blocks that have something on them
};

// Streets only round the blocks that have something on them, so a zone's edge looks grown,
// not a grid laid out in advance. An avenue runs from the road nearest the main road (from)
// to the deepest block beside it. A block's near edge is a street unless that's the main road.
function streetsRound(blocks: { u: number; v: number }[], from: number, nearEdgeIsStreet: boolean, skipAvenue: number | null) {
  const half = BLOCK / 2;
  const away = from > 0 ? 1 : -1;
  const key = (a: number, b: number) => `${a.toFixed(2)},${b.toFixed(2)}`;
  const deepest = new Map<string, { u: number; to: number }>();
  const rows = new Map<string, Road>();
  const junctions = new Map<string, { u: number; v: number }>();
  for (const { u, v } of blocks) {
    const far = v + away * half;
    for (const side of [u - half, u + half]) {
      const k = side.toFixed(2);
      const had = deepest.get(k);
      if (!had || (far - had.to) * away > 0) deepest.set(k, { u: side, to: far });
    }
    for (const edge of nearEdgeIsStreet ? [v - away * half, far] : [far]) {
      rows.set(key(u, edge), { x1: u - half, z1: edge, x2: u + half, z2: edge });
      junctions.set(key(u - half, edge), { u: u - half, v: edge });
      junctions.set(key(u + half, edge), { u: u + half, v: edge });
    }
  }
  const avenues = [...deepest.values()].filter((a) => skipAvenue === null || Math.abs(a.u - skipAvenue) > 0.01).map((a): Road => ({ x1: a.u, z1: from, x2: a.u, z2: a.to }));
  return { roads: [...avenues, ...rows.values()], junctions: [...junctions.values()] };
}

export function valleyPlan(world: { plots: Spot[]; utilities: Spot[]; watcher: Spot }): ValleyPlan {
  const pick = ({ x, y, turn }: Spot) => ({ x, y, turn });
  const taken = [...world.plots.map(pick), ...world.utilities.map(pick)];
  const half = BLOCK / 2;
  const { watcher } = world;
  const plots = world.plots.map((s) => unbend(s.x, s.y));
  const utilities = world.utilities.map((s) => unbend(s.x, s.y));
  const apps: Zone = {
    minU: Math.min(-BLOCK - half, ...plots.map((s) => s.u - half)),
    maxU: SPINE,
    minV: 0,
    maxV: Math.max(FIRST_ROW + half, ...plots.map((s) => s.v + half)),
  };
  const services: Zone | null = utilities.length === 0 ? null : {
    minU: Math.min(...utilities.map((s) => s.u - half)),
    maxU: SPINE,
    minV: Math.min(...utilities.map((s) => s.v - half)),
    maxV: SERVICE_EDGE,
  };
  const appStreets = streetsRound(plots, MAIN_HALF, false, null);
  const serviceStreets = streetsRound(utilities, SERVICE_EDGE, true, SPINE);
  const hillFoot = unbend(watcher.x + HILL_REACH, watcher.y).v;
  const spine: Road = { x1: SPINE, z1: -MAIN_HALF, x2: SPINE, z2: hillFoot };
  const stage = worldStage(world.plots.length);
  const left = bend(apps.minU, 0).x;
  return {
    stage,
    minX: Math.min(left, watcher.x - HILL_REACH),
    maxX: bend(SPINE + BLOCK * 1.5, 0).x,
    minZ: watcher.y - HILL_REACH,
    maxZ: apps.maxV + CURVE_REACH,
    floor: FLOOR[stage],
    apps,
    services,
    roads: [...appStreets.roads, ...serviceStreets.roads, spine],
    junctions: [...appStreets.junctions, ...serviceStreets.junctions],
    watcher: pick(watcher),
    taken,
  };
}

// The main road and the highway it becomes, on the straight lines, from the far end of the
// apps out through the gap in the hills. The width narrows from one to the other.
export function mainRoad(plan: ValleyPlan, run: number): { u: number; half: number }[] {
  const out: { u: number; half: number }[] = [];
  const end = HIGHWAY_FROM + run;
  const taper = (u: number) => Math.max(0, Math.min(1, (u - HIGHWAY_FROM) / 10));
  for (let u = plan.apps.minU; u < end; u += u < HIGHWAY_FROM + 40 ? 1.2 : 6) {
    const t = taper(u);
    out.push({ u, half: MAIN_HALF + (FREEWAY_HALF - MAIN_HALF) * t * t * (3 - 2 * t) });
  }
  out.push({ u: end, half: FREEWAY_HALF });
  return out;
}

// What the land depends on: the same signature, the same land, so it's built once.
export function planKey(plan: ValleyPlan): string {
  return `${plan.stage}|${plan.minX},${plan.maxX},${plan.minZ},${plan.maxZ}|${plan.watcher.x},${plan.watcher.y}|${plan.taken.map((s) => `${s.x},${s.y}`).join(";")}`;
}
