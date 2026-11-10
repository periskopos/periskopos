import { providersRead } from "./fleet.ts";
import type { App, AppHistory, AppState, AppStatus, DeployState, NotificationsView, ProviderStatus } from "./types.ts";
import { serviceSpot, slotAt, STAGE_ORDER, watcherSpot, worldStage } from "./valley/plan.ts";
import type { Spot, WorldStage } from "./valley/plan.ts";

export { slotAt, STAGE_ORDER, worldStage };
export type { WorldStage };

// The World view's one rule, kept here apart from the drawing so Node can test
// it: everything drawn is a fact from the same data as the Apps page. Nothing
// looks healthy, or moves, unless that data says so.

export type WorldState = AppState | "checking";

// How an app's building looks. Fog and frost are not decoration: they say
// "not known" and "not read lately", which must never pass for "fine".
export type Look = "lit" | "warning" | "dark" | "fog" | "frozen" | "empty" | "scaffold";

export const LOOK: Record<WorldState, Look> = {
  up: "lit",
  attention: "warning",
  down: "dark",
  unknown: "fog",
  checking: "fog",
  stale: "frozen",
  none: "empty",
  prelaunch: "scaffold",
};

export type Plot = {
  slug: string;
  name: string;
  state: WorldState;
  look: Look;
  moving: boolean; // only an app known to be serving, lately, shows life
  floors: number; // one for each thing watched on it
  icon?: string; // the app's own favicon, for the sign on its roof
  work: "deploying" | "waiting" | null; // a push on its way, or one that didn't go live
  deploy?: DeployState["state"]; // what was read about its pushes: no work may still not mean live
  requests?: number; // in the last 24 hours, for an app whose domain's traffic can be read
  reason?: string; // in a replay: what the record says was wrong then
  x: number;
  y: number;
  turn: number; // how far the building is turned, to sit square on its curving street
};

// "past": a replay has no record of how a provider was, so it claims nothing.
export type UtilityLook = "ok" | "trouble" | "maintenance" | "unknown" | "past";

// A provider the apps depend on, with a line to each of them.
export type Utility = {
  id: string;
  label: string;
  look: UtilityLook;
  description: string;
  apps: { slug: string; name: string }[];
  x: number;
  y: number;
  turn: number; // how far the building is turned, to sit square on its curving street
};

export type World = {
  plots: Plot[];
  utilities: Utility[];
  watcher: Spot; // where the dish stands
  watching: boolean; // the dish is turning: Periskopos really is reading its checks
  stopped: boolean; // known not to be: not the same as not knowing yet
  failed: boolean; // the last read failed, so everything here is fog, not news
};

// The light on a building's antenna. It only ever says what's known: fog, frost, a plot
// with nothing to check, or a replay's provider has no light at all, rather than one that
// could pass for fine. The worse it is, the faster it goes.
export type AntennaLight = { tone: "up" | "attention" | "down" | "info"; every: number } | null;

const CALM_MS = 3200;
const LIGHTS: Partial<Record<Look | UtilityLook, AntennaLight>> = {
  lit: { tone: "up", every: CALM_MS },
  ok: { tone: "up", every: CALM_MS },
  maintenance: { tone: "info", every: CALM_MS },
  warning: { tone: "attention", every: 1400 },
  dark: { tone: "down", every: 700 },
  trouble: { tone: "down", every: 700 },
};

export const antennaLight = (look: Look | UtilityLook): AntennaLight => LIGHTS[look] ?? null;

const MAX_FLOORS = 10; // real apps often watch six or seven things: a floor each has to stay true

// Which place each app has: the ones it had before, and the first free one for
// a new app. The apps arrive sorted by name, so going by position alone, adding
// "Alpha" would move everything. What's saved may be anything, and an app may be called
// "constructor". A place far past any real one would build roads for ever, so it's ignored;
// reserved places belong to something not on this read, and stay free for it.
const MOST_SPARE_PLACES = 500;

export function placeApps(slugs: string[], saved: Record<string, number> = {}, reserved: Iterable<number> = []): Record<string, number> {
  const places = new Map<string, number>();
  const taken = new Set<number>(reserved);
  for (const slug of slugs) {
    const place = Object.hasOwn(saved, slug) ? saved[slug] : undefined;
    if (place === undefined || !Number.isInteger(place) || place < 0 || place > slugs.length + MOST_SPARE_PLACES || taken.has(place)) continue;
    places.set(slug, place);
    taken.add(place);
  }
  let next = 0;
  for (const slug of slugs) {
    if (places.has(slug)) continue;
    while (taken.has(next)) next++;
    places.set(slug, next);
    taken.add(next);
  }
  return Object.fromEntries(places);
}

