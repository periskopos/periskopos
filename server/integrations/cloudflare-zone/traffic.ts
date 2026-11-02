import type { Connection, TrafficPoint, TrafficTotals, ZoneTraffic } from "../../../shared/types.ts";
import type { ServiceAuth } from "../types.ts";
import { gql, zoneIdOf } from "./api.ts";

// The zone's traffic from its analytics: requests, cache, bytes, visitors
// and 5xx errors by hour and by day, and the error spike the check alerts on.

const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// An error spike: in the current and the previous clock hour, at least this
// share of requests answered 5xx, out of at least this many requests (a
// handful of requests failing is noise, not an outage).
export const SPIKE_RATE = 0.05;
export const SPIKE_MIN_REQUESTS = 50;

// Analytics move slowly and GraphQL is the most expensive call here, so the
// app page's 60-second refresh reuses answers for a while.
const HOURS_TTL_MS = 2 * 60_000;
export const DAYS_TTL_MS = 10 * 60_000;

type StatusCount = { edgeResponseStatus: number; requests: number };
type CfGroup = {
  dimensions: { date?: string; datetime?: string };
  sum: {
    requests: number;
    cachedRequests: number;
    bytes: number;
    responseStatusMap?: StatusCount[];
  };
  uniq?: { uniques?: number };
};

// "1.2k", "34k", "1.5M": counts in reasons and summaries.
export function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

const pct = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : undefined);
const round1 = (n: number) => Math.round(n * 10) / 10;

const GROUP_FIELDS = "sum { requests cachedRequests bytes responseStatusMap { edgeResponseStatus requests } } uniq { uniques }";

const errors5xxOf = (map: StatusCount[] | undefined) =>
  (map ?? []).filter((s) => s.edgeResponseStatus >= 500 && s.edgeResponseStatus <= 599).reduce((n, s) => n + s.requests, 0);

export function toPoint(g: CfGroup, at: string): TrafficPoint {
  return {
    at,
    requests: g.sum.requests,
    cachedRequests: g.sum.cachedRequests,
    bytes: g.sum.bytes,
    visitors: g.uniq?.uniques ?? 0,
    errors5xx: errors5xxOf(g.sum.responseStatusMap),
  };
}

const emptyPoint = (at: string): TrafficPoint => ({
  at,
  requests: 0,
  cachedRequests: 0,
  bytes: 0,
  visitors: 0,
  errors5xx: 0,
});

export function totalsOf(points: TrafficPoint[]): TrafficTotals {
  const sum = (k: keyof Omit<TrafficPoint, "at">) => points.reduce((n, p) => n + p[k], 0);
  const requests = sum("requests");
  const errors5xx = sum("errors5xx");
  const cached = pct(sum("cachedRequests"), requests);
  const errors = pct(errors5xx, requests);
  return {
    requests,
    bytes: sum("bytes"),
    visitors: sum("visitors"),
    errors5xx,
    ...(cached !== undefined ? { cachedPct: round1(cached) } : {}),
    ...(errors !== undefined ? { errorPct: round1(errors) } : {}),
  };
}

const startOfHour = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;
export const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// The last 24 clock hours, the current one included; Cloudflare leaves out
// hours with no traffic, so those are filled in as zero (an honest chart).
export async function hourly(conn: Connection, auth: ServiceAuth, now = Date.now()): Promise<TrafficPoint[]> {
  const first = startOfHour(now) - 23 * HOUR_MS;
  const data = await gql<{ viewer: { zones: { hours: CfGroup[] }[] } }>(
    auth,
    `query($zone: String!, $since: Time!) { viewer { zones(filter: { zoneTag: $zone }) {
      hours: httpRequests1hGroups(limit: 48, filter: { datetime_geq: $since }, orderBy: [datetime_ASC]) { dimensions { datetime } ${GROUP_FIELDS} }
    } } }`,
    { zone: zoneIdOf(conn), since: new Date(first).toISOString() },
    HOURS_TTL_MS,
  );
  const byHour = new Map((data.viewer.zones[0]?.hours ?? []).map((g) => [Date.parse(g.dimensions.datetime ?? ""), g]));
  return Array.from({ length: 24 }, (_, i) => {
    const at = first + i * HOUR_MS;
    const g = byHour.get(at);
    const iso = new Date(at).toISOString();
    return g ? toPoint(g, iso) : emptyPoint(iso);
  });
}

// The last 30 days (UTC, as Cloudflare counts them), today included.
export async function daily(conn: Connection, auth: ServiceAuth, now = Date.now()): Promise<TrafficPoint[]> {
  const dates = Array.from({ length: 30 }, (_, i) => utcDate(now - (29 - i) * DAY_MS));
  const data = await gql<{ viewer: { zones: { days: CfGroup[] }[] } }>(
    auth,
    `query($zone: String!, $from: Date!, $to: Date!) { viewer { zones(filter: { zoneTag: $zone }) {
      days: httpRequests1dGroups(limit: 31, filter: { date_geq: $from, date_leq: $to }, orderBy: [date_ASC]) { dimensions { date } ${GROUP_FIELDS} }
    } } }`,
    { zone: zoneIdOf(conn), from: dates[0], to: dates[29] },
    DAYS_TTL_MS,
  );
  const byDate = new Map((data.viewer.zones[0]?.days ?? []).map((g) => [g.dimensions.date, g]));
  return dates.map((d) => {
    const g = byDate.get(d);
    return g ? toPoint(g, d) : emptyPoint(d);
  });
}

export function shapeTraffic(hours: TrafficPoint[], days: TrafficPoint[]): ZoneTraffic {
  return {
    hours,
    days,
    totals: {
      day: totalsOf(hours),
      week: totalsOf(days.slice(-7)),
      month: totalsOf(days),
    },
  };
}

const clockTime = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

// The current clock hour (so far) and the one before it: recent enough to
// alert on, long enough to have a meaningful number of requests.
export function errorSpike(hours: TrafficPoint[], now = Date.now()): { reason: string; rate: number } | undefined {
  const since = startOfHour(now) - HOUR_MS;
  const recent = hours.filter((p) => Date.parse(p.at) >= since);
  const requests = recent.reduce((n, p) => n + p.requests, 0);
  const failed = recent.reduce((n, p) => n + p.errors5xx, 0);
  if (requests < SPIKE_MIN_REQUESTS || failed / requests < SPIKE_RATE) return undefined;
  const rate = failed / requests;
  return {
    rate,
    reason: `${Math.round(rate * 100)}% of requests failed (5xx) since ${clockTime(since)}: ${compact(failed)} of ${compact(requests)}`,
  };
}
