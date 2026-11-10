import { placeApps } from "../../../../shared/world.ts";
import type { WorldStage } from "../../../../shared/world.ts";
import { stageRose } from "../../../../shared/world.ts";
import { parseSeen } from "../../../../shared/valley/growth.ts";
import type { Seen } from "../../../../shared/valley/growth.ts";
import type { Sky } from "./scene/types.ts";

// What this computer remembers about the map. Any of it can be refused by the browser, so
// each read has a fallback and the page never depends on it.

const PLACES_KEY = "periskopos-world-places";
const SKY_KEY = "periskopos-world-sky";
const STAGE_KEY = "periskopos-world-stage";
const SEEN_KEY = "periskopos-world-seen";

export function savedPlaces(): Record<string, number> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PLACES_KEY) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    // Only whole numbers are places: anything else (an old or hand-edited value) is forgotten.
    return Object.fromEntries(Object.entries(saved).filter(([, place]) => Number.isInteger(place))) as Record<string, number>;
  } catch {
    return {};
  }
}

// A service keeps its place too, under its own kind of name, even when this read of the
// providers doesn't mention it.
const SERVICE = "service:";

export function servicePlacesFrom(saved: Record<string, number>, ids: string[]): Record<string, number> {
  const mine = Object.fromEntries(Object.entries(saved).flatMap(([key, place]) => (key.startsWith(SERVICE) ? [[key.slice(SERVICE.length), place]] : [])));
  const away = Object.entries(mine).flatMap(([id, place]) => (ids.includes(id) ? [] : [place]));
  return { ...mine, ...placeApps(ids, mine, away) };
}

export const withServicePlaces = (places: Record<string, number>, services: Record<string, number>) => ({ ...places, ...Object.fromEntries(Object.entries(services).map(([id, place]) => [SERVICE + id, place])) });

export function savePlaces(places: Record<string, number>) {
  try {
    localStorage.setItem(PLACES_KEY, JSON.stringify(places));
  } catch {
    // not remembered: the map still draws, by the order the apps came in
  }
}

export function savedSky(): Sky {
  try {
    return localStorage.getItem(SKY_KEY) === "theme" ? "theme" : "clock";
  } catch {
    return "clock";
  }
}

export function saveSky(sky: Sky) {
  try {
    localStorage.setItem(SKY_KEY, sky);
  } catch {
    // not remembered: it still changes for now
  }
}

// How things stood when this viewer last looked, to see what's grown since.
export function savedSeen(): Seen | null {
  try {
    return parseSeen(JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function saveSeen(seen: Seen) {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // not remembered: it can't say what's new next time, and nothing is shown as new
  }
}

// Whether the land has grown since this viewer last saw it. If what was seen can't be
// remembered, it can't say what's new.
export function stageIsNews(now: WorldStage): boolean {
  try {
    const seen = localStorage.getItem(STAGE_KEY);
    localStorage.setItem(STAGE_KEY, now);
    return stageRose(seen, now);
  } catch {
    return false;
  }
}
