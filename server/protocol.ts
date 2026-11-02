import type { App, AppMetric, ProtocolManifest, ProtocolView } from "../shared/types.ts";
import { envFile, readSecret } from "./keys/secrets.ts";
import { APP_USER_AGENT } from "./config.ts";

// The app protocol, client side (PRD §10.5). An app answers at an endpoint
// with a bearer secret: GET manifest, metrics, actions; POST actions/<id>.
// Unknown capabilities are ignored, so an app can be ahead of this code.

export const SUPPORTED_PROTOCOLS = [1];
const MAX_BODY = 256 * 1024;
const CACHE_MS = 30_000;
// How long each request may take. Exported so the MCP client can wait for
// the worst case of an agent's action (mcp/server.ts).
export const PROTOCOL_TIMEOUT_MS = 15_000;
export const PROTOCOL_ACTION_TIMEOUT_MS = 60_000;

export class ProtocolError extends Error {}

// One secret per app, named after it, kept in .env.local.
export const protocolSecretRef = (slug: string) => `PERISKOPOS_PROTOCOL_${slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}`;

// https, except loopback (a local dev server). Never anything else.
export function validateEndpoint(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) throw new ProtocolError("Enter the endpoint's address");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new ProtocolError("The endpoint must be a full address, like https://abc.supabase.co/functions/v1/periskopos");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new ProtocolError("The endpoint must use https (http is only allowed for localhost)");
  }
  if (url.username || url.password) throw new ProtocolError("The endpoint address must not contain a password");
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/+$/, "");
}

async function request(endpoint: string, secret: string, route: string, { method = "GET", body, timeoutMs = PROTOCOL_TIMEOUT_MS }: { method?: string; body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(`${endpoint}${route}`, {
      method,
      // The secret must never follow a redirect to somewhere else.
      redirect: "manual",
      headers: {
        authorization: `Bearer ${secret}`,
        accept: "application/json",
        "user-agent": APP_USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string }; message?: string };
    if (e.name === "TimeoutError") throw new ProtocolError(`The endpoint didn't answer within ${timeoutMs / 1000} s`);
    if (e.cause?.code === "ENOTFOUND") throw new ProtocolError("The endpoint's domain wasn't found (DNS)");
    if (e.cause?.code === "ECONNREFUSED") throw new ProtocolError("The endpoint refused the connection");
    throw new ProtocolError(`Couldn't reach the endpoint: ${e.cause?.code ?? e.message ?? "unknown error"}`);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new ProtocolError(`The endpoint redirected to ${res.headers.get("location") ?? "somewhere else"}. Use its final address: the secret is never sent along a redirect.`);
  }
  const text = await readLimited(res);
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const said = (json as { error?: unknown } | undefined)?.error;
    if (res.status === 401) throw new ProtocolError("The endpoint rejected the secret (401). Redeploy it with the current secret, or generate a new one.");
    if (res.status === 404 && typeof said !== "string") throw new ProtocolError(`Nothing is served at ${route || "/"} (404). Is the endpoint address right, and is the function deployed?`);
    throw new ProtocolError(typeof said === "string" ? said.slice(0, 300) : `The endpoint answered HTTP ${res.status}`);
  }
  if (json === undefined) throw new ProtocolError("The endpoint didn't answer with JSON");
  return json;
}

