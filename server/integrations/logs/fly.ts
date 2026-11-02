import type { Connection, LogLine } from "../../../shared/types.ts";
import { getJson, ProviderError } from "../../http.ts";
import { fly } from "../fly.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import type { ServiceAuth } from "../types.ts";
import { looksLikeError } from "./digitalocean.ts";

// A Fly.io app's runtime errors, from GET https://api.fly.io/api/v1/apps/{app}/logs:
// the endpoint `fly logs` uses. Fly's docs (Monitoring → Logs API options)
// describe it but say it isn't officially supported for outside use, only
// "mostly stable" because flyctl depends on it. A read-only token reads it.
// It answers a JSON:API document: `data` (entries, oldest first, about 100
// a page) and `meta.next_token`, a nanosecond time; given as `next_token`,
// it returns the entries after that time. Every line comes back, not only
// errors, and an app's own output is mostly level "info" whatever it says,
// so an entry is an error when Fly marks it so (level error, a 5xx answer)
// or its text reads as one (looksLikeError, the same guess as DigitalOcean's).
//
// Reading only forward from a time, a busy hour could take many pages; the
// last quarter-hour is read first, so the stretch a spike is judged on is
// never the part left out.

const API = "https://api.fly.io/api/v1";
const PAGES_PER_STRETCH = 25;
const RECENT_MS = 15 * 60_000;

export type FlyEntry = {
  timestamp?: string;
  message?: string;
  level?: string;
  instance?: string;
  region?: string;
  meta?: { instance?: string; region?: string; http?: { response?: { status_code?: number } }; error?: { code?: number; message?: string } };
};
type FlyPage = { data?: { id?: string; attributes?: FlyEntry }[]; meta?: { next_token?: string } };

const nanos = (ms: number) => `${BigInt(Math.floor(ms)) * 1_000_000n}`;

export function toLogLine(e: FlyEntry): LogLine | undefined {
  const ms = e.timestamp ? Date.parse(e.timestamp) : NaN;
  const message = (e.message ?? "").trim();
  if (Number.isNaN(ms) || !message) return undefined;
  const marked = (e.level ?? "").toLowerCase();
  const status = e.meta?.http?.response?.status_code ?? 0;
  const level: LogLine["level"] | undefined =
    ["fatal", "panic", "critical", "crit", "emerg", "alert"].includes(marked) ? "fatal" : marked === "error" || status >= 500 ? "error" : looksLikeError(message);
  if (!level) return undefined;
  const source = e.instance || e.meta?.instance;
  return { at: new Date(ms).toISOString(), level, message, ...(source ? { source } : {}) };
}

// A token from `fly tokens create` is "FlyV1 fm2_…", its own scheme; an
// older personal token goes as a Bearer token.
async function page(auth: ServiceAuth, app: string, nextToken: string): Promise<FlyPage> {
  const token = (await auth.token()).trim();
  const headers: Record<string, string> = token.startsWith("FlyV1 ") ? { authorization: token } : {};
  try {
    return await getJson<FlyPage>(`${API}/apps/${encodeURIComponent(app)}/logs?${new URLSearchParams({ next_token: nextToken })}`, { token, headers, provider: "Fly.io", ttlMs: 30_000 });
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
      throw new ProviderError(err.status, `Fly.io refused to read this app's logs (${err.status}): use a token that can read the app, such as one from fly tokens create readonly personal`, err.body);
    }
    throw err;
  }
}

// The error lines from `from` to `to` (ms), and whether pages were left.
async function stretch(conn: Connection, auth: ServiceAuth, from: number, to: number): Promise<{ lines: LogLine[]; partial: boolean }> {
  const lines: LogLine[] = [];
  let token = nanos(from);
  for (let i = 0; i < PAGES_PER_STRETCH; i++) {
    const p = await page(auth, conn.resource, token);
    const entries = (p.data ?? []).map((d) => d.attributes).filter((e): e is FlyEntry => !!e);
    let pastEnd = false;
    for (const e of entries) {
      const ms = e.timestamp ? Date.parse(e.timestamp) : NaN;
      if (ms > to) {
        pastEnd = true;
        continue;
      }
      if (!(ms >= from)) continue;
      const l = toLogLine(e);
      if (l) lines.push(l);
    }
    const next = p.meta?.next_token;
    if (pastEnd || !entries.length || !next || next === token) return { lines, partial: false };
    token = next;
  }
  return { lines, partial: true };
}

export const reader: LogReader = {
  provider: "Fly.io",

  async readErrors(conn, auth, since, limit) {
    const now = Date.now();
    const start = Date.parse(since);
    const cut = Math.max(start, now - RECENT_MS);
    const recent = await stretch(conn, auth, cut, now + 60_000);
    const before = cut > start ? await stretch(conn, auth, start, cut - 1) : { lines: [], partial: false };
    const lines = [...recent.lines, ...before.lines].sort((a, b) => b.at.localeCompare(a.at));
    const partial = recent.partial || before.partial || lines.length > limit;
    return { lines: lines.slice(0, limit), ...(partial ? { partial: true } : {}) };
  },

  dashboardUrl: (conn) => `https://fly.io/apps/${encodeURIComponent(conn.resource)}/monitoring`,
};

export const flyLogs = logsIntegration("fly-logs", fly, reader);