export function utilityLook(p: ProviderStatus, now: number): UtilityLook {
  // An empty or old read says nothing: not "fine", and not trouble either.
  if (!providersRead([p], now)) return "unknown";
  if (p.relevantIndicator === "none") return "ok";
  if (p.relevantIndicator === "maintenance") return "maintenance";
  return "trouble";
}

// The one line at the top of a page. "All systems normal" is a claim about everything, so it
// isn't made while a service the apps rely on is in trouble, by the same test as its red label.
// The apps themselves being fine, that's amber rather than red.
export function overallLine<State extends string>(summary: { state: State; text: string }, providers: ProviderStatus[], now: number): { state: State | "attention"; text: string } {
  const troubled = providers.filter((p) => p.apps.length > 0 && utilityLook(p, now) === "trouble").map((p) => p.label);
  const normal = summary.text === "All normal";
  const apps = briefly(summary.text);
  if (troubled.length === 0) return { state: summary.state, text: normal ? "All systems normal" : apps };
  const who = troubled.length === 1 ? troubled[0]! : troubled.length === 2 ? `${troubled[0]!} and ${troubled[1]!}` : `${troubled.length} services`;
  return { state: normal ? "attention" : summary.state, text: `${normal ? "Apps normal" : apps} · ${who} having trouble` };
}

// Three kinds of trouble at once is more than a title can hold: the worst, and how many more.
function briefly(text: string): string {
  const [worst, ...rest] = text.split(" · ");
  if (rest.length < 2) return text;
  const more = rest.reduce((sum, part) => sum + (Number.parseInt(part, 10) || 0), 0);
  return `${worst} · ${more} more need${more === 1 ? "s" : ""} a look`;
}

// Which words fit on the map. A box either always shows (a problem, or what's
// being pointed at: a crowded map must never lose those) or gets a place only if
// it's free, best first. Whatever yields is still there on hover and in the list.
export type LabelBox = { id: string; x: number; y: number; w: number; h: number; rank: number; always?: boolean };

export function chooseLabels(boxes: LabelBox[]): Set<string> {
  const overlap = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const placed = boxes.filter((b) => b.always);
  const rest = boxes.filter((b) => !b.always).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  for (const box of rest) {
    if (!placed.some((p) => overlap(p, box))) placed.push(box);
  }
  return new Set(placed.map((b) => b.id));
}

// Labels that must show can't yield, so where they'd collide they stack instead,
// the most urgent staying over its building.
export function nudgeLabels(boxes: LabelBox[]): LabelBox[] {
  const overlap = (a: LabelBox, b: LabelBox) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const placed: LabelBox[] = [];
  const firm = boxes.filter((b) => b.always).sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  for (const box of firm) {
    const moved = { ...box };
    for (let hit = placed.find((p) => overlap(p, moved)); hit; hit = placed.find((p) => overlap(p, moved))) {
      moved.y = hit.y - moved.h - 2;
    }
    placed.push(moved);
  }
  return [...placed, ...boxes.filter((b) => !b.always)];
}

// What changed between two readings, in words. A first reading, a failed one and
// the one after it aren't changes in the apps: those say nothing has happened.
export type WorldChange = { key: string; kind: "app" | "provider"; id: string; name: string; text: string; state: AppState | "checking"; at: number };

const PLOT_WORDS: Partial<Record<WorldState, string>> = {
  up: "is up",
  attention: "needs attention",
  down: "went down",
  unknown: "can't be told right now",
  stale: "stopped reporting",
  prelaunch: "isn't live yet",
  none: "has no checks now",
};

