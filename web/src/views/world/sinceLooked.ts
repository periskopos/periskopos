import { duration } from "../../../../shared/format.ts";
import type { NotificationsView } from "../../../../shared/types.ts";
import type { Plot } from "../../../../shared/world.ts";
import { ago } from "../../format.ts";

// What happened while you were away, said once as the World opens. Only what's on the record:
// problems that started or ended since, and apps added since. Deploys aren't kept, so they
// aren't counted, and a quiet stretch isn't called quiet: nothing recorded isn't the same as
// nothing happening, with the PC off.

const LOOKED_KEY = "periskopos-world-looked";
// Back within a few minutes: nothing to catch up on.
export const AWAY_MS = 10 * 60_000;
// How far back the record of what recovered goes (RECOVERED_WINDOW_MS on the server).
export const RECORD_MS = 24 * 60 * 60_000;
const MOST = 3;

export type SinceRow = { slug: string | null; name: string; text: string; state: "down" | "attention" | "up" | "new" };
export type SinceSaid = { title: string; rows: SinceRow[]; more: number };

const slugOf = (href: string) => {
  const m = /^#\/apps\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]!) : null;
};

export function sinceYouLooked({ looked, now, notifications, plots }: { looked: Looked | null; now: number; notifications: NotificationsView | undefined; plots: Pick<Plot, "slug" | "name">[] }): SinceSaid | null {
  if (looked === null || !notifications || !(now - looked.at >= AWAY_MS)) return null;
  const title = `Since you last looked, ${ago(new Date(looked.at).toISOString(), now)}`;
  // What recovered is kept for a day: away longer, it says only that day's, and says so.
  // A problem still open is known however long ago it started.
  const longAway = looked.at < now - RECORD_MS;
  const from = Math.max(looked.at, now - RECORD_MS);
  const nameOf = new Map(plots.map((p) => [p.slug, p.name]));
  const rows: SinceRow[] = [];

  // Still wrong, and started while you were away: the worst first, as the bell has them.
  const stillWrong = new Set<string>();
  const newRow = new Map<string, SinceRow>();
  for (const item of notifications.now) {
    if (item.watching || !item.since) continue;
    const slug = slugOf(item.href);
    if (slug) stillWrong.add(slug);
    if (Date.parse(item.since) < looked.at) continue;
    const row: SinceRow = { slug, name: item.title, text: `${item.state === "down" ? "went down" : "started needing attention"} ${ago(item.since, now)}: ${item.text}`, state: item.state };
    rows.push(row);
    if (slug && !newRow.has(slug)) newRow.set(slug, row);
  }

  // Put right since: one row an app, with how long it took all told.
  const ended = new Map<string, { slug: string | null; name: string; count: number; ms: number }>();
  for (const item of notifications.earlier) {
    if (Date.parse(item.endedAt) < from) continue;
    const slug = slugOf(item.href);
    const key = slug ?? item.title;
    const had = ended.get(key) ?? { slug, name: item.title, count: 0, ms: 0 };
    had.count += 1;
    had.ms += Math.max(0, Date.parse(item.endedAt) - Date.parse(item.startedAt));
    ended.set(key, had);
  }
  for (const e of ended.values()) {
    const had = (e.count === 1 ? `had a problem for ${duration(e.ms)}` : `had ${e.count} problems, ${duration(e.ms)} in all`) + (longAway ? " in the last day" : "");
    // Its new problem already has a row: what came before goes on it, so it's one app, one row.
    const already = e.slug ? newRow.get(e.slug) : undefined;
    if (already) {
      already.text += ` · before that it ${had}, and recovered`;
      continue;
    }
    const still = e.slug && stillWrong.has(e.slug);
    rows.push({ slug: e.slug, name: e.name, text: still ? `${had}, and has one now` : `${had}, and recovered`, state: still ? "attention" : "up" });
  }

  // Added since the last look.
  const before = new Set(looked.apps);
  for (const p of plots) if (!before.has(p.slug)) rows.push({ slug: p.slug, name: nameOf.get(p.slug) ?? p.name, text: "was added", state: "new" });

  if (rows.length === 0) return null;
  return { title, rows: rows.slice(0, MOST), more: Math.max(0, rows.length - MOST) };
}

// When this viewer last had the World open, and which apps were on it.
export type Looked = { at: number; apps: string[] };

export function parseLooked(value: unknown): Looked | null {
  if (!value || typeof value !== "object") return null;
  const { at, apps } = value as Partial<Looked>;
  return typeof at === "number" && at > 0 && Array.isArray(apps) && apps.every((a) => typeof a === "string") ? { at, apps } : null;
}

export function savedLooked(): Looked | null {
  try {
    return parseLooked(JSON.parse(localStorage.getItem(LOOKED_KEY) ?? "null"));
  } catch {
    return null;
  }
}

export function saveLooked(looked: Looked) {
  try {
    localStorage.setItem(LOOKED_KEY, JSON.stringify(looked));
  } catch {
    // not remembered: next time it can't say what happened since, and says nothing
  }
}
