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

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const dayTimeFmt = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const exactFmt = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" });
const safe = (fmt: Intl.DateTimeFormat, d: Date) => (valid(d) ? fmt.format(d) : NO_TIME);
export const exactTime = (iso: string) => safe(exactFmt, new Date(iso));
export const clock = (iso: string) => safe(timeFmt, new Date(iso));

// "Mon 6 Oct, 23:10 – 07:45", or with the day again if it differs.
export function range(fromIso: string, toIso?: string): string {
  const from = new Date(fromIso);
  if (!toIso) return `${safe(dayTimeFmt, from)} – now`;
  const to = new Date(toIso);
  const sameDay = valid(from) && valid(to) && from.toDateString() === to.toDateString();
  return `${safe(dayTimeFmt, from)} – ${sameDay ? safe(timeFmt, to) : safe(dayTimeFmt, to)}`;
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
  none: "No checks",
  prelaunch: "Not live yet",
  checking: "Checking…",
};

// What needs me first (§8.2).
export const STATE_RANK: Record<ShownState, number> = {
  down: 0,
  attention: 1,
  unknown: 2,
  checking: 3,
  up: 4,
  prelaunch: 5,
  none: 6,
};

export const shortSha = (sha: string) => sha.slice(0, 7);
