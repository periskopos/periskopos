import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppHistory, CheckResult, CheckState, DayStat, DetailsLink, Gap, Incident, IncidentKind } from "../shared/types.ts";
import { clip, complement, intersect, total } from "./intervals.ts";
import type { Interval } from "./intervals.ts";

// What the watcher records (FR-W2, FR-W3, FR-W6) and what's read back from
// it: checks, incidents, the periods the watcher was running, and uptime.

export const CHECKS_KEPT_DAYS = 30;
export const SUMMARIES_KEPT_DAYS = 365;
// A stretch longer than this without a heartbeat is a gap: not watched.
export const GAP_MS = 2 * 60_000;

const DAY_MS = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

// ── Watch periods ───────────────────────────────────────────────────────

export function startPeriod(db: DatabaseSync, at: number): number {
  const r = db
    .prepare("INSERT INTO watch_periods (started_at, last_seen_at) VALUES (?, ?)")
    .run(iso(at), iso(at));
  return Number(r.lastInsertRowid);
}

export function heartbeat(db: DatabaseSync, periodId: number, at: number) {
  db.prepare("UPDATE watch_periods SET last_seen_at = ? WHERE id = ?").run(iso(at), periodId);
}

function watchedIntervals(db: DatabaseSync, from: number, to: number, now: number): Interval[] {
  const rows = db
    .prepare(
      "SELECT started_at, last_seen_at FROM watch_periods WHERE last_seen_at >= ? AND started_at < ? ORDER BY started_at",
    )
    .all(iso(from), iso(to)) as { started_at: string; last_seen_at: string }[];
  return clip(
    rows.map(({ started_at, last_seen_at }): Interval => {
      const end = Date.parse(last_seen_at);
      // The running period is watched up to now, not just to its last beat.
      return [Date.parse(started_at), now - end <= GAP_MS ? Math.max(end, now) : end];
    }),
    from,
    to,
  );
}

// ── Checks ──────────────────────────────────────────────────────────────

type CheckRow = {
  connection_id: string;
  at: string;
  state: CheckState;
  ms: number | null;
  http_status: number | null;
  detail: string | null;
  summary: string | null;
  link: string | null;
};

const toResult = (r: CheckRow): CheckResult => ({
  state: r.state,
  at: r.at,
  ...(r.ms !== null ? { ms: r.ms } : {}),
  ...(r.http_status !== null ? { httpStatus: r.http_status } : {}),
  ...(r.detail ? { detail: r.detail } : {}),
  ...(r.summary ? { summary: r.summary } : {}),
  ...(r.link ? { link: JSON.parse(r.link) as DetailsLink } : {}),
});

export function recordCheck(db: DatabaseSync, appId: string, connectionId: string, r: CheckResult) {
  db.prepare(
    `INSERT INTO checks (app_id, connection_id, at, state, ms, http_status, detail, summary, link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(appId, connectionId, r.at, r.state, r.ms ?? null, r.httpStatus ?? null, r.detail ?? null, r.summary ?? null, r.link ? JSON.stringify(r.link) : null);
}

export function latestCheck(db: DatabaseSync, connectionId: string): CheckResult | undefined {
  const row = db
    .prepare("SELECT * FROM checks WHERE connection_id = ? ORDER BY id DESC LIMIT 1")
    .get(connectionId) as CheckRow | undefined;
  return row && toResult(row);
}

// The last `n` checks that said up or down; "unknown" ones (PC offline,
// a failing integration) neither confirm nor clear a problem.
export function lastDecisiveChecks(db: DatabaseSync, connectionId: string, n = 2): CheckResult[] {
  const rows = db
    .prepare(
      "SELECT * FROM checks WHERE connection_id = ? AND state != 'unknown' ORDER BY id DESC LIMIT ?",
    )
    .all(connectionId, n) as CheckRow[];
  return rows.map(toResult);
}

export function latestChecks(db: DatabaseSync, appIds: string[]): Map<string, CheckResult> {
  if (appIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT c.* FROM checks c
       JOIN (SELECT connection_id, MAX(id) AS id FROM checks
             WHERE app_id IN (${appIds.map(() => "?").join(",")})
             GROUP BY connection_id) latest ON latest.id = c.id`,
    )
    .all(...appIds) as CheckRow[];
  return new Map(rows.map((r) => [r.connection_id, toResult(r)]));
}

