import type { LogLine } from "../../../shared/types.ts";
import { getJson, ProviderError } from "../../http.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import { supabase } from "../supabase.ts";

// A Supabase project's errors, through the Management API's logs endpoint
// (GET /v1/projects/{ref}/analytics/endpoints/logs; logs.all, its BigQuery
// predecessor, was removed on 23 September 2026). It runs ClickHouse SQL over
// one `logs` table whose `source` column names the log, with each source's
// fields in the `log_attributes` map (values are strings; a missing key is '').
// One query reads, for the window:
//   postgres_logs       parsed.error_severity ERROR, FATAL or PANIC
//   function_logs       an Edge Function's console at level error
//   auth_logs           Auth at level error or fatal
//   edge_logs           API requests answered 5xx
//   function_edge_logs  Edge Function invocations answered 5xx
// The window can be 24 hours at most, and a query returns 1,000 rows at most.
// Failures come back as HTTP 200 with `error` set, not as an HTTP error.

const API = "https://api.supabase.com/v1";
const MAX_ROWS = 1000;
const MAX_WINDOW_MS = 24 * 60 * 60_000;
const LOGS_TTL_MS = 30_000;

export const SQL = (rows: number) =>
  `select timestamp, source, event_message,
  log_attributes['parsed.error_severity'] as pg_severity,
  log_attributes['level'] as level,
  log_attributes['response.status_code'] as status_code,
  log_attributes['request.method'] as method,
  log_attributes['request.path'] as path,
  log_attributes['request.pathname'] as pathname,
  log_attributes['function_id'] as function_id
from logs
where (source = 'postgres_logs' and log_attributes['parsed.error_severity'] in ('ERROR', 'FATAL', 'PANIC'))
  or (source in ('function_logs', 'auth_logs') and lower(log_attributes['level']) in ('error', 'fatal', 'panic'))
  or (source in ('edge_logs', 'function_edge_logs') and toInt32OrZero(log_attributes['response.status_code']) between 500 and 599)
order by timestamp desc
limit ${rows}`;

export type SbRow = {
  timestamp?: string | number;
  source?: string;
  event_message?: string;
  pg_severity?: string;
  level?: string;
  status_code?: string;
  method?: string;
  path?: string;
  pathname?: string;
  function_id?: string;
};

// "2026-08-22T00:13:07.000000" (UTC, no offset), "2026-08-22 00:13:07", or
// microseconds since 1970 as logs.all gave them.
export function parseTime(t: unknown): string | undefined {
  if (typeof t === "number" && Number.isFinite(t)) {
    const ms = t > 1e14 ? t / 1000 : t > 1e11 ? t : t * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof t !== "string" || !t.trim()) return undefined;
  let s = t.trim().replace(" ", "T").replace(/(\.\d{3})\d+/, "$1");
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const SOURCES: Record<string, string> = {
  postgres_logs: "postgres",
  function_logs: "functions",
  function_edge_logs: "functions",
  auth_logs: "auth",
  edge_logs: "api",
};

export function toLogLine(r: SbRow): LogLine | undefined {
  const at = parseTime(r.timestamp);
  const source = SOURCES[r.source ?? ""];
  if (!at || !source) return undefined;
  const severity = (r.source === "postgres_logs" ? r.pg_severity : r.level)?.toLowerCase() ?? "";
  const level: LogLine["level"] = severity === "fatal" || severity === "panic" ? "fatal" : "error";
  let message = (r.event_message ?? "").trim();
  if (r.source === "edge_logs" || r.source === "function_edge_logs") {
    const path = r.path || r.pathname;
    if (path) message = `${r.status_code ?? "5xx"} ${r.method ? `${r.method} ` : ""}${path}`;
  }
  if (!message) return undefined;
  return { at, level, message, source };
}

export const reader: LogReader = {
  provider: "Supabase",

  async readErrors(conn, auth, since, limit) {
    const now = Date.now();
    const start = Math.max(Date.parse(since), now - MAX_WINDOW_MS + 60_000);
    const rows = Math.min(limit + 1, MAX_ROWS);
    const q = new URLSearchParams({ sql: SQL(rows), iso_timestamp_start: new Date(start).toISOString(), iso_timestamp_end: new Date(now).toISOString() });
    let body: { result?: SbRow[] | null; error?: unknown };
    try {
      body = await getJson(`${API}/projects/${encodeURIComponent(conn.resource)}/analytics/endpoints/logs?${q}`, {
        token: await auth.token(),
        provider: "Supabase",
        ttlMs: LOGS_TTL_MS,
      });
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
        throw new ProviderError(
          err.status,
          `Supabase refused to read this project's logs (${err.status}): use an access token of a member who can see the project; a token with limited permissions needs Analytics logs: read (analytics_logs_read)`,
          err.body,
        );
      }
      throw err;
    }
    if (body.error) {
      const e = typeof body.error === "string" ? body.error : JSON.stringify(body.error);
      throw new ProviderError(200, `Supabase couldn't read the logs: ${e.slice(0, 300)}`);
    }
    const all = body.result ?? [];
    const lines = all.map(toLogLine).filter((l): l is LogLine => !!l && l.at >= since);
    const partial = lines.length > limit || all.length >= rows;
    return { lines: lines.slice(0, limit), ...(partial ? { partial: true } : {}) };
  },

  dashboardUrl: (conn) => `https://supabase.com/dashboard/project/${encodeURIComponent(conn.resource)}/logs/explorer`,
};

export const supabaseLogs = logsIntegration("supabase-logs", supabase, reader);
