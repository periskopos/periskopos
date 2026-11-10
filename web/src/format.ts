import { clockPref, hourStyle } from "./prefs.ts";
import { duration } from "../../shared/format.ts";
import type { AppState } from "../../shared/types.ts";

// What a time we can't read shows as. Some times come from outside (an app
// reports its own clock), and Intl.DateTimeFormat.format throws a RangeError on
// an invalid date, which would stop the whole page from drawing.
export const NO_TIME = "—";
const valid = (d: Date) => !Number.isNaN(d.getTime());

export function ago(iso: string, now = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return NO_TIME;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

// 100 → "100%", 99.95 → "99.95%", 87.333 → "87.33%"
export const formatPct = (pct: number) => `${Number(pct.toFixed(2))}%`;

// A 30-day figure resting on much less than that says so: "100% of 3 h".
const THIN_UPTIME_MS = 7 * 24 * 60 * 60_000;
export const thinUptime = (watchedMs?: number) => watchedMs !== undefined && watchedMs < THIN_UPTIME_MS;
export const formatUptime = (pct: number, watchedMs?: number) => (thinUptime(watchedMs) ? `${formatPct(pct)} of ${duration(watchedMs ?? 0)}` : formatPct(pct));

// Made when first needed, and again if the clock's choice in Settings changes.
let formats: { key: string; time: Intl.DateTimeFormat; dayTime: Intl.DateTimeFormat; exact: Intl.DateTimeFormat } | undefined;
function fmt() {
  const key = clockPref();
  if (formats?.key === key) return formats;
  const hours = hourStyle();
  formats = {
    key,
    time: new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", ...hours }),
    dayTime: new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...hours }),
    exact: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium", ...hours }),
  };
  return formats;
}
const safe = (fmt: Intl.DateTimeFormat, d: Date) => (valid(d) ? fmt.format(d) : NO_TIME);
export const exactTime = (iso: string) => safe(fmt().exact, new Date(iso));
export const clock = (iso: string) => safe(fmt().time, new Date(iso));
export const dayTime = (iso: string) => safe(fmt().dayTime, new Date(iso));

// "Mon 6 Oct, 23:10 – 07:45", or with the day again if it differs.
export function range(fromIso: string, toIso?: string): string {
  const from = new Date(fromIso);
  if (!toIso) return `${safe(fmt().dayTime, from)} – now`;
  const to = new Date(toIso);
  const sameDay = valid(from) && valid(to) && from.toDateString() === to.toDateString();
  return `${safe(fmt().dayTime, from)} – ${sameDay ? safe(fmt().time, to) : safe(fmt().dayTime, to)}`;
}

export function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}

export type ShownState = AppState | "checking";

export const STATE_LABEL: Record<ShownState, string> = {
  up: "Up",
  down: "Down",
  attention: "Needs attention",
  unknown: "Unknown",
  stale: "No recent data",
  none: "No checks",
  prelaunch: "Not live yet",
  checking: "Checking…",
};

// What needs me first (§8.2).
export const STATE_RANK: Record<ShownState, number> = {
  down: 0,
  attention: 1,
  unknown: 2,
  stale: 3,
  checking: 4,
  up: 5,
  prelaunch: 6,
  none: 7,
};

export const shortSha = (sha: string) => sha.slice(0, 7);
