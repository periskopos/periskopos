import type { WatcherLog } from "../../../../shared/types.ts";
import { checksLately } from "../../../../shared/valley/trips.ts";
import type { Plot, Utility, World } from "../../../../shared/world.ts";
import { ago, STATE_LABEL } from "../../format.ts";
import type { LampState } from "../../ui.ts";

// What each thing on the map says about itself, in one place: the labels over the picture and
// the key beside the legend both read it from here, so the two can't disagree.

export type StatusId = "down" | "trouble" | "attention" | "push" | "stopped" | "unknown" | "unread" | "stale" | "checking" | "deploying" | "maintenance" | "prelaunch" | "none" | "up";
export type Status = { id: StatusId; lamp: LampState; word: string; seen: string };

// Worst first, so what needs a look comes first in the key.
export const STATUSES: Status[] = [
  { id: "down", lamp: "down", word: STATE_LABEL.down, seen: "dark, with smoke, a fast red light and a red screen" },
  { id: "trouble", lamp: "down", word: "Having trouble", seen: "a service with a red light and screen, and solid lines to its apps" },
  { id: "attention", lamp: "attention", word: STATE_LABEL.attention, seen: "an amber light flashing over its sign, and an amber screen" },
  { id: "push", lamp: "attention", word: "Push not live", seen: "a truck stopped at the door" },
  { id: "stopped", lamp: "attention", word: "Not checking", seen: "the watcher's dish has stopped" },
  { id: "unknown", lamp: "unknown", word: STATE_LABEL.unknown, seen: "in the fog, not known to be fine" },
  { id: "unread", lamp: "unknown", word: "Not read lately", seen: "a service with no light and grey lines" },
  { id: "stale", lamp: "stale", word: STATE_LABEL.stale, seen: "frozen over, nothing moves" },
  { id: "checking", lamp: "checking", word: STATE_LABEL.checking, seen: "not read yet" },
  { id: "deploying", lamp: "info", word: "Deploying", seen: "a crane and a moving delivery truck" },
  { id: "maintenance", lamp: "info", word: "Maintenance", seen: "a service with a blue light and screen" },
  { id: "prelaunch", lamp: "prelaunch", word: STATE_LABEL.prelaunch, seen: "scaffolding" },
  { id: "none", lamp: "none", word: STATE_LABEL.none, seen: "a fenced, empty plot" },
  { id: "up", lamp: "up", word: STATE_LABEL.up, seen: "lights on, a green screen, traffic on the roads" },
];

const wordOf = (id: StatusId) => STATUSES.find((s) => s.id === id)?.word ?? "";

export type Says = { status: StatusId | null; note: string; tone: string; lamp: LampState };

export function plotSays(p: Pick<Plot, "state" | "work">): Says {
  const tone = p.state === "down" ? "down" : p.state === "attention" || p.work === "waiting" ? "attention" : p.work === "deploying" || p.state === "prelaunch" ? "info" : p.state === "up" ? "quiet" : "unknown";
  if (p.state !== "up") return { status: p.state, note: STATE_LABEL[p.state], tone, lamp: p.state };
  if (p.work === "deploying") return { status: "deploying", note: wordOf("deploying"), tone, lamp: "up" };
  if (p.work === "waiting") return { status: "push", note: wordOf("push"), tone, lamp: "up" };
  return { status: "up", note: "", tone, lamp: "up" };
}

export function utilitySays(u: Pick<Utility, "look">): Says {
  if (u.look === "trouble") return { status: "trouble", note: wordOf("trouble"), tone: "down", lamp: "down" };
  if (u.look === "maintenance") return { status: "maintenance", note: wordOf("maintenance"), tone: "info", lamp: "info" };
  if (u.look === "unknown") return { status: "unread", note: wordOf("unread"), tone: "unknown", lamp: "unknown" };
  if (u.look === "ok") return { status: "up", note: "", tone: "quiet", lamp: "up" };
  return { status: null, note: "", tone: "quiet", lamp: "unknown" }; // a replay has no record of it: it claims nothing
}

