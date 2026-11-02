import type { Connection, LogGroup, LogLine, LogsDetails, LogSpike, Resource } from "../../shared/types.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// An app's runtime errors, from its host's logs: one connection type per
// host ("vercel-logs"), connected through the same account and to the same
// project as the host's own connection. Each host only says how to read its
// error lines (server/integrations/logs/<host>.ts); grouping them, the spike
// rule and the words are here, the same for every host.

export const WINDOW_MIN = 60; // how far back each check reads
export const RECENT_MIN = 15; // the stretch a spike is judged on
export const SPIKE_MIN = 20; // errors in the recent stretch before it can be a spike
export const SPIKE_TIMES = 3; // …and this many times the usual rate
export const MAX_LINES = 1000; // read at most this many lines per check
const TOP_GROUPS = 20;
const CACHE_MS = 60_000;

export type LogReader = {
  provider: string; // "Vercel"
  // Error lines (error, fatal; warnings only if the host has nothing
  // stronger) written since `since` (ISO), at most `limit` of them, any
  // order. `partial` when there were more than were read.
  readErrors(conn: Connection, auth: ServiceAuth, since: string, limit: number): Promise<{ lines: LogLine[]; partial?: boolean }>;
  // Where to read the logs on the host's own dashboard.
  dashboardUrl?(conn: Connection): string | undefined;
  // The host's resources that have logs, when not all of them do
  // (Cloudflare: Workers, not Pages); and how such a resource is parsed.
  listResources?(auth: ServiceAuth): Promise<Resource[]>;
  parse?: Integration["parse"];
};

// What makes two lines the same error: the line without its numbers, ids,
// hashes and addresses.
export function fingerprint(message: string): string {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<id>")
    .replace(/\b0x[0-9a-f]+\b/gi, "<n>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<id>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

// Lines alike counted as one, most frequent first (the newest first among
// equals), each keeping its newest line as written.
export function groupLines(lines: LogLine[]): LogGroup[] {
  const groups = new Map<string, LogGroup>();
  for (const l of [...lines].sort((a, b) => a.at.localeCompare(b.at))) {
    const key = `${l.source ?? ""}\n${fingerprint(l.message)}`;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, { message: l.message.slice(0, 500), level: l.level, count: 1, firstAt: l.at, lastAt: l.at, ...(l.source ? { source: l.source } : {}) });
      continue;
    }
    g.count += 1;
    g.lastAt = l.at;
    g.message = l.message.slice(0, 500);
    if (l.level === "fatal" || (l.level === "error" && g.level === "warning")) g.level = l.level;
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt));
}

// A spike: many errors in the last 15 minutes, and several times as many as
// in a usual 15 minutes of the hour before. A steady trickle of the same
// errors isn't news; a deploy that starts throwing is.
export function errorSpike(lines: LogLine[], now = Date.now()): LogSpike | undefined {
  const recentFrom = now - RECENT_MIN * 60_000;
  const recent = lines.filter((l) => Date.parse(l.at) >= recentFrom).length;
  const before = lines.length - recent;
  const usual = Math.round(before / ((WINDOW_MIN - RECENT_MIN) / RECENT_MIN));
  if (recent < SPIKE_MIN || recent < SPIKE_TIMES * Math.max(usual, 1)) return undefined;
  return { recent, usual, windowMin: RECENT_MIN };
}

export function logsDetails(reader: LogReader, conn: Connection, read: { lines: LogLine[]; partial?: boolean }, now = Date.now()): LogsDetails {
  const from = now - WINDOW_MIN * 60_000;
  const lines = read.lines.filter((l) => Date.parse(l.at) >= from && Date.parse(l.at) <= now + 60_000);
  const spike = errorSpike(lines, now);
  const url = reader.dashboardUrl?.(conn);
  return {
    shape: "logs",
    provider: reader.provider,
    windowMin: WINDOW_MIN,
    total: lines.length,
    last15m: lines.filter((l) => Date.parse(l.at) >= now - RECENT_MIN * 60_000).length,
    groups: groupLines(lines).slice(0, TOP_GROUPS),
    ...(spike ? { spike } : {}),
    ...(read.partial ? { partial: true } : {}),
    ...(url ? { link: { url, label: `Logs in ${reader.provider}` } } : {}),
  };
}

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${one}${n === 1 ? "" : "s"}`;
const quote = (s: string) => (s.length > 120 ? `${s.slice(0, 117)}…` : s);

export function spikeReason(d: LogsDetails): string {
  const s = d.spike!;
  const top = d.groups[0];
  return `${plural(s.recent, "error")} in the last ${s.windowMin} minutes, against about ${s.usual.toLocaleString("en-US")} usually${top ? `. Most often: "${quote(top.message)}"` : ""}`;
}

// The host connection's way of finding the app's project, with only the
// reading of logs added.
export function logsIntegration(type: string, host: Integration, reader: LogReader): Integration {
  const cache = new Map<string, { until: number; value: Promise<LogsDetails> }>();
  // A check and the app page asking at once read the logs once.
  const read = (conn: Connection, auth: ServiceAuth, now = Date.now()): Promise<LogsDetails> => {
    const key = `${conn.id}\n${conn.resource}\n${JSON.stringify(conn.settings ?? {})}`;
    const hit = cache.get(key);
    if (hit && hit.until > now) return hit.value;
    const since = new Date(now - WINDOW_MIN * 60_000).toISOString();
    const value = reader.readErrors(conn, auth, since, MAX_LINES).then((r) => logsDetails(reader, conn, r, now));
    if (cache.size > 200) cache.clear();
    cache.set(key, { until: now + CACHE_MS, value });
    value.catch(() => cache.delete(key));
    return value;
  };

  return {
    ...described(type),
    // The spike rule already needs a quarter of an hour of errors.
    confirmFailures: 1,
    parse: reader.parse ?? host.parse,
    ...(host.resourceName ? { resourceName: host.resourceName } : {}),
    ...(host.matchApp ? { matchApp: host.matchApp } : {}),
    // Logs belong to the very project the app runs on: offered only when
    // that's plain, never as a "choose…" card (an account whose Workers only
    // serve static files has none to offer).
    suggestOnlyMatched: true,
    ...(host.suggestedSettings ? { suggestedSettings: host.suggestedSettings } : {}),
    listResources: (auth) => (reader.listResources ?? host.listResources!)(auth),

    async check(conn, auth) {
      const at = new Date().toISOString();
      if (!auth) return { state: "unknown", at, detail: `No ${reader.provider} account connected` };
      try {
        const d = await read(conn, auth);
        const summary =
          d.total === 0
            ? `No errors in the last ${WINDOW_MIN} minutes`
            : `${plural(d.total, "error")}${d.partial ? " or more" : ""} in the last ${WINDOW_MIN} minutes · ${d.last15m.toLocaleString("en-US")} in the last ${RECENT_MIN}`;
        return d.spike
          ? { state: "down", at, detail: spikeReason(d), summary, ...(d.link ? { link: d.link } : {}) }
          : { state: "up", at, summary };
      } catch (err) {
        return { state: "unknown", at, detail: (err as Error).message };
      }
    },

    details: (conn, auth) => read(conn, auth),

    notice(event, app, reason) {
      return event === "down"
        ? { title: `${app}: errors are spiking`, body: reason }
        : { title: `${app}: errors are back to normal`, body: `Its ${reader.provider} logs are quiet again.` };
    },
  };
}
