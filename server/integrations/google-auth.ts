import { createHash, createPrivateKey, sign } from "node:crypto";
import { ProviderError } from "../http.ts";
import { APP_USER_AGENT } from "../config.ts";

// A Google Cloud service account, as Search Console and Google Analytics
// both use it: its JSON key sits in the keys file like any other key, and
// Periskopos signs a token request with it (node:crypto, RS256) for one
// read-only scope at a time.

export const TOKEN_URL = "https://oauth2.googleapis.com/token";

export type ServiceAccountKey = { client_email: string; private_key: string; private_key_id?: string };

const KEY_PREFIX = "gsa.";
const EMAIL = /^[^@\s]+@[a-z0-9-]+\.iam\.gserviceaccount\.com$/i;

function checkedKey(json: unknown): ServiceAccountKey {
  const k = (json ?? {}) as Record<string, unknown>;
  if (k.type !== "service_account") throw new Error("That isn't a service account key: paste the JSON file from Service accounts → Keys → Create new key");
  if (typeof k.client_email !== "string" || !EMAIL.test(k.client_email)) throw new Error("The key has no service account email (…iam.gserviceaccount.com): check what was copied");
  if (typeof k.private_key !== "string" || !k.private_key.includes("PRIVATE KEY")) throw new Error("The key has no private key: paste the whole JSON file");
  try {
    createPrivateKey(k.private_key);
  } catch {
    throw new Error("The key's private key can't be read: paste the whole JSON file, unchanged");
  }
  return {
    client_email: k.client_email,
    private_key: k.private_key,
    ...(typeof k.private_key_id === "string" ? { private_key_id: k.private_key_id } : {}),
  };
}

// The pasted JSON file, as the one line saved in the keys file: only what
// signing needs (the email, the private key and its id), base64url-encoded
// so it has no spaces, quotes or line breaks.
export function keyFromPaste(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste the key first");
  if (value.length > 20_000) throw new Error("That's too long to be a key file: check what was copied");
  let json: unknown;
  try {
    json = JSON.parse(value.trim());
  } catch {
    throw new Error("Paste the whole JSON key file, from the first { to the last }");
  }
  return KEY_PREFIX + Buffer.from(JSON.stringify({ type: "service_account", ...checkedKey(json) })).toString("base64url");
}

// The saved key, or (written into the keys file by hand) the JSON itself.
// `product` names the account in what's wrong ("the saved Search Console key").
export function readKey(saved: string, product = "Google"): ServiceAccountKey {
  const value = saved.trim();
  try {
    if (value.startsWith(KEY_PREFIX)) return checkedKey(JSON.parse(Buffer.from(value.slice(KEY_PREFIX.length), "base64url").toString("utf8")));
    if (value.startsWith("{")) return checkedKey(JSON.parse(value));
  } catch (err) {
    throw new Error(`The saved ${product} key can't be read (${(err as Error).message}). Choose Change key and paste the JSON key file again`);
  }
  throw new Error(`The saved ${product} key isn't a service account key. Choose Change key and paste the JSON key file`);
}

const b64url = (v: string | Buffer) => Buffer.from(v).toString("base64url");

// The signed request for a token (Google's "JWT bearer" grant) for one
// scope, valid for an hour from `now`.
export function signedAssertion(key: ServiceAccountKey, scope: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }));
  const claims = b64url(JSON.stringify({ iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), key.private_key);
  return `${header}.${claims}.${b64url(signature)}`;
}

export const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

export async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new ProviderError(0, `Can't reach Google: ${(err as Error).message}`);
  }
}

// Access tokens, by key and scope: kept until a few minutes before they
// expire. A key that changes is a different entry, so it's asked for again.
const tokens = new Map<string, { until: number; value: Promise<string> }>();

export function clearGoogleTokens() {
  tokens.clear();
}

async function requestToken(saved: string, scope: string, product: string): Promise<{ token: string; until: number }> {
  const key = readKey(saved, product);
  const res = await send(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": APP_USER_AGENT },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(key, scope) }).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (res.ok && body.access_token) {
    return { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
  }
  if (res.status >= 500) throw new ProviderError(res.status, `Google's sign-in answered HTTP ${res.status}`);
  const why = body.error_description ?? body.error;
  throw new ProviderError(
    res.ok ? 502 : res.status,
    `Google rejected the service account key${why ? ` (${why})` : ""}: it may have been deleted or disabled. Make a new JSON key and choose Change key`,
  );
}

export async function accessToken(saved: string, scope: string, product = "Google"): Promise<string> {
  const id = hashOf(`${scope}\n${saved}`);
  const hit = tokens.get(id);
  if (hit && hit.until > Date.now()) return hit.value;
  const pending = requestToken(saved, scope, product);
  const entry = { until: Date.now() + 60_000, value: pending.then((t) => t.token) };
  if (tokens.size >= 50) tokens.clear();
  tokens.set(id, entry);
  pending.then(
    (t) => void (entry.until = t.until),
    () => tokens.delete(id), // never keep a failure
  );
  return entry.value;
}