export function changesBetween(before: World, after: World, at: number): WorldChange[] {
  if (before.failed || after.failed) return [];
  const out: WorldChange[] = [];
  const was = new Map(before.plots.map((p) => [p.slug, p]));
  for (const plot of after.plots) {
    const old = was.get(plot.slug);
    if (!old || old.state === "checking" || plot.state === "checking") continue;
    const base = { key: `app:${plot.slug}`, kind: "app" as const, id: plot.slug, name: plot.name, at };
    if (old.state !== plot.state) {
      const text = plot.state === "up" && old.state === "down" ? "is back up" : PLOT_WORDS[plot.state];
      if (text) out.push({ ...base, text, state: plot.state });
    } else if (old.work !== plot.work) {
      if (plot.work === "deploying") out.push({ ...base, text: "started deploying", state: "prelaunch" });
      else if (plot.work === "waiting") out.push({ ...base, text: "has a push that isn't live", state: "attention" });
      // No work may only mean it can't be read just now: that's no news of a push going live.
      else if (plot.deploy === "live") out.push({ ...base, text: old.work === "deploying" ? "finished deploying" : "has its push live", state: plot.state });
    }
  }
  const providers = new Map(before.utilities.map((u) => [u.id, u]));
  const WORDS: Record<Exclude<UtilityLook, "past">, [string, AppState]> = { ok: ["is fine again", "up"], trouble: ["is having trouble", "down"], maintenance: ["is in maintenance", "attention"], unknown: ["hasn't been read lately", "unknown"] };
  for (const utility of after.utilities) {
    const old = providers.get(utility.id);
    if (!old || old.look === utility.look || utility.look === "past") continue;
    if (utility.look === "ok" && old.look !== "trouble" && old.look !== "maintenance") continue; // only read again: nothing was wrong
    const [text, state] = WORDS[utility.look];
    out.push({ key: `provider:${utility.id}`, kind: "provider", id: utility.id, name: utility.label, text, state, at });
  }
  return out;
}

// The feed: what the server has on record, which outlives this page, and what
// this page saw change that the server's record doesn't mention yet. Newest first.
export type FeedRow = { id: string; name: string; text: string; state: AppState | "checking"; at: number; target?: { kind: "app" | "provider"; id: string }; href?: string };

const FEED_MATCH_MS = 3 * 60_000;

export function feedRows(live: WorldChange[], notifications: NotificationsView | undefined, plots: Plot[], limit = 4): FeedRow[] {
  // By its link, since two apps can have the same name.
  const targetOf = (href: string) => {
    const plot = plots.find((p) => href === `#/apps/${encodeURIComponent(p.slug)}` || href.startsWith(`#/apps/${encodeURIComponent(p.slug)}/`));
    return plot ? { target: { kind: "app" as const, id: plot.slug } } : {};
  };
  const recorded: FeedRow[] = [];
  for (const item of notifications?.now ?? []) {
    if (item.watching || !item.since) continue;
    recorded.push({ id: `now:${item.title}:${item.since}`, name: item.title, text: item.text, state: item.state, at: Date.parse(item.since), href: item.href, ...targetOf(item.href) });
  }
  for (const item of notifications?.earlier ?? []) {
    recorded.push({ id: `was:${item.title}:${item.endedAt}`, name: item.title, text: `recovered: ${item.text}`, state: "up", at: Date.parse(item.endedAt), href: item.href, ...targetOf(item.href) });
  }
  const seen = live
    .filter((c) => !recorded.some((r) => r.target?.kind === c.kind && r.target.id === c.id && Math.abs(r.at - c.at) < FEED_MATCH_MS))
    .map((c): FeedRow => ({ id: `live:${c.key}:${c.at}`, name: c.name, text: c.text, state: c.state, at: c.at, target: { kind: c.kind, id: c.id } }));
  return [...seen, ...recorded].sort((a, b) => b.at - a.at).slice(0, limit);
}

// How many cars circle an app's block. Real requests where they can be read, one
// more car for each tenfold; otherwise a couple, which says only "it's serving".
// No requests, an empty street; an app not known to be serving, none at all.
const MAX_CARS = 8;
export function carsFor(plot: Pick<Plot, "moving" | "requests">): number {
  if (!plot.moving) return 0;
  if (plot.requests === undefined) return 2;
  if (plot.requests <= 0) return 0;
  return Math.min(MAX_CARS, 1 + Math.floor(Math.log10(plot.requests)));
}

// Whether to say the land has grown: only on going up, and not the first time this
// viewer sees it, when there's nothing to compare with.
export function stageRose(seen: string | null, now: WorldStage): boolean {
  const before = STAGE_ORDER.indexOf(seen as WorldStage);
  return before >= 0 && STAGE_ORDER.indexOf(now) > before;
}

