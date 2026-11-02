import { createHash } from "node:crypto";
import { APP_USER_AGENT } from "./config.ts";

// GET JSON from a provider API, cached briefly (FR-I2) so the watcher, the
// Fleet and an app page asking at once make one call. The cache key covers
// the token, so two accounts never share answers.

export class ProviderError extends Error {
  status: number;
  // What the provider answered, for an integration that can say more than
  // the general message (which key a refusal needs). Never shown as is.
  body: string;
  constructor(status: number, message: string, body = "") {
    super(message);
    this.status = status;
    this.body = body.slice(0, 2000);
  }
}

const cache = new Map<string, { until: number; value: Promise<unknown> }>();
const MAX_ENTRIES = 500;

export async function getJson<T>(
  url: string,
  { token, headers = {}, ttlMs = 60_000, provider }: { token: string; headers?: Record<string, string>; ttlMs?: number; provider: string },
): Promise<T> {
  const key = createHash("sha256").update(`${token}\n${url}`).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;

  const value = getJsonFresh<T>(url, { token, headers, provider }).then((r) => r.body);

  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { until: Date.now() + ttlMs, value });
  value.catch(() => cache.delete(key)); // never cache a failure
  return value;
}

// GET JSON with the answer's headers (a key's expiry date travels in one),
// never cached: testing a key asks the provider each time.
export async function getJsonFresh<T>(
  url: string,
  { token, headers = {}, provider }: { token: string; headers?: Record<string, string>; provider: string },
): Promise<{ body: T; headers: Headers }> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "user-agent": APP_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new ProviderError(0, `Can't reach ${provider}: ${(err as Error).message}`);
  }
  if (!res.ok) throw await failure(res, provider);
  return { body: (await res.json()) as T, headers: res.headers };
}

async function failure(res: Response, provider: string): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  return new ProviderError(res.status, describe(provider, res.status, body), body);
}

// GET plain text (a CI job's log), never cached: logs are large and read
// once. A redirect to the file's own address is followed, and fetch drops
// the key on the way to another host. Only the last `maxBytes` are kept.
export async function getText(
  url: string,
  { token, headers = {}, provider, maxBytes = 2_000_000 }: { token: string; headers?: Record<string, string>; provider: string; maxBytes?: number },
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { authorization: `Bearer ${token}`, "user-agent": APP_USER_AGENT, ...headers },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ProviderError(0, `Can't reach ${provider}: ${(err as Error).message}`);
  }
  if (!res.ok) throw await failure(res, provider);
  const text = await res.text();
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

// A read that has to be POSTed (a GraphQL query: Railway), cached like
// getJson. GraphQL answers errors with HTTP 200 and an `errors` list, which
// becomes a ProviderError here, so callers see failures the same way.
export async function queryJson<T>(
  url: string,
  body: unknown,
  { token, ttlMs = 60_000, provider }: { token: string; ttlMs?: number; provider: string },
): Promise<T> {
  const key = createHash("sha256").update(`${token}\n${url}\n${JSON.stringify(body)}`).digest("hex");
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = postJson<{ data?: T; errors?: { message?: string }[] }>(url, body, { token, provider }).then((r) => {
    if (r.errors?.length) throw new ProviderError(200, `${provider}: ${r.errors.map((e) => e.message ?? "error").join("; ")}`);
    if (!r.data) throw new ProviderError(200, `${provider} answered without data`);
    return r.data;
  });
  if (cache.size >= MAX_ENTRIES) cache.clear();
  cache.set(key, { until: Date.now() + ttlMs, value });
  value.catch(() => cache.delete(key));
  return value;
}

// POST JSON (an action). Never cached, never retried.
export async function postJson<T>(
  url: string,
  body: unknown,
  { token, provider }: { token: string; provider: string },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, accept: "application/json", "content-type": "application/json", "user-agent": APP_USER_AGENT },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ProviderError(0, `Can't reach ${provider}: ${(err as Error).message}`);
  }
  if (!res.ok) throw await failure(res, provider);
  return (await res.json().catch(() => ({}))) as T;
}

function describe(provider: string, status: number, body: string): string {
  if (status === 401) return `${provider} rejected the key (401): it may be mistyped, expired or revoked`;
  if (status === 403) return `${provider} refused access (403): the key may lack a permission, or the rate limit was hit`;
  if (status === 404) return `${provider} doesn't know this resource (404), or the key can't see it`;
  let message = "";
  try {
    message = (JSON.parse(body) as { message?: string }).message ?? "";
  } catch {
    // not JSON
  }
  return `${provider} answered HTTP ${status}${message ? `: ${message}` : ""}`;
}

export function clearHttpCache() {
  cache.clear();
}
