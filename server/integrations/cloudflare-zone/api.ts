import { createHash } from "node:crypto";
import type { Connection, FindingDraft } from "../../../shared/types.ts";
import { ProviderError, getJson, postJson } from "../../http.ts";
import type { ServiceAuth } from "../types.ts";

// Reading a zone from Cloudflare: the REST and GraphQL calls, the shapes they
// answer with, the connection's settings, and the permission each read needs.

export const API = "https://api.cloudflare.com/client/v4";
export const SETUP_TTL_MS = 5 * 60_000; // DNS records, certificates, Web Analytics sites

export const PERMISSION = {
  dns: "Add Zone → DNS → Read to check DNS records",
  ssl: "Add Zone → SSL and Certificates → Read to check the edge certificate",
  analytics: "Add Zone → Analytics → Read to see traffic",
  rum: "Add Account → Account Analytics → Read to see Web Analytics visitors",
};

// The configuration checks' reads: each needs its own permission (Zone
// Settings, DNS, Bot Management, Email Routing Rules, Account Analytics);
// without one the check says which to add.
export const AUDIT_PERMISSION = {
  settings: "Add Zone → Zone Settings → Read to the Cloudflare token to check the SSL/TLS and HTTPS settings",
  dnssec: "Add Zone → DNS → Read to the Cloudflare token to check DNSSEC",
  www: "Add Zone → DNS → Read to the Cloudflare token to check that www works",
  insights: "Add Zone → Zone Security Center Insights → Read to the Cloudflare token to include Cloudflare's Security Insights",
  bots: "Add Zone → Bot Management → Read to the Cloudflare token to check Bot Fight Mode",
  rum: "Add Account → Account Analytics → Read to the Cloudflare token to check Web Analytics' automatic setup",
  email: "Add Zone → Email Routing Rules → Read to the Cloudflare token to check Email Routing",
};

export type CfEnvelope<T> = {
  success?: boolean;
  result: T;
  errors?: { message?: string }[];
};
export type CfZone = {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  development_mode?: number; // seconds left while on, 0 (or negative) when off
  account?: { id: string; name: string };
  plan?: { name?: string };
};
export type CfDnsRecord = {
  name: string;
  type: string;
  content?: string;
  proxied?: boolean;
};
export type CfCertPack = {
  id: string;
  status: string;
  hosts?: string[];
  type?: string;
};
export type CfRumSite = {
  site_tag: string;
  auto_install?: boolean;
  ruleset?: { zone_tag?: string; zone_name?: string; enabled?: boolean };
};
export type CfSetting<V> = { id: string; value: V; editable?: boolean };
export type CfHsts = { strict_transport_security?: { enabled?: boolean; max_age?: number } };
export type CfBots = { fight_mode?: boolean };
export type CfEmailRouting = { enabled?: boolean; status?: string };

export async function cf<T>(auth: ServiceAuth, path: string, ttlMs?: number): Promise<T> {
  const body = await getJson<CfEnvelope<T>>(`${API}${path}`, {
    token: await auth.token(),
    provider: "Cloudflare",
    ...(ttlMs !== undefined ? { ttlMs } : {}),
  });
  if (body.success === false) throw new Error(`Cloudflare: ${body.errors?.[0]?.message ?? "the request failed"}`);
  return body.result;
}

// GraphQL reads go over POST, which the shared HTTP cache doesn't keep, so
// they get their own small cache here (keyed on the token too, like it).
const gqlCache = new Map<string, { until: number; value: Promise<unknown> }>();

export function clearZoneCache() {
  gqlCache.clear();
}

export async function gql<T>(auth: ServiceAuth, query: string, variables: Record<string, unknown>, ttlMs: number): Promise<T> {
  const token = await auth.token();
  const key = createHash("sha256")
    .update(`${token}\n${query}\n${JSON.stringify(variables)}`)
    .digest("hex");
  const hit = gqlCache.get(key);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = (async () => {
    const body = await postJson<{
      data?: T | null;
      errors?: { message?: string }[] | null;
    }>(`${API}/graphql`, { query, variables }, { token, provider: "Cloudflare" });
    const error = body.errors?.[0]?.message;
    if (error || !body.data) {
      if (error && /not authori[sz]ed|permission|access/i.test(error)) throw new ProviderError(403, `Cloudflare refused the analytics (${error})`);
      throw new Error(`Cloudflare analytics: ${error ?? "no data"}`);
    }
    return body.data;
  })();
  if (gqlCache.size >= 200) gqlCache.clear();
  gqlCache.set(key, { until: Date.now() + ttlMs, value });
  value.catch(() => gqlCache.delete(key)); // never keep a failure
  return value;
}

export const refused = (err: unknown) => err instanceof ProviderError && err.status === 403;

export type Read<T> = { ok: true; value: T } | { ok: false; refused: boolean; message: string };
// A refusal or an odd answer is a note; an unreachable Cloudflare (or one
// failing on its side) is a throw, so earlier findings are kept.
export async function readOrNote<T>(read: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 0 || err.status >= 500)) throw err;
    return { ok: false, refused: refused(err), message: (err as Error).message };
  }
}

// What the configuration checks gather, in the order they run.
export type Found = { findings: FindingDraft[]; notes: string[] };

export const HEX32 =/^[a-f0-9]{32}$/i;
export const settingOf = (conn: Connection, key: "zoneId" | "accountId") => {
  const v = conn.settings?.[key];
  return typeof v === "string" && HEX32.test(v) ? v : undefined;
};
export const zoneIdOf = (conn: Connection) => {
  const id = settingOf(conn, "zoneId");
  if (!id) throw new Error("This domain has no Cloudflare zone id; connect it again from the list");
  return id;
};
export const hostOf = (conn: Connection) => (typeof conn.settings?.host === "string" ? conn.settings.host : conn.resource);
export const dashboardOf = (conn: Connection) => {
  const account = settingOf(conn, "accountId");
  return account ? `https://dash.cloudflare.com/${account}/${conn.resource}` : undefined;
};
