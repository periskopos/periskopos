import { createHash } from "node:crypto";
import type { CheckResult } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

// MongoDB Atlas: is the app's cluster serving, and does Atlas itself have
// an alert open on it (no primary, a host down, a disk filling up)? The
// account is an Atlas service account: its client ID and secret sit in the
// keys file as CLIENT_ID:CLIENT_SECRET, and are traded for an hour-long
// access token (OAuth client credentials). Reads only: the token request is
// the one POST; everything else is GET, and the guide asks for the
// Organization Read Only role.

const BASE = "https://cloud.mongodb.com";
const TOKEN_URL = `${BASE}/api/oauth/token`;
const API = `${BASE}/api/atlas/v2`;
// Atlas versions its API by media type. 2024-08-05 is the current one for
// clusters (it has stateName and paused); groups and alerts have only
// 2023-01-01; Flex clusters have their own.
const V_BASE = "application/vnd.atlas.2023-01-01+json";
const V_CLUSTERS = "application/vnd.atlas.2024-08-05+json";
const V_FLEX = "application/vnd.atlas.2024-11-13+json";

// ── The key: a service account's client ID and secret ───────────────────

const ID = /^[\w.-]{6,128}$/;
const SECRET = /^[\w.-]{10,256}$/;

// The pasted "CLIENT_ID:CLIENT_SECRET" (a space or line break between the
// two works too), checked and saved as one line.
export function keyFromPaste(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste the client ID and secret first");
  const parts = value.trim().split(/\s*:\s*|\s+/);
  if (parts.length !== 2) {
    if (parts.length === 1 && parts[0]!.startsWith("mdb_sa_sk_")) throw new Error("That's only the client secret: paste the client ID, a colon, then the secret");
    throw new Error("Paste the client ID and the client secret on one line, as CLIENT_ID:CLIENT_SECRET");
  }
  const [id, secret] = parts as [string, string];
  if (id.startsWith("mdb_sa_sk_")) throw new Error("The secret comes second: paste CLIENT_ID:CLIENT_SECRET");
  if (!ID.test(id)) throw new Error("The client ID doesn't look right (it's on the service account's page, starting mdb_sa_id_)");
  if (!SECRET.test(secret)) throw new Error("The client secret doesn't look right (Atlas showed it once when the service account was made, starting mdb_sa_sk_)");
  return `${id}:${secret}`;
}

function credentials(saved: string): { id: string; secret: string } {
  const i = saved.indexOf(":");
  if (i < 1) throw new Error("The saved Atlas key isn't CLIENT_ID:CLIENT_SECRET. Choose Change key and paste it again");
  return { id: saved.slice(0, i).trim(), secret: saved.slice(i + 1).trim() };
}

// Access tokens, by key: kept until a few minutes before they expire (the
// token endpoint allows only 10 requests a minute). A changed key is a
// different entry.
const tokens = new Map<string, { until: number; value: Promise<string> }>();

export function clearMongoCache() {
  tokens.clear();
}

const hashOf = (s: string) => createHash("sha256").update(s).digest("hex");

async function requestToken(saved: string): Promise<{ token: string; until: number }> {
  const { id, secret } = credentials(saved);
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
        "user-agent": APP_USER_AGENT,
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new ProviderError(0, `Can't reach MongoDB Atlas: ${(err as Error).message}`);
  }
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (res.ok && body.access_token) {
    return { token: body.access_token, until: Date.now() + Math.max(60, (body.expires_in ?? 3600) - 300) * 1000 };
  }
  if (res.status === 429) throw new ProviderError(429, "MongoDB Atlas is limiting sign-ins for this service account (10 a minute): try again in a minute");
  if (res.status >= 500) throw new ProviderError(res.status, `MongoDB Atlas's sign-in answered HTTP ${res.status}`);
  throw new ProviderError(
    res.ok ? 502 : res.status,
    "MongoDB Atlas rejected the service account's client ID or secret: the secret may have expired or been revoked. Make a new secret for it (Organization → Applications → Service Accounts) and choose Change key",
  );
}

async function accessToken(saved: string): Promise<string> {
  const id = hashOf(saved);
  const hit = tokens.get(id);
  if (hit && hit.until > Date.now()) return hit.value;
  const pending = requestToken(saved);
  const entry = { until: Date.now() + 60_000, value: pending.then((t) => t.token) };
  if (tokens.size >= 50) tokens.clear();
  tokens.set(id, entry);
  pending.then(
    (t) => void (entry.until = t.until),
    () => tokens.delete(id), // never keep a failure
  );
  return entry.value;
}

