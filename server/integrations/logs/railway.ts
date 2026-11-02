import type { Connection, Deploy, LogLine } from "../../../shared/types.ts";
import { ProviderError, queryJson } from "../../http.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import { railway } from "../railway.ts";
import type { ServiceAuth } from "../types.ts";

// Railway's runtime logs, through its GraphQL API's deploymentLogs query:
// the lines at error level (Railway records stderr as error) of the deploy
// serving the service, and of a newer one that crashed, since `since`.

const API = "https://backboard.railway.com/graphql/v2";
const LOGS_TTL_MS = 30_000;
const MAX_DEPLOYS = 3;

type RwLog = { timestamp: string; message: string; severity?: string | null };

// The dates go in as literals: the API takes them as its DateTime scalar.
export const LOGS_QUERY = (since: string, until: string, filter: string) =>
  `query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit, filter: ${JSON.stringify(filter)}, startDate: ${JSON.stringify(since)}, endDate: ${JSON.stringify(until)}) { timestamp message severity } }`;

export function toLogLine(l: RwLog, source?: string): LogLine | undefined {
  const s = (l.severity ?? "").toLowerCase();
  const level = s === "error" || s === "err" ? "error" : s === "fatal" || s === "critical" || s === "crit" ? "fatal" : s === "warn" || s === "warning" ? "warning" : undefined;
  if (!level || !l.message?.trim() || Number.isNaN(Date.parse(l.timestamp))) return undefined;
  return { at: new Date(l.timestamp).toISOString(), level, message: l.message.trim(), ...(source ? { source } : {}) };
}

function refused(err: unknown): never {
  if (err instanceof ProviderError && (err.status === 401 || err.status === 403 || /not authori[sz]ed/i.test(err.message))) {
    throw new ProviderError(
      err.status,
      "Railway refused to read this service's logs: use an account token, or a workspace token for the workspace the project is in, with access to the project",
      err.body,
    );
  }
  throw err;
}

// The deploys whose logs say how the service runs now: the one serving it,
// and any newer one that failed or crashed.
function deploysToRead(list: Deploy[]): Deploy[] {
  const liveAt = list.findIndex((d) => d.phase === "live");
  const newer = (liveAt < 0 ? list : list.slice(0, liveAt)).filter((d) => d.phase === "failed");
  return [...newer, ...(liveAt >= 0 ? [list[liveAt]!] : [])].slice(0, MAX_DEPLOYS);
}

async function read(deploys: Deploy[], token: string, filter: string, since: string, until: string, limit: number): Promise<{ lines: LogLine[]; partial?: boolean }> {
  const lines: LogLine[] = [];
  let partial = false;
  for (const d of deploys) {
    const { deploymentLogs } = await queryJson<{ deploymentLogs: RwLog[] | null }>(
      API,
      { query: LOGS_QUERY(since, until, filter), variables: { deploymentId: d.id, limit: limit + 1 } },
      { token, provider: "Railway", ttlMs: LOGS_TTL_MS },
    ).catch(refused);
    const got = deploymentLogs ?? [];
    if (got.length > limit) partial = true;
    const source = deploys.length > 1 ? `deploy ${d.id.slice(0, 8)}` : undefined;
    for (const raw of got) {
      const l = toLogLine(raw, source);
      if (l && l.at >= since) lines.push(l);
    }
  }
  if (lines.length > limit) {
    lines.sort((a, b) => b.at.localeCompare(a.at)).length = limit; // the newest stay
    partial = true;
  }
  return { lines, ...(partial ? { partial: true } : {}) };
}

export const reader: LogReader = {
  provider: "Railway",

  async readErrors(conn: Connection, auth: ServiceAuth, since: string, limit: number) {
    const deploys = deploysToRead(await railway.deploys!(conn, auth).catch(refused));
    if (!deploys.length) return { lines: [] };
    const token = await auth.token();
    const until = new Date().toISOString();
    const errors = await read(deploys, token, "@level:error", since, until, limit);
    if (errors.lines.length) return errors;
    return read(deploys, token, "@level:warn", since, until, limit);
  },

  dashboardUrl(conn) {
    const { projectId, environmentId } = conn.settings ?? {};
    if (typeof projectId !== "string" || typeof environmentId !== "string") return undefined;
    return `https://railway.com/project/${encodeURIComponent(projectId)}/service/${encodeURIComponent(conn.resource)}?environmentId=${encodeURIComponent(environmentId)}`;
  },
};

export const railwayLogs = logsIntegration("railway-logs", railway, reader);