// Connections whose latest check couldn't say, and since when none has: from
// the first "unknown" after the last check that said up or down.
export function unknownSince(db: DatabaseSync, appIds: string[]): { connectionId: string; since: string; detail?: string; httpStatus?: number }[] {
  const first = db.prepare(
    `SELECT MIN(at) AS since FROM checks
     WHERE connection_id = ? AND id > COALESCE((SELECT MAX(id) FROM checks WHERE connection_id = ? AND state != 'unknown'), 0)`,
  );
  return [...latestChecks(db, appIds)].flatMap(([connectionId, latest]) => {
    if (latest.state !== "unknown") return [];
    const { since } = first.get(connectionId, connectionId) as { since: string };
    return [{ connectionId, since, ...(latest.detail ? { detail: latest.detail } : {}), ...(latest.httpStatus !== undefined ? { httpStatus: latest.httpStatus } : {}) }];
  });
}

// ── Incidents ───────────────────────────────────────────────────────────

type IncidentRow = {
  id: string;
  app_id: string;
  connection_id: string | null;
  kind: IncidentKind;
  started_at: string;
  ended_at: string | null;
  reason: string;
  false_alarm: number;
};

const toIncident = (r: IncidentRow): Incident => ({
  id: r.id,
  appId: r.app_id,
  ...(r.connection_id ? { connectionId: r.connection_id } : {}),
  kind: r.kind,
  startedAt: r.started_at,
  ...(r.ended_at ? { endedAt: r.ended_at } : {}),
  reason: r.reason,
  ...(r.false_alarm ? { falseAlarm: true as const } : {}),
});

// Marking an incident a false alarm, or taking the mark back. Undefined if
// the app has no such incident.
export function setFalseAlarm(db: DatabaseSync, appId: string, id: string, on: boolean): Incident | undefined {
  db.prepare("UPDATE incidents SET false_alarm = ? WHERE id = ? AND app_id = ?").run(on ? 1 : 0, id, appId);
  const row = db.prepare("SELECT * FROM incidents WHERE id = ? AND app_id = ?").get(id, appId) as IncidentRow | undefined;
  return row && toIncident(row);
}

export function openIncidentFor(db: DatabaseSync, connectionId: string): Incident | undefined {
  const row = db
    .prepare("SELECT * FROM incidents WHERE connection_id = ? AND ended_at IS NULL LIMIT 1")
    .get(connectionId) as IncidentRow | undefined;
  return row && toIncident(row);
}