// Not knowing yet isn't the same as it having stopped.
export function watcherSays(w: Pick<World, "stopped" | "watching">): Says {
  if (w.stopped) return { status: "stopped", note: wordOf("stopped"), tone: "attention", lamp: "attention" };
  return w.watching ? { status: "up", note: "", tone: "quiet", lamp: "up" } : { status: "unknown", note: "", tone: "quiet", lamp: "unknown" };
}

// The key, in the groups it's read in: what needs a look first, what's fine last.
export const KEY_GROUPS: { title: string; ids: StatusId[] }[] = [
  { title: "Needs a look", ids: ["down", "trouble", "attention", "push", "stopped"] },
  { title: "Under way", ids: ["checking", "deploying", "maintenance"] },
  { title: "Not known", ids: ["unknown", "unread", "stale"] },
  { title: "Fine", ids: ["prelaunch", "none", "up"] },
];

export type KeyRow = Status & { places: Place[] };

// Every status, grouped, each with what has it on the map now (none, for most).
export function keyGroups(onMap: Pick<OnMap, "id" | "places">[]): { title: string; rows: KeyRow[] }[] {
  const having = new Map(onMap.map((s) => [s.id, s.places]));
  return KEY_GROUPS.map(({ title, ids }) => ({ title, rows: ids.map((id) => ({ ...STATUSES.find((s) => s.id === id)!, places: having.get(id) ?? [] })) }));
}

export type Place = { kind: "app" | "provider" | "tower"; id: string; name: string };
export type OnMap = Status & { names: string[]; places: Place[] };

// Every status something on the map has now, and what has it: apps, services and the watcher.
export function statusesOnMap(world: Pick<World, "plots" | "utilities" | "stopped" | "watching">): OnMap[] {
  const having = new Map<StatusId, Place[]>();
  const note = (status: StatusId | null, place: Place) => {
    if (status) having.set(status, [...(having.get(status) ?? []), place]);
  };
  for (const p of world.plots) note(plotSays(p).status, { kind: "app", id: p.slug, name: p.name });
  for (const u of world.utilities) note(utilitySays(u).status, { kind: "provider", id: u.id, name: u.label });
  note(watcherSays(world).status, { kind: "tower", id: "watcher", name: "The watcher" });
  return STATUSES.flatMap((status) => {
    const places = having.get(status.id);
    return places ? [{ ...status, names: places.map((p) => p.name), places }] : [];
  });
}

export const placeKey = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;

// The key steps through what has a status, one click at a time: the one after the last it
// showed, round to the first again. If that one has since moved on, it starts from the first.
export function nextPlace(places: Place[], last: string | undefined): Place | undefined {
  if (places.length === 0) return undefined;
  const at = last === undefined ? -1 : places.findIndex((p) => placeKey(p) === last);
  return places[(at + 1) % places.length];
}

export function statusTitle({ word, seen, names }: Pick<OnMap, "word" | "seen" | "names">, most = 6): string {
  const shown = names.slice(0, most).join(", ");
  const go = names.length > 1 ? "Click to go to each in turn." : "Click to go to it.";
  return `${word}: ${seen}. ${shown}${names.length > most ? ` and ${names.length - most} more` : ""}. ${go}`;
}

// The watcher's figure says when it last looked. A count of checks reads as "nothing's been
// checked" whenever it's 0, which is also what it is before the log has been read.
export function lastCheckSaid({ world, checks, read, off, now }: { world: World; checks: WatcherLog["checks"]; read: boolean; off: boolean; now: number }): { value: string; note?: string } {
  if (!read) return { value: "Not read" };
  if (off) return { value: "Turned off", note: "in Settings" };
  const slugs = new Set(world.plots.map((p) => p.slug));
  const newest = checks.filter((row) => slugs.has(row.slug)).reduce<string | undefined>((latest, row) => (!latest || Date.parse(row.at) > Date.parse(latest) ? row.at : latest), undefined);
  const when = newest && ago(newest, now);
  if (world.stopped) return when ? { value: "Not checking", note: `last ${when}` } : { value: "Not checking" };
  if (!when) return { value: "None yet", note: "by the watcher" };
  const lately = checksLately({ world, checks, now });
  return { value: when.charAt(0).toUpperCase() + when.slice(1), note: lately > 0 ? `${lately} in 2 min` : "by the watcher" };
}