async function atlas<T>(auth: ServiceAuth, path: string, accept = V_BASE, ttlMs = 60_000): Promise<T> {
  const saved = await auth.token();
  const token = await accessToken(saved); // its own errors say what's wrong with the key
  try {
    return await getJson<T>(`${API}${path}`, { token, headers: { accept }, provider: "MongoDB Atlas", ttlMs });
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    if (err.status === 401) {
      tokens.delete(hashOf(saved)); // revoked or expired early: ask for a new one next time
      throw new ProviderError(401, "MongoDB Atlas didn't accept the access token: choose Test on the Accounts page", err.body);
    }
    if (err.status === 403 && /ACCESS_LIST/i.test(err.body)) {
      throw new ProviderError(403, "MongoDB Atlas only accepts this service account from the addresses on its API access list. Add this computer's IP address to it (Organization → Applications → Service Accounts → the account → Add Access List Entry)", err.body);
    }
    if (err.status === 403) {
      throw new ProviderError(403, "MongoDB Atlas refused access (403): give the service account the Organization Read Only role", err.body);
    }
    throw err;
  }
}

// ── Projects and clusters ───────────────────────────────────────────────

type Group = { id: string; name: string };
export type Cluster = { name: string; groupId: string; stateName?: string; paused?: boolean; mongoDBVersion?: string; clusterType?: string };
export type Alert = {
  id: string;
  eventTypeName: string;
  status: string;
  clusterName?: string;
  hostnameAndPort?: string;
  replicaSetName?: string;
  metricName?: string;
  currentValue?: { number?: number; units?: string };
  severity?: string;
  acknowledgedUntil?: string;
  created: string;
};
type Page<T> = { results?: T[] };

const groups = async (auth: ServiceAuth, ttlMs?: number) => (await atlas<Page<Group>>(auth, "/groups?itemsPerPage=500", V_BASE, ttlMs)).results ?? [];