// How much ground an app's headquarters covers. Real requests where they can be read;
// where they can't, the standard size, because that claims nothing either way. Height
// is already taken: it's the number of things watched.
export type CampusSize = "small" | "standard" | "large";

export function campusSize(plot: Pick<Plot, "requests">): CampusSize {
  if (plot.requests === undefined) return "standard";
  if (plot.requests < 1_000) return "small";
  return plot.requests < 100_000 ? "standard" : "large";
}

// How an app stood at a moment in its record. Only what the record can say: a
// stretch nobody was watching is "no data", not "up", and so is one before the app
// was watched at all or when its checks couldn't tell. An app that isn't live, or
// has no checks, is shown as it is now, since the record doesn't go into that.
export function stateAt(history: AppHistory, at: number, now: WorldState): { state: WorldState; reason?: string } {
  if (now === "prelaunch" || now === "none") return { state: now };
  if (history.gaps.some((g) => Date.parse(g.from) <= at && at < Date.parse(g.to))) return { state: "stale", reason: "Periskopos wasn't watching then" };
  const open = history.incidents.filter((i) => !i.falseAlarm && Date.parse(i.startedAt) <= at && (!i.endedAt || at < Date.parse(i.endedAt)));
  const outage = open.find((i) => i.kind === "outage");
  if (outage) return { state: "down", reason: outage.reason };
  if (open[0]) return { state: "attention", reason: open[0].reason };
  // A stretch running up to when the record was read is still going on.
  if (history.watched.some((w) => Date.parse(w.from) <= at && (at < Date.parse(w.to) || w.to === history.to))) return { state: "up" };
  const first = history.watched[0];
  return { state: "unknown", reason: first && at < Date.parse(first.from) ? "It wasn't being watched yet" : "The record doesn't say how it was then" };
}

// The world as the record says it stood then. Nothing in it moves or claims to be
// current: no traffic, no deploys, the dish stands still, and providers say nothing.
export function worldAt(live: World, histories: Map<string, AppHistory>, at: number): World {
  return {
    plots: live.plots.map((plot) => {
      const history = histories.get(plot.slug);
      const then = history ? stateAt(history, at, plot.state) : { state: "unknown" as const };
      const { requests: _requests, deploy: _deploy, ...rest } = plot;
      return { ...rest, state: then.state, look: LOOK[then.state], moving: false, work: null, ...(then.reason ? { reason: then.reason } : {}) };
    }),
    utilities: live.utilities.map((u) => ({ ...u, look: "past" as const })),
    watcher: live.watcher,
    watching: false,
    stopped: false,
    failed: false,
  };
}

// The sky by the clock: daylight from seven in the morning until six in the evening.
export function duskAt(hour: number): boolean {
  return hour < 7 || hour >= 18;
}

export type WorldInput = {
  apps: App[];
  statuses: Map<string, AppStatus>;
  providers: ProviderStatus[];
  readFailed?: boolean; // the last read of the statuses failed
  checksOff?: boolean; // checks are turned off in Settings
  watcherStopped?: boolean; // they're on, and have stopped running
  places?: Record<string, number>; // from placeApps; else in the order given
  servicePlaces?: Record<string, number>; // the same, for the services
  requests?: Map<string, number>; // by slug: the last 24 hours, where it can be read
  now: number;
};

// How much detail the picture can afford: starts at full, drops a level when
// frames keep arriving late, and tries one level better now and then, once, in
// case the machine was only busy for a while. A long gap is the window being
// covered or asleep, which says nothing about how fast it draws.
export type Pace = { level: number; average: number; lateSince: number | null; changedAt: number; climbed: boolean; settled: boolean };
export const LOWEST_DETAIL = 3;
const LATE = 1.6; // frames taking this many times as long as they should
const LATE_FOR_MS = 3000;
const CLIMB_AFTER_MS = 120_000;
const LONG_GAP_MS = 1500;

export const newPace = (now: number): Pace => ({ level: 0, average: 1, lateSince: null, changedAt: now, climbed: false, settled: false });