// Reads at most MAX_BODY bytes: a declared length over it is refused before
// reading, and an answer that keeps going is cut off rather than held whole
// in memory.
async function readLimited(res: Response): Promise<string> {
  const tooLarge = () => new ProtocolError("The endpoint's answer was too large");
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body?.cancel().catch(() => {});
    throw tooLarge();
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// ── Validating what comes back: only known shapes get through ──────────

const str = (v: unknown, max: number) => (typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined);

export function cleanManifest(json: unknown): ProtocolManifest {
  const m = json as { protocol?: unknown; app?: { name?: unknown; version?: unknown; commit?: unknown }; capabilities?: unknown };
  if (typeof m?.protocol !== "number") throw new ProtocolError("That doesn't look like a Periskopos endpoint (no protocol version in its manifest)");
  if (!SUPPORTED_PROTOCOLS.includes(m.protocol)) {
    throw new ProtocolError(`The endpoint speaks protocol ${m.protocol}; this Periskopos supports ${SUPPORTED_PROTOCOLS.join(", ")}. Update one of them.`);
  }
  const name = str(m.app?.name, 100);
  if (!name) throw new ProtocolError("The manifest has no app name");
  const version = str(m.app?.version, 40);
  const commit = str(m.app?.commit, 40);
  const capabilities = Array.isArray(m.capabilities) ? [...new Set(m.capabilities.map((c) => str(c, 40)).filter((c): c is string => Boolean(c)))].slice(0, 20) : [];
  return { protocol: m.protocol, app: { name, ...(version ? { version } : {}), ...(commit ? { commit } : {}) }, capabilities };
}

export function cleanMetrics(json: unknown): { items: AppMetric[]; at?: string } {
  const list = (json as { metrics?: unknown })?.metrics;
  if (!Array.isArray(list)) throw new ProtocolError("The metrics answer has no metrics list");
  const items: AppMetric[] = [];
  for (const m of list as Record<string, unknown>[]) {
    const id = str(m?.id, 40);
    const label = str(m?.label, 60);
    const value = typeof m?.value === "number" && Number.isFinite(m.value) ? m.value : str(m?.value, 100);
    if (!id || !label || value === undefined) continue; // skip what doesn't fit, keep the rest
    const hint = str(m.hint, 60);
    items.push({ id, label, value, ...(hint ? { hint } : {}) });
    if (items.length === 12) break;
  }
  const at = str((json as { at?: unknown }).at, 40);
  return { items, ...(at ? { at } : {}) };
}

export function cleanActions(json: unknown): NonNullable<ProtocolView["actions"]> {
  const list = (json as { actions?: unknown })?.actions;
  if (!Array.isArray(list)) throw new ProtocolError("The actions answer has no actions list");
  const out: NonNullable<ProtocolView["actions"]> = [];
  for (const a of list as Record<string, unknown>[]) {
    const id = typeof a?.id === "string" && /^[\w-]{1,60}$/.test(a.id) ? a.id : undefined;
    const label = str(a?.label, 60);
    if (!id || !label) continue;
    const description = str(a.description, 300);
    out.push({ id, label, ...(description ? { description } : {}), confirm: a.confirm !== false, danger: a.danger === true });
    if (out.length === 20) break;
  }
  return out;
}

// ── Reading an app, cached briefly ──────────────────────────────────────

// Each entry remembers how long its requests were given: a failed or partial
// view read with a short timeout (the Fleet's) mustn't stand in for a caller
// willing to wait longer, or a cold endpoint would hide the app's actions.
const cache = new Map<string, { at: number; view: ProtocolView; timeoutMs: number }>();
const incomplete = (view: ProtocolView) => Boolean(view.error || view.problems?.length);
export const clearProtocolCache = (app?: App) => (app ? cache.delete(app.id) : cache.clear());

export async function protocolView(app: App, { maxAgeMs = CACHE_MS, timeoutMs = PROTOCOL_TIMEOUT_MS }: { maxAgeMs?: number; timeoutMs?: number } = {}): Promise<ProtocolView> {
  const ref = app.protocol?.secretRef ?? protocolSecretRef(app.slug);
  const secretState = readSecret(ref) ? "set" : "missing";
  if (!app.protocol) return { configured: false, secretRef: ref, secretState };

  const hit = cache.get(app.id);
  if (hit && Date.now() - hit.at < maxAgeMs && (hit.timeoutMs >= timeoutMs || !incomplete(hit.view))) return hit.view;

  const { endpoint } = app.protocol;
  const base: ProtocolView = { configured: true, endpoint, secretRef: ref, secretState, checkedAt: new Date().toISOString() };
  const secret = readSecret(ref);
  let view: ProtocolView;
  if (!secret) {
    view = { ...base, error: `Add ${ref}=… to ${envFile()} (generate a new secret if it was lost)` };
  } else {
    try {
      const manifest = cleanManifest(await request(endpoint, secret, "/manifest", { timeoutMs }));
      const problems: string[] = [];
      const guard = async <T>(cap: string, work: () => Promise<T>): Promise<T | undefined> => {
        try {
          return await work();
        } catch (err) {
          problems.push(`${cap}: ${(err as Error).message}`);
          return undefined;
        }
      };
      const extraCaps = manifest.capabilities.filter((c) => /^x-[\w-]{1,38}$/.test(c));
      const [metrics, actions, extras] = await Promise.all([
        manifest.capabilities.includes("metrics") ? guard("metrics", async () => cleanMetrics(await request(endpoint, secret, "/metrics", { timeoutMs }))) : undefined,
        manifest.capabilities.includes("actions") ? guard("actions", async () => cleanActions(await request(endpoint, secret, "/actions", { timeoutMs }))) : undefined,
        Promise.all(extraCaps.map((cap) => guard(cap, async () => ({ name: cap, json: JSON.stringify(await request(endpoint, secret, `/${cap}`, { timeoutMs }), null, 2).slice(0, 4000) })))),
      ]);
      view = {
        ...base,
        manifest,
        ...(metrics ? { metrics } : {}),
        ...(actions ? { actions } : {}),
        ...(extras.some(Boolean) ? { extras: extras.filter((e): e is { name: string; json: string } => Boolean(e)) } : {}),
        ...(problems.length ? { problems } : {}),
      };
    } catch (err) {
      view = { ...base, error: (err as Error).message };
    }
  }
  cache.set(app.id, { at: Date.now(), view, timeoutMs });
  return view;
}

// The first few numbers, for the Fleet. Never throws and never waits long.
export async function protocolMetrics(app: App): Promise<AppMetric[] | undefined> {
  if (!app.protocol) return undefined;
  const view = await protocolView(app, { timeoutMs: 6_000 });
  return view.metrics?.items.slice(0, 3);
}

// Checks an endpoint with this app's secret, before it's saved (FR-G4).
export async function testEndpoint(app: App, raw: unknown): Promise<{ endpoint: string; manifest: ProtocolManifest }> {
  const endpoint = validateEndpoint(raw);
  const ref = protocolSecretRef(app.slug);
  const secret = readSecret(ref);
  if (!secret) throw new ProtocolError(`There's no secret for this app yet. Generate one first, so there's a ${ref} in .env.local to test with.`);
  return { endpoint, manifest: cleanManifest(await request(endpoint, secret, "/manifest")) };
}

export async function runProtocolAction(app: App, id: string): Promise<{ ok: boolean; message: string }> {
  if (!app.protocol) throw new ProtocolError("This app has no protocol endpoint");
  const secret = readSecret(app.protocol.secretRef);
  if (!secret) throw new ProtocolError(`Add ${app.protocol.secretRef}=… to .env.local first`);
  const answer = (await request(app.protocol.endpoint, secret, `/actions/${encodeURIComponent(id)}`, { method: "POST", body: {}, timeoutMs: PROTOCOL_ACTION_TIMEOUT_MS })) as { ok?: unknown; message?: unknown };
  return { ok: answer.ok === true, message: str(answer.message, 500) ?? (answer.ok === true ? "Done." : "The app reported a failure without a message.") };
}