export function openIncident(
  db: DatabaseSync,
  input: { appId: string; connectionId: string; kind: IncidentKind; startedAt: string; reason: string },
): Incident {
  const incident: Incident = { id: `i_${randomBytes(8).toString("base64url")}`, ...input };
  db.prepare(
    "INSERT INTO incidents (id, app_id, connection_id, kind, started_at, reason) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(incident.id, input.appId, input.connectionId, input.kind, input.startedAt, input.reason);
  return incident;
}

export function closeIncident(db: DatabaseSync, id: string, endedAt: string) {
  db.prepare("UPDATE incidents SET ended_at = ? WHERE id = ?").run(endedAt, id);
}

// Ends whatever is still open for a connection, however many there are.
export function closeOpenIncidents(db: DatabaseSync, connectionId: string, endedAt: string) {
  db.prepare("UPDATE incidents SET ended_at = ? WHERE connection_id = ? AND ended_at IS NULL").run(endedAt, connectionId);
}

// The open incident that matters most for each app: an outage before a
// deploy or CI problem, then the oldest.
export function openIncidents(db: DatabaseSync, appIds: string[]): Map<string, Incident> {
  if (appIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM incidents WHERE ended_at IS NULL
       AND app_id IN (${appIds.map(() => "?").join(",")})
       ORDER BY kind = 'outage' DESC, started_at ASC`,
    )
    .all(...appIds) as IncidentRow[];
  const out = new Map<string, Incident>();
  for (const r of rows) if (!out.has(r.app_id)) out.set(r.app_id, toIncident(r));
  return out;
}

// Incidents that ended since `since`, newest first: what recovered lately.
export function endedSince(db: DatabaseSync, appIds: string[], since: number, limit = 20): Incident[] {
  if (appIds.length === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM incidents WHERE ended_at IS NOT NULL AND ended_at >= ?
       AND app_id IN (${appIds.map(() => "?").join(",")})
       ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(iso(since), ...appIds, limit) as IncidentRow[];
  return rows.map(toIncident);
}

function incidentsBetween(db: DatabaseSync, appId: string, from: number, to: number): Incident[] {
  const rows = db
    .prepare(
      `SELECT * FROM incidents WHERE app_id = ? AND started_at < ?
       AND (ended_at IS NULL OR ended_at >= ?) ORDER BY started_at DESC`,
    )
    .all(appId, iso(to), iso(from)) as IncidentRow[];
  return rows.map(toIncident);
}

const incidentIntervals = (list: Incident[], now: number): Interval[] =>
  list.map((i) => [Date.parse(i.startedAt), i.endedAt ? Date.parse(i.endedAt) : now]);

// ── Uptime ──────────────────────────────────────────────────────────────

// Uptime counts only watched time (FR-W6): a night with the PC off is
// neither up nor down.
// Only outages count: a failed deploy or red CI leaves the app serving.
// Nor does one I marked a false alarm: the app was up all along.
const realOutage = (i: Incident) => i.kind === "outage" && !i.falseAlarm;

function measure(watched: Interval[], incidents: Incident[], from: number, to: number, now: number) {
  const w = clip(watched, from, to);
  const watchedMs = total(w);
  const outages = incidents.filter(realOutage);
  const downMs = total(intersect(w, incidentIntervals(outages, now)));
  return {
    watchedMs,
    uptimePct: watchedMs > 0 ? round2(((watchedMs - downMs) / watchedMs) * 100) : undefined,
  };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// The watched time that can say anything about this app: from when it was
// added and its site first checked (an app that's only just gone live has no
// month of uptime behind it), and not while its site's checks couldn't tell
// (a firewall refusing them is neither up nor down).
function watchedForApp(db: DatabaseSync, appId: string, watched: Interval[], from: number, to: number, now: number): Interval[] {
  const { created_at: created, first } = db
    .prepare(
      `SELECT a.created_at, (SELECT MIN(c.at) FROM checks c JOIN connections k ON k.id = c.connection_id WHERE c.app_id = a.id AND k.type = 'site') AS first
       FROM apps a WHERE a.id = ?`,
    )
    .get(appId) as { created_at: string; first: string | null };
  const start = Math.max(from, Date.parse(created), first ? Date.parse(first) : from);
  const unknown = db
    .prepare(
      `SELECT c.at, (SELECT MIN(n.at) FROM checks n WHERE n.connection_id = c.connection_id AND n.at > c.at AND n.state != 'unknown') AS until
       FROM checks c JOIN connections k ON k.id = c.connection_id
       WHERE c.app_id = ? AND k.type = 'site' AND c.state = 'unknown' AND c.at < ?`,
    )
    .all(appId, iso(to)) as { at: string; until: string | null }[];
  const couldTell = complement(unknown.map(({ at, until }): Interval => [Date.parse(at), until ? Date.parse(until) : now]), start, to);
  return intersect(clip(watched, start, to), couldTell);
}

export function uptime(db: DatabaseSync, appId: string, from: number, to: number, now = Date.now()) {
  return measure(watchedForApp(db, appId, watchedIntervals(db, from, to, now), from, to, now), incidentsBetween(db, appId, from, to), from, to, now);
}

// How much of a stretch the watcher was running for.
export const watchedMsBetween = (db: DatabaseSync, from: number, to: number, now = Date.now()) => total(watchedIntervals(db, from, to, now));

export function localDayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
// The start of the local day `n` calendar days before the one `ms` falls
// in. Stepping back n × 24 h instead goes wrong across a clock change: a
// 23-hour day makes it land in the evening one day too early.
export function localDaysBefore(ms: number, n: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
}
const nextLocalDay = (ms: number) => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
};
export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayStat(db: DatabaseSync, appId: string, start: number, now: number, watched: Interval[], incidents: Incident[]): DayStat {
  const end = Math.min(nextLocalDay(start), now);
  const { watchedMs, uptimePct } = measure(watched, incidents, start, end, now);
  const ms = db
    .prepare(
      "SELECT AVG(ms) AS avg, MAX(ms) AS max FROM checks WHERE app_id = ? AND at >= ? AND at < ? AND ms IS NOT NULL",
    )
    .get(appId, iso(start), iso(end)) as { avg: number | null; max: number | null };
  return {
    day: dayKey(start),
    ...(uptimePct !== undefined ? { uptimePct } : {}),
    watchedMin: Math.round(watchedMs / 60_000),
    incidents: incidents.filter((i) => {
      if (!realOutage(i)) return false;
      const t = Date.parse(i.startedAt);
      return t >= start && t < end;
    }).length,
    ...(ms.avg !== null ? { avgMs: Math.round(ms.avg) } : {}),
    ...(ms.max !== null ? { maxMs: ms.max } : {}),
  };
}

// The app page's history: the last `days` days, in detail.
export function appHistory(db: DatabaseSync, appId: string, now = Date.now(), days = 30): AppHistory {
  const firstDay = localDaysBefore(now, days - 1);
  const watcherRan = watchedIntervals(db, firstDay, now, now);
  const watched = watchedForApp(db, appId, watcherRan, firstDay, now, now);
  const incidents = incidentsBetween(db, appId, firstDay, now);
  const { watchedMs, uptimePct } = measure(watched, incidents, firstDay, now, now);

  const dayStats: DayStat[] = [];
  for (let d = firstDay; d < now; d = nextLocalDay(d)) {
    dayStats.push(dayStat(db, appId, d, now, watched, incidents));
  }

  // Before the app was added there was nothing to watch: not a gap.
  const created = db.prepare("SELECT created_at FROM apps WHERE id = ?").get(appId) as
    | { created_at: string }
    | undefined;
  const gapsFrom = Math.max(firstDay, created ? Date.parse(created.created_at) : firstDay);
  const gaps: Gap[] = complement(watcherRan, gapsFrom, now)
    .filter(([a, b]) => b - a >= GAP_MS)
    .reverse()
    .map(([a, b]) => ({ from: iso(a), to: iso(b) }));

  return {
    from: iso(firstDay),
    to: iso(now),
    ...(uptimePct !== undefined ? { uptimePct } : {}),
    watchedMin: Math.round(watchedMs / 60_000),
    incidents,
    gaps,
    days: dayStats,
  };
}

// ── Keeping it small (FR-W2) ────────────────────────────────────────────

// Rolls every finished day not yet summarized into daily_summaries, for
// days still covered by raw checks. Safe to run any time.
export function rollUp(db: DatabaseSync, now = Date.now()) {
  const today = localDayStart(now);
  const oldest = localDaysBefore(now, CHECKS_KEPT_DAYS - 1);
  const apps = db.prepare("SELECT id, created_at FROM apps").all() as { id: string; created_at: string }[];
  const exists = db.prepare("SELECT 1 FROM daily_summaries WHERE app_id = ? AND day = ?");
  const insert = db.prepare(
    `INSERT INTO daily_summaries (app_id, day, uptime_pct, watched_min, incidents, avg_ms, max_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const app of apps) {
    const start = Math.max(oldest, localDayStart(Date.parse(app.created_at)));
    if (start >= today) continue;
    const watched = watchedIntervals(db, start, today, now);
    const incidents = incidentsBetween(db, app.id, start, today);
    for (let d = start; d < today; d = nextLocalDay(d)) {
      if (exists.get(app.id, dayKey(d))) continue;
      const s = dayStat(db, app.id, d, now, watched, incidents);
      insert.run(app.id, s.day, s.uptimePct ?? null, s.watchedMin, s.incidents, s.avgMs ?? null, s.maxMs ?? null);
    }
  }
}

export function prune(db: DatabaseSync, now = Date.now()) {
  db.prepare("DELETE FROM checks WHERE at < ?").run(iso(localDaysBefore(now, CHECKS_KEPT_DAYS)));
  const yearAgo = now - SUMMARIES_KEPT_DAYS * DAY_MS;
  db.prepare("DELETE FROM daily_summaries WHERE day < ?").run(dayKey(yearAgo));
  db.prepare("DELETE FROM watch_periods WHERE last_seen_at < ?").run(iso(yearAgo));
}
