// The watcher's hill and the road up it. The road leaves the spine at the hill's foot and
// winds up round it to the top, so it climbs at a grade a road could, on a shelf cut into
// the slope. All of it is plain functions of where you are.

export const HILL_REACH = 8.6;
export const HILL_HEIGHT = 3.4;
const HILL_TOP = 2.3; // flat, for the dish to stand on
const ROAD_TOP = 1.8; // where the road ends, on the flat top
// Where the vans leave from on the top: the door of the dish's shed, off-centre from the
// dish, whose pedestal stands at the very middle.
export const DISH_DOOR = { x: -0.3, z: -0.72 };
const TURNS = 1.25;
const SWEEP = TURNS * Math.PI * 2;
const SHELF = 0.4; // flat either side of the road's middle
const SHELF_EASE = 1.2; // back to the natural slope by here

type Centre = { x: number; y: number };

const smooth = (from: number, to: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

const slope = (r: number) => smooth(HILL_REACH, HILL_TOP, r) * HILL_HEIGHT;
const radiusAt = (t: number) => HILL_REACH - (HILL_REACH - ROAD_TOP) * t;
// t runs from the foot to the top. It starts on the hill's +x side, heading for -z, which is
// the way the spine arrives.
const angleAt = (t: number) => -SWEEP * t;

// How far a place is from the road, across the slope, and how far along the road that is.
function nearestOnRoad(centre: Centre, x: number, z: number): { across: number; t: number } {
  const r = Math.hypot(x - centre.x, z - centre.y);
  const a = Math.atan2(z - centre.y, x - centre.x);
  const from = ((-a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  let best = { across: Infinity, t: 0 };
  for (let turn = 0; turn <= Math.ceil(TURNS); turn++) {
    const t = (from + turn * Math.PI * 2) / SWEEP;
    if (t > 1) break;
    const across = Math.abs(r - radiusAt(t));
    if (across < best.across) best = { across, t };
  }
  return best;
}

export function hillAt(centre: Centre, x: number, z: number): number {
  const r = Math.hypot(x - centre.x, z - centre.y);
  if (r >= HILL_REACH) return 0;
  const a = Math.atan2(z - centre.y, x - centre.x);
  const bump = r > HILL_TOP ? (Math.sin(a * 3 + 1) * 0.1 + Math.sin(a * 5 + 2) * 0.05) * Math.sin(smooth(HILL_REACH, HILL_TOP, r) * Math.PI) * HILL_HEIGHT : 0;
  const natural = slope(r) + bump;
  const { across, t } = nearestOnRoad(centre, x, z);
  if (across >= SHELF_EASE) return natural;
  const shelf = 1 - smooth(SHELF, SHELF_EASE, across);
  return natural * (1 - shelf) + slope(radiusAt(t)) * shelf;
}

// How far from the road's middle a place is, for keeping trees off it.
export const fromHillRoad = (centre: Centre, x: number, z: number) => nearestOnRoad(centre, x, z).across;

// The road, from the foot to the top. Close enough together to follow the hill.
export function hillRoad(centre: Centre, step = 0.45): { x: number; z: number; y: number }[] {
  const out: { x: number; z: number; y: number }[] = [];
  const middleRadius = (HILL_REACH + ROAD_TOP) / 2;
  const count = Math.ceil((SWEEP * middleRadius) / step);
  for (let i = 0; i <= count; i++) {
    const t = i / count;
    const r = radiusAt(t);
    const a = angleAt(t);
    out.push({ x: centre.x + Math.cos(a) * r, z: centre.y + Math.sin(a) * r, y: slope(r) });
  }
  return out;
}
