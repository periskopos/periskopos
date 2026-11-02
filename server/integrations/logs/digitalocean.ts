import type { LogLine } from "../../../shared/types.ts";
import { getJson, ProviderError } from "../../http.ts";
import { dashboardOf, digitalocean } from "../digitalocean.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import { APP_USER_AGENT } from "../../config.ts";

// An App Platform app's runtime errors. GET /v2/apps/{id}/logs?type=RUN&follow=false
// (app: read) answers with links, not lines: `live_url` (https or wss) and
// `historic_urls`, pre-signed addresses of plain-text logs for the active
// deployment's components, one line each, as `doctl apps logs` prints them:
//   web 2026-10-29T10:00:00.123456789Z TypeError: Cannot read properties of undefined
// (the component's name first, then an RFC 3339 time). Those links are
// fetched without the DigitalOcean token: they carry their own signature,
// and the token must never go to another host. The API has no "since":
// lines before it are dropped here.
//
// DigitalOcean doesn't tag lines with a level, so which lines are errors is
// guessed from the text (looksLikeError below):
//   fatal  FATAL, PANIC, CRITICAL, EMERG, ALERT as words in capitals; Go's
//          "panic:"; level=fatal/critical/panic (logfmt or JSON); pino's level 60
//   error  ERROR or ERR as words in capitals, [error]; level=error (logfmt or
//          JSON); pino's level 50; "SomethingError:" or "SomethingException:"
//          (JS, Python, Java); Python's "Traceback (most recent call last)";
//          Unhandled/uncaught; and an HTTP status 5xx in an access-log line
//          ("GET /x HTTP/1.1" 500, GET /x 500 12ms, status=500)
// Lines saying "0 errors" or "no errors" don't count. A stack trace's own
// lines ("    at …") match nothing, so a trace counts once, by its first
// line (a Python traceback twice: its header and its last line).

const API = "https://api.digitalocean.com/v2";
const LINKS_TTL_MS = 30_000;
const MAX_BYTES = 4_000_000;

const NOT_AN_ERROR = /\b(?:0|no|zero) errors?\b/i;
const FATAL = [
  /\b(?:FATAL|PANIC|CRITICAL|CRIT|EMERG|EMERGENCY|ALERT)\b/,
  /(?:^|\s)panic: /,
  /\blevel["']?\s*[:=]\s*["']?(?:fatal|critical|crit|panic|emerg|emergency|alert)\b/i,
  /"level"\s*:\s*60\b/,
];
const ERROR = [
  /\b(?:ERROR|ERR)\b/,
  /\[error\]/i,
  /\blevel["']?\s*[:=]\s*["']?(?:error|err)\b/i,
  /"level"\s*:\s*50\b/,
  /\b[A-Za-z_$.]*(?:Error|Exception)(?::\s|:$|$)/,
  /Traceback \(most recent call last\)/,
  /\bunhandled\b|\buncaught\b/i,
  /\bHTTP\/[\d.]+"?\s+5\d\d\b/,
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+\S+\s+5\d\d\b/,
  /\bstatus(?:[_ ]?code)?["']?\s*[:=]\s*["']?5\d\d\b/i,
];

// Whether a plain log line reads as an error, and how bad (see above).
export function looksLikeError(message: string): LogLine["level"] | undefined {
  if (NOT_AN_ERROR.test(message)) return undefined;
  if (FATAL.some((r) => r.test(message))) return "fatal";
  if (ERROR.some((r) => r.test(message))) return "error";
  return undefined;
}

const LINE = /^(?:(\S+)\s+)?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))\s?(.*)$/;

// The error lines in a plain-text log, newer than `since`.
export function errorLines(text: string, since: string): LogLine[] {
  const lines: LogLine[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(LINE);
    if (!m) continue; // a line without a time (a stack trace's) isn't counted on its own
    const ms = Date.parse(m[2]!.replace(/(\.\d{3})\d+/, "$1"));
    if (Number.isNaN(ms)) continue;
    const at = new Date(ms).toISOString();
    const message = m[3]!.trim();
    if (at < since || !message) continue;
    const level = looksLikeError(message);
    if (!level) continue;
    lines.push({ at, level, message, ...(m[1] ? { source: m[1] } : {}) });
  }
  return lines;
}

// A pre-signed log file: no token, no redirect to anywhere unexpected
// carrying one; only the end is kept.
async function fetchLog(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { "user-agent": APP_USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ProviderError(0, `Can't reach DigitalOcean's logs: ${(err as Error).message}`);
  }
  if (!res.ok) throw new ProviderError(res.status, `DigitalOcean's log file answered HTTP ${res.status}`);
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(-MAX_BYTES) : text;
}

export const reader: LogReader = {
  provider: "DigitalOcean",

  async readErrors(conn, auth, since, limit) {
    const q = new URLSearchParams({ type: "RUN", follow: "false", pod_connection_timeout: "10s" });
    let links: { live_url?: string; historic_urls?: string[] };
    try {
      links = await getJson(`${API}/apps/${encodeURIComponent(conn.resource)}/logs?${q}`, { token: await auth.token(), provider: "DigitalOcean", ttlMs: LINKS_TTL_MS });
    } catch (err) {
      if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
        throw new ProviderError(err.status, `DigitalOcean refused to read this app's logs (${err.status}): the token needs the app: read scope`, err.body);
      }
      throw err;
    }
    const https = (u: unknown): u is string => typeof u === "string" && u.startsWith("https://");
    const url = https(links.live_url) ? links.live_url : (links.historic_urls ?? []).find(https);
    if (!url) return { lines: [] }; // nothing running yet, so nothing logged
    const lines = errorLines(await fetchLog(url), since).sort((a, b) => b.at.localeCompare(a.at));
    return lines.length > limit ? { lines: lines.slice(0, limit), partial: true } : { lines };
  },

  dashboardUrl: (conn) => `${dashboardOf(conn)}/logs`,
};

export const digitaloceanLogs = logsIntegration("digitalocean-logs", digitalocean, reader);
