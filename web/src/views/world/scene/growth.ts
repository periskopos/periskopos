import * as THREE from "three";
import { FOOTPRINT, growMs, riseShare, widenShare } from "../../../../../shared/valley/growth.ts";
import type { PlotGrowth } from "../../../../../shared/valley/growth.ts";
import { CAMPUS_SCALE } from "../../../../../shared/valley/plan.ts";
import { FLOOR_H } from "./effects.ts";

// Seeing a place grow. Its building stands sunk in its plot, with the ground hiding what's
// below, and comes up a floor at a time. Its lights and lines come on once it's up. Nothing
// here decides what grew: shared/valley/growth.ts does, from what's really changed.

const SHADOWS_EVERY_MS = 250;

type Growing = { grown: PlotGrowth; delay: number; start: number | null };

export type GrowthDeps = {
  standing(id: string): THREE.Group | undefined;
  redrawShadows(): void;
  finished(): void; // something's up: its lights and lines can come on
};

export function createGrowth({ standing, redrawShadows, finished }: GrowthDeps) {
  const live = new Map<string, Growing>();
  let lastShadows = 0;

  function show(group: THREE.Group, { grown }: Growing, ms: number) {
    const rising = group.userData.rising as THREE.Group;
    const sink = (grown.rise ? (rising.userData.height as number) : grown.floors * FLOOR_H) * (1 - riseShare(ms, grown.floors));
    rising.position.y = -sink;
    group.userData.top = (group.userData.standingTop as number) - sink * CAMPUS_SCALE;
    if (!grown.wider) return;
    const from = FOOTPRINT[grown.wider] / (rising.userData.footprint as number);
    const scale = from + (1 - from) * widenShare(ms, grown.floors);
    rising.scale.set(scale, 1, scale);
  }

  function settle(group: THREE.Group | undefined) {
    const rising = group?.userData.rising as THREE.Group | undefined;
    if (!group || !rising) return;
    rising.position.y = 0;
    rising.scale.set(1, 1, 1);
    group.userData.top = group.userData.standingTop;
  }

  return {
    begin(id: string, grown: PlotGrowth, delay: number) {
      const group = standing(id);
      if (!group?.userData.rising) return;
      const growing: Growing = { grown, delay, start: null };
      live.set(id, growing);
      show(group, growing, 0); // straight away, so it's never seen standing first
    },
    isGrowing: (id: string) => live.has(id),
    busy: () => live.size > 0,
    tick(t: number) {
      if (live.size === 0) return;
      let done = false;
      for (const [id, growing] of live) {
        const group = standing(id);
        // Gone, or become a plot with no building on it: nothing left to bring up.
        if (!group?.userData.rising) {
          live.delete(id);
          done = true;
          continue;
        }
        growing.start ??= t + growing.delay;
        const ms = t - growing.start;
        // A still picture has no time to grow in.
        if (t === 0 || ms >= growMs(growing.grown.floors)) {
          settle(group);
          live.delete(id);
          done = true;
        } else show(group, growing, Math.max(0, ms));
      }
      if (done) {
        finished();
        redrawShadows();
      } else if (t - lastShadows > SHADOWS_EVERY_MS) {
        lastShadows = t;
        redrawShadows();
      }
    },
  };
}
