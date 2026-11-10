import type { Growth } from "../../../../../shared/valley/growth.ts";
import type { Trip } from "../../../../../shared/valley/trips.ts";
import type { World } from "../../../../../shared/world.ts";

export type Sky = "clock" | "theme";

// "tower" is the dish, which stands for the watcher; "trip" is a vehicle on the road.
export type Selection = { kind: "app" | "provider" | "tower" | "trip"; id: string } | null;
export type Standing = "app" | "provider" | "tower";

export type WorldScene = {
  // announce: false when it's the view jumping, not the facts changing. grown: what's really
  // grown since this was last seen.
  update(world: World, announce?: boolean, grown?: Growth): void;
  setTrips(trips: Trip[]): void;
  select(selection: Selection): void;
  zoomBy(factor: number): void;
  nudge(dx: number, dy: number): void; // moves the map, in pixels
  focusOn(kind: Standing, id: string): void;
  turn(quarters: number): void; // walks the camera round the valley
  zoomLevel(): number;
  zoomRoom(): { nearer: boolean; farther: boolean }; // whether + and − can still do anything
  descend(): void; // comes down from higher up, as the page opens
  setSky(mode: Sky): void;
  resetView(): void;
  // Where a thing's label belongs, in pixels within the host; null if off to the side.
  anchor(kind: Standing, id: string): { x: number; y: number } | null;
  // What the radar needs: which way is up on the screen, and where the dish points now
  // (null when it isn't turning, because nothing's being checked).
  radarView(): { right: [number, number]; forward: [number, number]; beam: number | null };
  destroy(): void;
};

export type SceneOptions = {
  onSelect(selection: Selection): void;
  onHover(selection: Selection): void;
  onFrame(): void;
  reservedRight(): number;
  onGraphics(lost: boolean): void;
  sky: Sky;
};
