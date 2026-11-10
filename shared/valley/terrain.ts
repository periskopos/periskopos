import { hillAt } from "./hill.ts";
import { riseAt, unbend } from "./lay.ts";
import { FREEWAY_HALF } from "./plan.ts";
import type { ValleyPlan } from "./plan.ts";

// The land's shape, as a plain function of where you are: the same place is always the
// same height, so nothing has to be stored and scenery can be stood on it.

// A steady 0..1 from a name, so a thing looks the same every time.
export function hash(text: string, n = 0): number {
  let h = 2166136261 ^ n;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function lattice(x: number, z: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(z | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const smooth = (from: number, to: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

export function noise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const near = lattice(ix, iz) * (1 - u) + lattice(ix + 1, iz) * u;
  const far = lattice(ix, iz + 1) * (1 - u) + lattice(ix + 1, iz + 1) * u;
  return near * (1 - v) + far * v;
}

export function fbm(x: number, z: number, octaves = 4): number {
  let total = 0;
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  for (let i = 0; i < octaves; i++) {
    total += noise(x * freq + i * 17, z * freq - i * 31) * amp;
    sum += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return total / sum;
}

// A sharp-crested version, for the mountains: 1 along the ridgelines.
const ridged = (x: number, z: number) => 1 - Math.abs(fbm(x, z, 4) * 2 - 1);

// How far past the valley floor a place is. Counted slower along the valley than across
// it, so the land stays long and narrow and the ranges run either side.
export function pastFloor(plan: ValleyPlan, x: number, z: number): number {
  const dx = Math.max(plan.minX - plan.floor * 1.5 - x, x - plan.maxX - plan.floor * 1.5, 0);
  const dz = Math.max(plan.minZ - plan.floor - z, z - plan.maxZ - plan.floor, 0);
  return Math.hypot(dx * 0.55, dz);
}

// The land without the dish's hill, which is modelled on its own, more finely than the
// ground can be.
export function landAt(plan: ValleyPlan, x: number, z: number): number {
  const rise = riseAt(x, z);
  const d = pastFloor(plan, x, z);
  if (d <= 0) return rise;
  const foot = smooth(0, 45, d) * (0.8 + fbm(x * 0.05, z * 0.05) * 2.8);
  const range = smooth(35, 130, d) * (3 + ridged(x * 0.022, z * 0.022) * 19);
  // The highway comes in through a gap in the hills, on the level. The other end is closed.
  const gap = 1 - smooth(plan.maxX - 5, plan.maxX + 5, x) * (1 - smooth(FREEWAY_HALF + 2, FREEWAY_HALF + 18, Math.abs(unbend(x, z).v)));
  return rise + (foot + range) * gap;
}

export function heightAt(plan: ValleyPlan, x: number, z: number): number {
  return landAt(plan, x, z) + hillAt(plan.watcher, x, z);
}

// What colour the ground is: watered green on the floor, gold on the foothills, with dark
// patches of oak, going to dusty sage up on the ranges.
export function groundTone(height: number, x: number, z: number): [number, number, number] {
  const patch = fbm(x * 0.11, z * 0.11, 3);
  const fine = noise(x * 0.9, z * 0.9);
  const floor: [number, number, number] = [0.3 + patch * 0.14, 0.38 + patch * 0.1, 0.15 + patch * 0.05];
  const gold: [number, number, number] = [0.6, 0.47, 0.2];
  const oak: [number, number, number] = [0.3, 0.37, 0.2];
  const sage: [number, number, number] = [0.42, 0.45, 0.33];
  const up = smooth(0.2, 3.5, height);
  const high = smooth(5, 15, height);
  const oaks = smooth(0.52, 0.62, patch) * smooth(0.5, 3, height);
  return [0, 1, 2].map((i) => {
    const land = floor[i]! * (1 - up) + gold[i]! * up;
    const treed = land * (1 - oaks * 0.85) + oak[i]! * oaks * 0.85;
    const tone = treed * (1 - high) + sage[i]! * high;
    return tone * (0.93 + fine * 0.14);
  }) as [number, number, number];
}