// Dedicated and free clusters, then Flex clusters (their own endpoint). A
// Flex cluster can show in both while Atlas migrates them: listed once.
async function clustersOf(auth: ServiceAuth, groupId: string, ttlMs?: number): Promise<(Cluster & { flex?: boolean })[]> {
  const g = encodeURIComponent(groupId);
  const [regular, flex] = await Promise.all([
    atlas<Page<Cluster>>(auth, `/groups/${g}/clusters?itemsPerPage=500`, V_CLUSTERS, ttlMs),
    atlas<Page<Cluster>>(auth, `/groups/${g}/flexClusters?itemsPerPage=500`, V_FLEX, ttlMs).catch((err) => {
      if (err instanceof ProviderError && (err.status === 404 || err.status === 400)) return { results: [] };
      throw err;
    }),
  ]);
  const names = new Set((regular.results ?? []).map((c) => c.name));
  return [...(regular.results ?? []), ...(flex.results ?? []).filter((c) => !names.has(c.name)).map((c) => ({ ...c, flex: true }))];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// What a cluster's state means for the app. UPDATING and REPAIRING keep a
// primary (Atlas says so), so they're up with a note; CREATING isn't ready
// yet but nothing is wrong: unknown.
export function describeCluster(c: Pick<Cluster, "stateName" | "paused">): { state: "up" | "down" | "unknown"; text: string } {
  if (c.paused) return { state: "down", text: "Cluster is paused: nothing can connect to it until it's resumed" };
  switch (c.stateName) {
    case "IDLE":
      return { state: "up", text: "Running" };
    case "UPDATING":
      return { state: "up", text: "Running, with a change being applied" };
    case "REPAIRING":
      return { state: "up", text: "Running, with a node being repaired" };
    case "CREATING":
      return { state: "unknown", text: "Cluster is still being created" };
    case "DELETING":
      return { state: "down", text: "Cluster is being deleted" };
    default:
      return { state: "unknown", text: `Cluster state: ${(c.stateName ?? "unknown").toLowerCase()}` };
  }
}

const EVENTS: Record<string, string> = {
  NO_PRIMARY: "No primary: writes are failing",
  HOST_DOWN: "A node is down",
  TOO_FEW_HEALTHY_MEMBERS: "Too few healthy nodes",
  TOO_MANY_UNHEALTHY_MEMBERS: "Too many unhealthy nodes",
  TOO_MANY_ELECTIONS: "Too many primary elections",
  REPLICATION_OPLOG_WINDOW_RUNNING_OUT: "The replication oplog window is running out",
  CLUSTER_MONGOS_IS_MISSING: "A mongos router is missing",
  HOST_NOT_ENOUGH_DISK_SPACE: "A node is running out of disk space",
};

// One alert in plain words: what Atlas says, the metric's value when it's
// a threshold alert, and the node it's on.
export function describeAlert(a: Alert): string {
  let text = EVENTS[a.eventTypeName];
  if (!text && a.metricName) {
    const v = a.currentValue?.number;
    const metric = a.metricName.toLowerCase().replace(/_/g, " ");
    text = `${metric[0]!.toUpperCase()}${metric.slice(1)} is past its alert threshold${v !== undefined ? ` (${Math.round(v * 100) / 100}${a.currentValue?.units ? ` ${a.currentValue.units.toLowerCase()}` : ""})` : ""}`;
  }
  text ??= `${a.eventTypeName.charAt(0)}${a.eventTypeName.slice(1).toLowerCase().replace(/_/g, " ")}`;
  return a.hostnameAndPort ? `${text} on ${a.hostnameAndPort.split(".")[0]}` : text;
}

// The open alerts that are about this cluster: by name, or by a node of it
// (its hosts are named <cluster>-shard-…). An alert someone acknowledged
// is already being handled, until the acknowledgement runs out.
export function alertsFor(alerts: Alert[], clusterName: string, now = Date.now()): Alert[] {
  const host = `${clusterName.toLowerCase()}-`;
  return alerts.filter(
    (a) =>
      a.status === "OPEN" &&
      (a.clusterName === clusterName || (!a.clusterName && !!a.hostnameAndPort?.toLowerCase().startsWith(host))) &&
      !(a.acknowledgedUntil && Date.parse(a.acknowledgedUntil) > now),
  );
}

const clusterUrl = (groupId: string, name: string) => `${BASE}/v2/${encodeURIComponent(groupId)}#/clusters/detail/${encodeURIComponent(name)}`;
const alertsUrl = (groupId: string) => `${BASE}/v2/${encodeURIComponent(groupId)}#/alerts`;

export const mongodb: Integration = {
  ...described("mongodb"),
  keyFromPaste,

  parse({ resource, settings }) {
    const name = requiredText(resource, "Cluster", 200);
    const s = (settings ?? {}) as Record<string, unknown>;
    if (typeof s.groupId !== "string" || !/^[a-f0-9]{24}$/.test(s.groupId)) throw badRequest("Pick the cluster from the list so its Atlas project is known");
    if (typeof s.clusterName !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/.test(s.clusterName)) throw badRequest("An Atlas cluster name looks like Cluster0");
    return {
      resource: name,
      settings: { groupId: s.groupId, clusterName: s.clusterName, ...(s.flex === true ? { flex: true } : {}) },
    };
  },

  async testService(auth) {
    const list = await groups(auth, 0);
    const clusters = (await Promise.all(list.map((g) => clustersOf(auth, g.id, 0)))).flat();
    return { message: `Connected: ${plural(list.length, "project")}, ${plural(clusters.length, "cluster")}` };
  },

  async listResources(auth) {
    const list = await groups(auth);
    const all = await Promise.all(list.map(async (g) => ({ g, clusters: await clustersOf(auth, g.id) })));
    const out = all.flatMap(({ g, clusters }) =>
      clusters.map((c) => ({
        id: `${g.name}/${c.name}`,
        label: c.name,
        detail: [g.name, c.flex ? "Flex" : undefined, describeCluster(c).text.split(":")[0]].filter(Boolean).join(" · "),
        settings: { groupId: g.id, clusterName: c.name, ...(c.flex ? { flex: true } : {}) },
      })),
    );
    if (out.length === 0) {
      throw new Error(list.length ? "This service account sees no clusters. Create one in Atlas, or give it the Organization Read Only role" : "This service account sees no projects: give it the Organization Read Only role");
    }
    return out;
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No MongoDB Atlas account connected" };
    const groupId = String(conn.settings?.groupId ?? "");
    const name = String(conn.settings?.clusterName ?? "");
    const g = encodeURIComponent(groupId);
    const link = { url: clusterUrl(groupId, name), label: "Open the cluster in Atlas" };
    try {
      const path = conn.settings?.flex ? `/groups/${g}/flexClusters/${encodeURIComponent(name)}` : `/groups/${g}/clusters/${encodeURIComponent(name)}`;
      const [cluster, alertPage] = await Promise.all([
        atlas<Cluster>(auth, path, conn.settings?.flex ? V_FLEX : V_CLUSTERS, 30_000),
        atlas<Page<Alert>>(auth, `/groups/${g}/alerts?status=OPEN&itemsPerPage=500`, V_BASE, 30_000),
      ]);
      const { state, text } = describeCluster(cluster);
      const where = [text, cluster.mongoDBVersion ? `MongoDB ${cluster.mongoDBVersion}` : undefined].filter(Boolean).join(" · ");
      if (state !== "up") return { state, at, detail: `${name}: ${text}`, summary: where, link };

      const open = alertsFor(alertPage.results ?? [], name);
      if (open.length) {
        const words = [...new Set(open.map(describeAlert))];
        const detail = `${name}: ${words.join("; ")}`;
        return { state: "down", at, detail, summary: `${plural(open.length, "open alert")} · ${words[0]}`, link: { url: alertsUrl(groupId), label: "Open the alerts in Atlas" } };
      }
      return { state: "up", at, summary: where };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return { state: "down", at, detail: `${name} isn't in this Atlas project any more (deleted, or the service account lost access)` };
      }
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: MongoDB Atlas`, body: reason }
      : { title: `${app}: the Atlas cluster is fine again`, body: "It's running, with no open alerts." };
  },
};