export function paceAfter(pace: Pace, gap: number, budget: number, now: number): Pace {
  if (gap > LONG_GAP_MS || budget <= 0) return pace;
  const average = pace.average * 0.9 + (gap / budget) * 0.1;
  if (average > LATE) {
    const lateSince = pace.lateSince ?? now;
    if (now - lateSince < LATE_FOR_MS || pace.level >= LOWEST_DETAIL) return { ...pace, average, lateSince };
    // A climb that didn't hold: this is the level for this machine, for now.
    const settled = pace.settled || (pace.climbed && now - pace.changedAt < CLIMB_AFTER_MS);
    return { level: pace.level + 1, average: 1, lateSince: null, changedAt: now, climbed: false, settled };
  }
  if (pace.level > 0 && !pace.settled && average < 1.2 && now - pace.changedAt > CLIMB_AFTER_MS) {
    return { level: pace.level - 1, average: 1, lateSince: null, changedAt: now, climbed: true, settled: false };
  }
  return { ...pace, average, lateSince: null };
}

export function buildWorld({ apps, statuses, providers, readFailed = false, checksOff = false, watcherStopped = false, places, servicePlaces, requests, now }: WorldInput): World {
  const plots = apps.map((app, i): Plot => {
    const status = readFailed ? undefined : statuses.get(app.slug);
    const state: WorldState = readFailed ? "unknown" : (status?.state ?? "checking");
    const deploy = status?.deploy?.state;
    const serving = state === "up" || state === "attention";
    const served = requests?.get(app.slug);
    return {
      slug: app.slug,
      name: app.name,
      ...(app.icon ? { icon: app.icon } : {}),
      state,
      look: LOOK[state],
      moving: serving,
      floors: Math.max(1, Math.min(MAX_FLOORS, app.connections.length)),
      work: !serving ? null : deploy === "deploying" ? "deploying" : deploy === "not-deployed" ? "waiting" : null,
      ...(deploy ? { deploy } : {}),
      ...(served === undefined ? {} : { requests: served }),
      ...slotAt(places && Object.hasOwn(places, app.slug) ? places[app.slug]! : i),
    };
  });

  const used = providers.filter((p) => p.apps.length > 0).sort((a, b) => a.id.localeCompare(b.id));
  const utilities = used.map((p, i): Utility => ({
    id: p.id,
    label: p.label,
    look: readFailed ? "unknown" : utilityLook(p, now),
    description: p.description,
    apps: p.apps,
    ...serviceSpot(servicePlaces?.[p.id] ?? i),
  }));

  // Live apps whose checks have all stopped: the dish isn't watching anything.
  const live = plots.filter((p) => p.state !== "prelaunch" && p.state !== "none");
  // Down and needs attention never go stale, so an app saying so says nothing about the
  // dish: the watcher's own word comes first.
  const FRESH: WorldState[] = ["up", "attention", "down"];
  const halted = checksOff || watcherStopped;
  const watching = !readFailed && !halted && live.some((p) => FRESH.includes(p.state));
  const stopped = !readFailed && live.length > 0 && (halted || live.every((p) => p.state === "stale"));
  const watcher = watcherSpot(utilities);
  return { plots, utilities, watcher, watching, stopped, failed: readFailed };
}

// The radar on the watcher's panel: each thing on the map, at its real bearing and
// distance from the dish. reach is at most 0.9, at the farthest thing, so nothing sits
// on the rim.
export type RadarTone = "up" | "attention" | "down" | "info" | "unknown";
export type RadarBlip = { kind: "app" | "provider"; id: string; name: string; x: number; z: number; reach: number; tone: RadarTone };

export function radarBlips(world: World): RadarBlip[] {
  const toneOf = (state: WorldState): RadarTone => (state === "up" || state === "attention" || state === "down" ? state : state === "prelaunch" ? "info" : "unknown");
  const lookOf = (look: UtilityLook): RadarTone => (look === "ok" ? "up" : look === "trouble" ? "down" : look === "maintenance" ? "info" : "unknown");
  const seen = (x: number, y: number) => ({ x: x - world.watcher.x, z: y - world.watcher.y });
  const things = [
    ...world.plots.map((p) => ({ kind: "app" as const, id: p.slug, name: p.name, ...seen(p.x, p.y), tone: toneOf(p.state) })),
    ...world.utilities.map((u) => ({ kind: "provider" as const, id: u.id, name: u.label, ...seen(u.x, u.y), tone: lookOf(u.look) })),
  ];
  const farthest = Math.max(1, ...things.map((t) => Math.hypot(t.x, t.z)));
  return things.map((t) => ({ ...t, reach: (Math.hypot(t.x, t.z) / farthest) * 0.9 }));
}
