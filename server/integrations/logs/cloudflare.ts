import type { Connection, LogLine, Resource } from "../../../shared/types.ts";
import { badRequest } from "../../errors.ts";
import { getJson, postJson, ProviderError } from "../../http.ts";
import { cloudflareIntegration, kindOf } from "../cloudflare.ts";
import { logsIntegration } from "../logs.ts";
import type { LogReader } from "../logs.ts";
import type { ServiceAuth } from "../types.ts";

// A Worker's runtime errors from Workers Logs, through the Workers
// Observability telemetry query API (POST …/workers/observability/telemetry/query:
// a read, despite the POST). Only Workers have these logs, not Pages projects.
// The query asks for the Worker's events that failed: an invocation whose
// outcome is an exception (or ran out of CPU or memory), a console.error, or
// an event carrying an error. Cloudflare's API accepts only "Workers
// Observability Write" for this query (Edit in the dashboard), even though
// it changes nothing; `dry` keeps the query from being saved.

const API = "https://api.cloudflare.com/client/v4";
const MAX_EVENTS = 2000; // the most the events view returns
const SETTINGS_TTL_MS = 10 * 60_000;

const NEEDS_OBSERVABILITY =
  "add Account → Workers Observability → Edit to the token in Cloudflare → My Profile → API Tokens (Cloudflare's API accepts only that one for reading Workers Logs)";
const TURN_ON_LOGS =
  "Workers Logs are off for this Worker, so Cloudflare keeps no logs to read. Turn them on: add `[observability] enabled = true` to its wrangler.toml (or `\"observability\": { \"enabled\": true }` to wrangler.jsonc) and deploy, or in Cloudflare open Workers & Pages → this Worker → Settings → Observability and enable Workers Logs";

type CfEnvelope<T> = { success?: boolean; result: T; errors?: { message?: string }[] };
export type CfEvent = {
  timestamp?: number; // ms since 1970
  $metadata?: { id?: string; error?: string; level?: string; message?: string; trigger?: string; url?: string };
  $workers?: { outcome?: string; eventType?: string; scriptName?: string; entrypoint?: string };
};
type CfQueryResult = { events?: { count?: number; events?: CfEvent[] } };
type CfScriptSettings = { observability?: { enabled?: boolean; logs?: { enabled?: boolean } } | null };
type CfScript = { id: string; has_assets?: boolean; has_modules?: boolean };

// A Worker that only serves static files (assets, no code) runs nothing, so
// it has no runtime errors and Workers Logs has nothing to record: it isn't
// offered. Cloudflare still lists a "fetch" handler for one (the assets
// answer it), but it has no modules: a Worker with code alongside its assets
// is built as ES modules.
export const onlyAssets = (s: CfScript) => s.has_assets === true && s.has_modules === false;

async function scriptsWithCode(auth: ServiceAuth, account: string): Promise<Set<string> | undefined> {
  try {
    const body = await getJson<CfEnvelope<CfScript[]>>(`${API}/accounts/${account}/workers/scripts`, { token: await auth.token(), provider: "Cloudflare", ttlMs: SETTINGS_TTL_MS });
    return new Set(body.result.filter((s) => !onlyAssets(s)).map((s) => s.id));
  } catch {
    return undefined; // can't tell: offer them all, as before
  }
}

const FAILED_OUTCOMES = ["exception", "exceededCpu", "exceededMemory"];

const accountOf = (conn: Connection) => {
  const id = conn.settings?.accountId;
  return typeof id === "string" && /^[a-f0-9]{32}$/i.test(id) ? id : undefined;
};

export function queryBody(worker: string, from: number, to: number, limit: number) {
  return {
    queryId: "periskopos-worker-errors",
    timeframe: { from, to },
    view: "events",
    dry: true,
    limit,
    parameters: {
      datasets: ["cloudflare-workers"],
      filterCombination: "and",
      filters: [
        { key: "$workers.scriptName", operation: "eq", type: "string", value: worker },
        {
          kind: "group",
          filterCombination: "or",
          filters: [
            { key: "$workers.outcome", operation: "in", type: "string", value: FAILED_OUTCOMES.join(",") },
            { key: "$metadata.level", operation: "in", type: "string", value: "error,fatal" },
            { key: "$metadata.error", operation: "exists", type: "string" },
          ],
        },
      ],
    },
  };
}

