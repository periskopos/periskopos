import type { Connection, LogLine } from "../../../shared/types.ts";
import { getJson, ProviderError } from "../../http.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import { renderIntegration } from "../render.ts";
import type { ServiceAuth } from "../types.ts";

// Render's logs API (GET /v1/logs): a service's lines at error level or
// above, newest first, a page of 100 at a time. The API wants the service's
// workspace too, read from the service itself.

const API = "https://api.render.com/v1";
const PAGE = 100; // the most the API gives per page
const STRONG = ["error", "critical", "alert", "emergency"];
const LOGS_TTL_MS = 30_000;
const OWNER_TTL_MS = 10 * 60_000; // a service doesn't change workspace

type RLog = { id: string; message: string; timestamp: string; labels?: { name: string; value: string }[] };
type RPage = { hasMore?: boolean; nextStartTime?: string; nextEndTime?: string; logs?: RLog[] };

function refused(err: unknown): never {
  if (err instanceof ProviderError && (err.status === 401 || err.status === 403)) {
    throw new ProviderError(
      err.status,
      `Render refused to read this service's logs (${err.status}): use an API key of a workspace member who can see the service (Render keys can't be limited, so a key that lists the service can read its logs)`,
      err.body,
    );
  }
  throw err;
}

export function toLogLine(l: RLog): LogLine | undefined {
  const label = (name: string) => l.labels?.find((x) => x.name === name)?.value;
  const level = (label("level") ?? "").toLowerCase();
  const mapped = level === "error" ? "error" : ["critical", "alert", "emergency", "fatal"].includes(level) ? "fatal" : level === "warning" || level === "warn" ? "warning" : undefined;
  if (!mapped || !l.message?.trim() || Number.isNaN(Date.parse(l.timestamp))) return undefined;
  const instance = label("instance");
  return { at: new Date(l.timestamp).toISOString(), level: mapped, message: l.message.trim(), ...(instance ? { source: instance } : {}) };
}

async function readLevels(conn: Connection, token: string, ownerId: string, levels: string[], since: string, limit: number): Promise<{ lines: LogLine[]; partial?: boolean }> {
  const lines: LogLine[] = [];
  let startTime = since;
  let endTime = new Date().toISOString();
  for (;;) {
    const q = new URLSearchParams({ ownerId, resource: conn.resource, startTime, endTime, direction: "backward", limit: String(PAGE) });
    for (const level of levels) q.append("level", level);
    const page = await getJson<RPage>(`${API}/logs?${q}`, { token, provider: "Render", ttlMs: LOGS_TTL_MS }).catch(refused);
    for (const raw of page.logs ?? []) {
      const l = toLogLine(raw);
      if (!l || l.at < since) continue;
      if (lines.length >= limit) return { lines, partial: true };
      lines.push(l);
    }
    if (!page.hasMore || !page.nextStartTime || !page.nextEndTime) return { lines };
    if (lines.length >= limit) return { lines, partial: true };
    if (page.nextStartTime === startTime && page.nextEndTime === endTime) return { lines }; // never loop in place
    startTime = page.nextStartTime;
    endTime = page.nextEndTime;
  }
}

export const reader: LogReader = {
  provider: "Render",

  async readErrors(conn: Connection, auth: ServiceAuth, since: string, limit: number) {
    const token = await auth.token();
    const service = await getJson<{ ownerId?: string }>(`${API}/services/${encodeURIComponent(conn.resource)}`, { token, provider: "Render", ttlMs: OWNER_TTL_MS }).catch(refused);
    if (!service.ownerId) throw new ProviderError(200, "Render didn't say which workspace this service belongs to");
    const strong = await readLevels(conn, token, service.ownerId, STRONG, since, limit);
    if (strong.lines.length) return strong;
    return readLevels(conn, token, service.ownerId, ["warning"], since, limit);
  },

  dashboardUrl(conn) {
    const url = conn.settings?.dashboardUrl;
    return typeof url === "string" && url.startsWith("https://dashboard.render.com/") ? `${url.replace(/\/$/, "")}/logs` : undefined;
  },
};

export const renderLogs = logsIntegration("render-logs", renderIntegration, reader);
