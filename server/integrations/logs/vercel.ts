import type { Connection, LogLine } from "../../../shared/types.ts";
import { ProviderError } from "../../http.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import type { ServiceAuth } from "../types.ts";
import { vercel } from "../vercel.ts";
import { APP_USER_AGENT } from "../../config.ts";

// Vercel's runtime logs: the live production deploy's function and
// middleware output (GET /v1/projects/{id}/deployments/{id}/runtime-logs).
// The answer is a stream of JSON lines that stays open to follow new ones,
// so it's read for a few seconds at most, and the newest lines are kept.

const API = "https://api.vercel.com";
export const streamLimits = { readMs: 8_000 }; // how long the stream is read before it's cut

type VLog = {
  level?: string; // debug, info, warning, error, fatal, trace
  message?: string;
  source?: string; // serverless, edge-function, edge-middleware, request, delimiter
  requestMethod?: string;
  requestPath?: string;
  responseStatusCode?: number;
  timestampInMs?: number;
  domain?: string;
};

// One streamed line as a LogLine, when it's an error: an error or fatal line,
// or a request the platform answered with a 5xx (a function that crashed or
// timed out shows as one). Warnings are kept apart, for a deploy that has
// nothing stronger.
export function toLogLine(l: VLog): LogLine | undefined {
  if (typeof l.timestampInMs !== "number" || !Number.isFinite(l.timestampInMs)) return undefined;
  const status = Number(l.responseStatusCode);
  const failedRequest = l.source === "request" && status >= 500;
  const level = l.level === "fatal" ? "fatal" : l.level === "error" || failedRequest ? "error" : l.level === "warning" ? "warning" : undefined;
  if (!level) return undefined;
  const route = l.requestPath ? `${l.requestMethod ? `${l.requestMethod} ` : ""}${l.requestPath}` : undefined;
  const message = (l.message ?? "").trim() || (failedRequest ? `${route ?? "Request"} answered ${status}` : "");
  if (!message) return undefined;
  return { at: new Date(l.timestampInMs).toISOString(), level, message, ...(route ? { source: route } : {}) };
}

function refused(status: number, body: string): ProviderError {
  if (status === 401) return new ProviderError(401, "Vercel rejected the key (401): it may be mistyped, expired or revoked", body);
  if (status === 403) {
    return new ProviderError(
      403,
      "Vercel refused to read this project's runtime logs (403): the token needs access to the project's team. Create it with its scope set to that team (or Full Account)",
      body,
    );
  }
  if (status === 404) return new ProviderError(404, "Vercel doesn't know this project or deploy (404), or the token can't see it", body);
  return new ProviderError(status, `Vercel answered HTTP ${status} reading runtime logs`, body);
}

// Read the stream until it ends, the time is up, or it has been read through
// enough lines; keep the newest `limit` errors since `since`.
async function readStream(url: string, token: string, since: number, limit: number): Promise<{ lines: LogLine[]; partial?: boolean }> {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), streamLimits.readMs);
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/stream+json", "user-agent": APP_USER_AGENT },
      signal: stop.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new ProviderError(0, `Can't reach Vercel: ${(err as Error).message}`);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw refused(res.status, await res.text().catch(() => ""));
  }

  const errors: LogLine[] = [];
  const warnings: LogLine[] = [];
  let dropped = false;
  const keep = (list: LogLine[], l: LogLine) => {
    list.push(l);
    if (list.length > limit) {
      list.sort((a, b) => b.at.localeCompare(a.at)).length = limit; // the newest stay
      if (list === errors) dropped = true;
    }
  };
  const take = (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    let parsed: VLog;
    try {
      parsed = JSON.parse(text) as VLog;
    } catch {
      return; // a keep-alive or a cut line
    }
    const l = toLogLine(parsed);
    if (!l || Date.parse(l.at) < since) return;
    keep(l.level === "warning" ? warnings : errors, l);
  };

  const decoder = new TextDecoder();
  let buffer = "";
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          take(buffer.slice(0, nl));
          buffer = buffer.slice(nl + 1);
        }
      }
      take(buffer);
    }
  } catch (err) {
    // The time limit cutting a stream that stays open is the normal end.
    if (!stop.signal.aborted) throw new ProviderError(0, `Vercel's log stream broke off: ${(err as Error).message}`);
  } finally {
    clearTimeout(timer);
    stop.abort();
  }
  if (errors.length) return { lines: errors, ...(dropped ? { partial: true } : {}) };
  return { lines: warnings };
}

export const reader: LogReader = {
  provider: "Vercel",

  async readErrors(conn: Connection, auth: ServiceAuth, since: string, limit: number) {
    // The deploy serving production now, found as the host connection finds it.
    const live = (await vercel.deploys!(conn, auth)).find((d) => d.phase === "live");
    if (!live) return { lines: [] };
    const teamId = conn.settings?.teamId;
    const team = typeof teamId === "string" && teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
    const url = `${API}/v1/projects/${encodeURIComponent(conn.resource)}/deployments/${encodeURIComponent(live.id)}/runtime-logs${team}`;
    return readStream(url, await auth.token(), Date.parse(since), limit);
  },

  dashboardUrl(conn) {
    const { scope, name } = conn.settings ?? {};
    return typeof scope === "string" && typeof name === "string"
      ? `https://vercel.com/${encodeURIComponent(scope)}/${encodeURIComponent(name)}/logs?levels=error`
      : undefined;
  },
};

export const vercelLogs = logsIntegration("vercel-logs", vercel, reader);
