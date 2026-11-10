import { campusSize } from "../world.ts";
import type { CampusSize, Plot, WorldStage } from "../world.ts";

// What's grown since this viewer last looked, and how long seeing it takes. Growth is only
// ever a real change in what's known, compared with what was seen before: the first look has
// nothing to compare with, traffic not yet read isn't traffic gone, and nothing shrinks on
// show. A place that grew while you were away grows when you come back.

export const FOOTPRINT: Record<CampusSize, number> = { small: 0.84, standard: 1, large: 1.14 };

type SeenPlot = { floors: number; built: boolean; size?: CampusSize };
export type Seen = { stage: WorldStage; plots: Record<string, SeenPlot> };

export type PlotGrowth = {
  rise: boolean; // a whole building, up out of its plot
  floors: number; // how many floors go up: all of them when it rises
  wider: CampusSize | null; // the size it was, if it's got bigger
};
export type Growth = { plots: Map<string, PlotGrowth> };

export const NO_GROWTH: Growth = { plots: new Map() };

const SIZES: CampusSize[] = ["small", "standard", "large"];
const isBuilt = (plot: Pick<Plot, "look">) => plot.look !== "empty" && plot.look !== "scaffold";
// Fog is not knowing: it says neither that a place is built nor that it isn't.
const isFog = (plot: Pick<Plot, "look">) => plot.look === "fog";
const seenPlot = (seen: Seen | null, slug: string) => (seen && Object.hasOwn(seen.plots, slug) ? seen.plots[slug] : undefined);

type Seeing = Pick<Plot, "slug" | "look" | "floors" | "requests">;

export function growthSince(before: Seen | null, plots: Seeing[]): Growth {
  if (!before) return NO_GROWTH;
  const grown = new Map<string, PlotGrowth>();
  for (const plot of plots) {
    if (!isBuilt(plot) || isFog(plot)) continue;
    const seen = seenPlot(before, plot.slug);
    if (!seen?.built) {
      grown.set(plot.slug, { rise: true, floors: Math.max(1, plot.floors), wider: null });
      continue;
    }
    const floors = Math.max(0, plot.floors - seen.floors);
    const size = plot.requests === undefined ? null : campusSize(plot);
    const wider = size && seen.size && SIZES.indexOf(size) > SIZES.indexOf(seen.size) ? seen.size : null;
    if (floors > 0 || wider) grown.set(plot.slug, { rise: false, floors, wider });
  }
  return { plots: grown };
}

export function seenNow(before: Seen | null, plots: Seeing[], stage: WorldStage): Seen {
  const seen: Seen["plots"] = {};
  for (const plot of plots) {
    // Still in the fog: as it was last seen. The first look has nothing older to go by.
    if (before && isFog(plot)) {
      const had = seenPlot(before, plot.slug);
      if (had) seen[plot.slug] = had;
      continue;
    }
    const size = plot.requests === undefined ? seenPlot(before, plot.slug)?.size : campusSize(plot);
    seen[plot.slug] = { floors: plot.floors, built: isBuilt(plot), ...(size ? { size } : {}) };
  }
  return { stage, plots: seen };
}

// What's been remembered may be anything, or from an older version: not it, then nothing.
export function parseSeen(value: unknown): Seen | null {
  if (!value || typeof value !== "object") return null;
  const { stage, plots } = value as Partial<Seen>;
  if (typeof stage !== "string" || !plots || typeof plots !== "object" || Array.isArray(plots)) return null;
  const good = Object.values(plots).every((p) => p && typeof p === "object" && typeof p.floors === "number" && typeof p.built === "boolean" && (p.size === undefined || SIZES.includes(p.size)));
  return good ? { stage, plots } : null;
}

const FLOOR_MS = 420;
const SHORTEST_MS = 1100;
const LONGEST_MS = 4200;
const NEXT_PLACE_MS = 450;
const MOST_DELAY_MS = 3000;

const smooth = (x: number) => x * x * (3 - 2 * x);

export const growMs = (floors: number) => Math.min(LONGEST_MS, Math.max(SHORTEST_MS, floors * FLOOR_MS));

// One place after another, so several are each seen, without keeping anyone waiting.
export const growDelay = (index: number) => Math.min(MOST_DELAY_MS, index * NEXT_PLACE_MS);

// How far up it's gone, from 0 to 1: a floor at a time, with a moment between them.
export function riseShare(ms: number, floors: number): number {
  const time = ms / growMs(floors);
  if (time <= 0) return 0;
  if (time >= 1) return 1;
  const count = Math.max(1, floors);
  const along = time * count;
  const done = Math.floor(along);
  return (done + smooth(Math.min(1, (along - done) / 0.8))) / count;
}

export const widenShare = (ms: number, floors: number) => smooth(Math.max(0, Math.min(1, ms / growMs(floors))));