export function toLogLine(e: CfEvent): LogLine | undefined {
  if (typeof e.timestamp !== "number" || !Number.isFinite(e.timestamp)) return undefined;
  const m = e.$metadata ?? {};
  const w = e.$workers ?? {};
  const outcome = w.outcome && w.outcome !== "ok" ? w.outcome : undefined;
  const message = (m.error || m.message || (outcome ? `Invocation ended: ${outcome}${m.trigger ? ` (${m.trigger})` : ""}` : "")).trim();
  if (!message) return undefined;
  const level: LogLine["level"] = m.level === "fatal" || outcome === "exceededCpu" || outcome === "exceededMemory" ? "fatal" : "error";
  const source = w.entrypoint || w.eventType;
  return { at: new Date(e.timestamp).toISOString(), level, message, ...(source ? { source } : {}) };
}

// Whether the Worker writes Workers Logs at all (Workers Scripts: Read, which
// the token already has); undefined when the key can't say.
async function logsEnabled(auth: ServiceAuth, account: string, worker: string): Promise<boolean | undefined> {
  try {
    const body = await getJson<CfEnvelope<CfScriptSettings>>(`${API}/accounts/${account}/workers/scripts/${encodeURIComponent(worker)}/script-settings`, {
      token: await auth.token(),
      provider: "Cloudflare",
      ttlMs: SETTINGS_TTL_MS,
    });
    const o = body.result?.observability;
    if (!o) return false; // never set up: no Workers Logs
    return o.enabled === true && o.logs?.enabled !== false;
  } catch {
    return undefined;
  }
}

export const reader: LogReader = {
  provider: "Cloudflare",

  async readErrors(conn, auth, since, limit) {
    if (kindOf(conn) !== "worker") throw new ProviderError(0, "Cloudflare keeps runtime logs for Workers only; this is a Pages project");
    const account = accountOf(conn);
    if (!account) throw new ProviderError(0, "This Worker has no Cloudflare account id; connect it again from the list");
    const ask = Math.min(limit + 1, MAX_EVENTS);
    let body: CfEnvelope<CfQueryResult>;
    try {
      body = await postJson<CfEnvelope<CfQueryResult>>(`${API}/accounts/${account}/workers/observability/telemetry/query`, queryBody(conn.resource, Date.parse(since), Date.now(), ask), {
        token: await auth.token(),
        provider: "Cloudflare",
      });
    } catch (err) {
      if (err instanceof ProviderError && err.status === 403) {
        throw new ProviderError(403, `Cloudflare refused to read this Worker's logs (403): ${NEEDS_OBSERVABILITY}`, err.body);
      }
      throw err;
    }
    if (body.success === false) throw new ProviderError(200, `Cloudflare: ${body.errors?.[0]?.message ?? "the logs query failed"}`);
    const events = body.result?.events?.events ?? [];
    const count = body.result?.events?.count;
    const lines = events.map(toLogLine).filter((l): l is LogLine => !!l && l.at >= since);
    if (events.length === 0 && (await logsEnabled(auth, account, conn.resource)) === false) throw new ProviderError(200, TURN_ON_LOGS);
    const partial = lines.length > limit || events.length >= ask || (typeof count === "number" && count > events.length);
    return { lines: lines.slice(0, limit), ...(partial ? { partial: true } : {}) };
  },

  dashboardUrl(conn) {
    const account = accountOf(conn);
    return account ? `https://dash.cloudflare.com/${account}/workers/services/view/${encodeURIComponent(conn.resource)}/production/observability/logs` : undefined;
  },

  // Workers only: a Pages project keeps no runtime logs Periskopos can read.
  async listResources(auth): Promise<Resource[]> {
    const all = await cloudflareIntegration.listResources!(auth);
    const workers = all.filter((r) => r.settings?.kind === "worker");
    if (!workers.length) {
      throw new Error(
        "This Cloudflare token sees no Workers, only Pages projects: Worker logs are for Workers. If you have Workers, add Account → Workers Scripts → Read to the token in Cloudflare → My Profile → API Tokens.",
      );
    }
    const accounts = [...new Set(workers.map((w) => String(w.settings?.accountId ?? "")))].filter(Boolean);
    const withCode = await Promise.all(accounts.map(async (a) => [a, await scriptsWithCode(auth, a)] as const));
    const coded = new Map(withCode);
    const running = workers.filter((w) => coded.get(String(w.settings?.accountId))?.has(String(w.settings?.name)) ?? true);
    if (!running.length) {
      throw new Error("Your Workers only serve static files: no code runs, so there are no runtime errors to read. Errors would show in the domain's traffic (5xx) instead.");
    }
    return running;
  },

  parse(input) {
    const parsed = cloudflareIntegration.parse(input);
    if (parsed.settings?.kind !== "worker") throw badRequest("Worker logs are for Workers: pick a Worker from the list, not a Pages project");
    return parsed;
  },
};

export const cloudflareLogs = logsIntegration("cloudflare-logs", cloudflareIntegration, reader);
