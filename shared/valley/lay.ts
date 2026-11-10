// How the land lies. The layout is worked out on straight lines: u along the valley, v across
// it, with the main road at v = 0. This bends that onto the ground: the main road and the
// streets beside it follow one gentle curve, and the blocks vary a little in width. It also
// gives the rise behind the main road, which lifts the services and the dish into view over
// the apps. All plain functions, the same every time.

const WIDEN = 0.2; // how far a block's edge moves from where a straight grid would put it
const WIDEN_RATE = 0.29;
const CURVE = [
  { size: 2.2, rate: 0.05, from: 0.6 },
  { size: 0.7, rate: 0.13, from: 2 },
];

export const RISE_FROM = -2.4; // where the ground starts to climb, clear of the highway
export const RISE_TO = -9; // and where it levels off
export const RISE_HEIGHT = 1.5;

const smooth = (from: number, to: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

const curveAt = (x: number) => CURVE.reduce((sum, c) => sum + c.size * Math.sin(x * c.rate + c.from), 0);
const slopeAt = (x: number) => CURVE.reduce((sum, c) => sum + c.size * c.rate * Math.cos(x * c.rate + c.from), 0);
const widened = (u: number) => u + WIDEN * Math.sin(u * WIDEN_RATE);

export const curveOf = curveAt;
export const CURVE_REACH = CURVE.reduce((sum, c) => sum + c.size, 0);

export function bend(u: number, v: number): { x: number; z: number } {
  const x = widened(u);
  return { x, z: v + curveAt(x) };
}

export function unbend(x: number, z: number): { u: number; v: number } {
  let u = x;
  for (let i = 0; i < 4; i++) u -= (widened(u) - x) / (1 + WIDEN * WIDEN_RATE * Math.cos(u * WIDEN_RATE));
  return { u, v: z - curveAt(x) };
}

// Which way a street runs here, as dx = 1, dz = this.
export const streetSlope = slopeAt;

// A building turns half as far as the street beside it: avenues run straight and streets
// curve, so this leaves it the same clear of both.
export const turnAt = (x: number) => -Math.atan(slopeAt(x)) / 2;

export const riseAt = (x: number, z: number) => RISE_HEIGHT * smooth(RISE_FROM, RISE_TO, z - curveAt(x));
