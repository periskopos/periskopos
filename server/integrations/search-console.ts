import type { App, CheckResult, Connection, Resource, SearchDay, SearchDetails, SearchDrop, SearchQuery, SearchTotals } from "../../shared/types.ts";
import { hostnameOf, onDomain } from "../../shared/format.ts";
import { badRequest } from "../errors.ts";
import { ProviderError } from "../http.ts";
import { requiredText } from "../validate.ts";
import { accessToken as googleToken, clearGoogleTokens, hashOf, keyFromPaste, readKey as readGoogleKey, send, signedAssertion as googleAssertion } from "./google-auth.ts";
import type { ServiceAccountKey } from "./google-auth.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

// A site in Google Search (Search Console): how often it's shown and
// clicked, its average position and top queries, and a warning when clicks
// fall sharply. Reads only: the account is a Google Cloud service account
// whose JSON key sits in the keys file like any other key; Periskopos
// signs a token request with it (node:crypto, RS256) for the read-only
// Search Console scope, and the user adds the service account's email to
// each property they want watched.

const API = "https://www.googleapis.com/webmasters/v3";
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
const DAY_MS = 86_400_000;

// A sharp fall: the last 7 days of data got at most half the clicks of the
// 7 days before, out of at least this many clicks that week before (a site
// going from 6 clicks to 2 is noise, not news).
export const DROP_SHARE = 0.5;
export const DROP_MIN_CLICKS = 50;

// Final search numbers come 2–3 days late. A day older than this with no
// data had no clicks or impressions at all, rather than not being in yet.
const LAG_DAYS = 4;
// Search numbers change once a day: the app page's refresh, the check and
// the agent all share one answer for a while.
const QUERY_TTL_MS = 30 * 60_000;
const SITES_TTL_MS = 5 * 60_000;

// ── The key: a service account's JSON key file (google-auth.ts) ─────────

export { keyFromPaste };
export const readKey = (saved: string): ServiceAccountKey => readGoogleKey(saved, "Search Console");
export const signedAssertion = (key: ServiceAccountKey, now = Date.now()) => googleAssertion(key, SCOPE, now);

const queries = new Map<string, { until: number; value: Promise<unknown> }>();

export function clearSearchCache() {
  clearGoogleTokens();
  queries.clear();
}

const accessToken = (saved: string) => googleToken(saved, SCOPE, "Search Console");

// One Search Console API call: GET without a body, POST (a query) with one.
// Answers are kept a while, by key, path and query.
async function api<T>(auth: ServiceAuth, path: string, body: unknown, ttlMs: number): Promise<T> {
  const saved = await auth.token();
  const id = hashOf(`${saved}\n${path}\n${JSON.stringify(body ?? null)}`);
  const hit = queries.get(id);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = (async () => {
    const token = await accessToken(saved);
    const res = await send(`${API}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        "user-agent": APP_USER_AGENT,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const message = ((await res.json().catch(() => ({}))) as { error?: { message?: string } }).error?.message;
      if (res.status === 403) {
        throw new ProviderError(403, `Search Console refused access${message ? ` (${message})` : ""}. Add ${readKey(saved).client_email} as a user on this property, and turn on the Google Search Console API in its Google Cloud project`);
      }
      if (res.status === 401) throw new ProviderError(401, "Google rejected the token: choose Test on the Accounts page");
      throw new ProviderError(res.status, `Search Console answered HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return (await res.json()) as T;
  })();
  if (queries.size >= 200) queries.clear();
  queries.set(id, { until: Date.now() + ttlMs, value });
  value.catch(() => queries.delete(id));
  return value;
}

// ── Properties ──────────────────────────────────────────────────────────

type SiteEntry = { siteUrl: string; permissionLevel: string };

// A property is a whole domain ("sc-domain:example.org") or an address
// and everything under it ("https://example.org/").
const DOMAIN_PROPERTY = /^sc-domain:([a-z0-9-]+(\.[a-z0-9-]+)+)$/;

export function siteName(siteUrl: string): string {
  const domain = DOMAIN_PROPERTY.exec(siteUrl);
  if (domain) return domain[1]!;
  return siteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

const PERMISSION: Record<string, string> = {
  siteOwner: "owner",
  siteFullUser: "full access",
  siteRestrictedUser: "restricted access",
};

async function sites(auth: ServiceAuth): Promise<SiteEntry[]> {
  const body = await api<{ siteEntry?: SiteEntry[] }>(auth, "/sites", undefined, SITES_TTL_MS);
  // An unverified entry can't be read: it's a property someone tried to add.
  return (body.siteEntry ?? []).filter((s) => s.permissionLevel !== "siteUnverifiedUser");
}

const dashboardOf = (siteUrl: string) => `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(siteUrl)}`;

// ── Search analytics ────────────────────────────────────────────────────

type Row = { keys?: string[]; clicks: number; impressions: number; ctr?: number; position?: number };

const utcDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const round1 = (n: number) => Math.round(n * 10) / 10;

const query = (auth: ServiceAuth, siteUrl: string, body: Record<string, unknown>) =>
  api<{ rows?: Row[] }>(auth, `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, body, QUERY_TTL_MS).then((r) => r.rows ?? []);

// The 28 days of data up to the newest day there is (or, when the newest
// rows are older than search numbers take to come in, up to that day: the
// days since had nothing). No rows at all: nothing to show yet.
export function shapeDays(rows: Row[], now = Date.now()): { through?: string; days: SearchDay[] } {
  const byDate = new Map(rows.filter((r) => r.keys?.[0]).map((r) => [r.keys![0]!, r]));
  if (byDate.size === 0) return { days: [] };
  const newest = [...byDate.keys()].sort().at(-1)!;
  const settled = utcDate(now - LAG_DAYS * DAY_MS);
  const through = newest > settled ? newest : settled;
  const days = Array.from({ length: 28 }, (_, i) => {
    const date = utcDate(dateMs(through) - (27 - i) * DAY_MS);
    const r = byDate.get(date);
    return r
      ? { date, clicks: r.clicks, impressions: r.impressions, ...(r.impressions > 0 && r.position !== undefined ? { position: round1(r.position) } : {}) }
      : { date, clicks: 0, impressions: 0 };
  });
  return { through, days };
}

export function totalsOf(days: SearchDay[]): SearchTotals {
  const clicks = days.reduce((n, d) => n + d.clicks, 0);
  const impressions = days.reduce((n, d) => n + d.impressions, 0);
  const weighted = days.reduce((n, d) => n + (d.position ?? 0) * d.impressions, 0);
  return {
    clicks,
    impressions,
    ...(impressions > 0 ? { ctrPct: round1((clicks / impressions) * 100), position: round1(weighted / impressions) } : {}),
  };
}

// Week over week: at least half the clicks gone, from a week with enough
// clicks to mean something.
export function searchDrop(week: SearchTotals, previousWeek: SearchTotals): SearchDrop | undefined {
  if (previousWeek.clicks < DROP_MIN_CLICKS) return undefined;
  if (week.clicks > previousWeek.clicks * (1 - DROP_SHARE)) return undefined;
  return { clicks: week.clicks, before: previousWeek.clicks, dropPct: Math.round((1 - week.clicks / previousWeek.clicks) * 100) };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayName = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export const dropReason = (d: SearchDrop, through: string) =>
  `Search clicks fell ${d.dropPct}% week over week: ${plural(d.clicks, "click")} in the 7 days to ${dayName(through)}, ${d.before.toLocaleString("en")} the week before`;

type Daily = { through?: string; days: SearchDay[]; week: SearchTotals; previousWeek: SearchTotals; month: SearchTotals };

async function daily(conn: Connection, auth: ServiceAuth, now = Date.now()): Promise<Daily> {
  // Data from 40 days back covers 28 days and a few days' lag either way.
  const rows = await query(auth, conn.resource, { startDate: utcDate(now - 40 * DAY_MS), endDate: utcDate(now), dimensions: ["date"], rowLimit: 100 });
  const { through, days } = shapeDays(rows, now);
  return { ...(through ? { through } : {}), days, week: totalsOf(days.slice(-7)), previousWeek: totalsOf(days.slice(-14, -7)), month: totalsOf(days) };
}

async function topQueries(conn: Connection, auth: ServiceAuth, through: string, length: number): Promise<SearchQuery[]> {
  const rows = await query(auth, conn.resource, {
    startDate: utcDate(dateMs(through) - (length - 1) * DAY_MS),
    endDate: through,
    dimensions: ["query"],
    rowLimit: 10,
  });
  return rows.map((r) => ({ query: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, position: round1(r.position ?? 0) }));
}

// The app page's Search panel.
export async function searchDetails(conn: Connection, auth: ServiceAuth): Promise<SearchDetails> {
  const d = await daily(conn, auth);
  const [week, month] = d.through ? await Promise.all([topQueries(conn, auth, d.through, 7), topQueries(conn, auth, d.through, 28)]) : [[], []];
  const drop = searchDrop(d.week, d.previousWeek);
  return {
    shape: "search",
    site: siteName(conn.resource),
    ...(d.through ? { through: d.through } : {}),
    days: d.days,
    totals: { week: d.week, previousWeek: d.previousWeek, month: d.month },
    topQueries: { week, month },
    ...(drop ? { drop } : {}),
    dashboardUrl: dashboardOf(conn.resource),
  };
}

// "+12%", "−40%": this week against the one before.
const change = (now: number, before: number) => {
  if (before === 0) return undefined;
  const pct = Math.round((now / before - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
};

export const searchConsole: Integration = {
  ...described("search-console"),
  // A week of numbers is already a confirmation: no need for two checks.
  confirmFailures: 1,
  details: searchDetails,
  keyFromPaste,

  parse({ resource }) {
    const site = requiredText(resource, "Property", 300).trim();
    const domain = DOMAIN_PROPERTY.exec(site.toLowerCase());
    if (domain) return { resource: `sc-domain:${domain[1]}` };
    let url: URL;
    try {
      url = new URL(site);
    } catch {
      throw badRequest("A Search Console property looks like sc-domain:example.com or https://example.com/");
    }
    if (!/^https?:$/.test(url.protocol) || url.search || url.hash || !url.pathname.endsWith("/")) {
      throw badRequest("A Search Console property looks like sc-domain:example.com or https://example.com/");
    }
    return { resource: url.href };
  },

  async testService(auth) {
    const email = readKey(await auth.token()).client_email;
    const list = await sites(auth);
    if (list.length === 0) return { message: `Key works for ${email}, but no property has added it as a user yet` };
    return { message: `Connected as ${email}: ${list.length} propert${list.length === 1 ? "y" : "ies"} visible` };
  },

  async listResources(auth): Promise<Resource[]> {
    const list = await sites(auth);
    if (list.length === 0) {
      const email = readKey(await auth.token()).client_email;
      throw new Error(`No Search Console property has added this service account yet. In Search Console, open the site → Settings → Users and permissions → Add user, and add ${email} (Restricted is enough).`);
    }
    return list.map((s) => ({
      id: s.siteUrl,
      label: siteName(s.siteUrl),
      detail: [s.siteUrl.startsWith("sc-domain:") ? "Domain property" : "URL-prefix property", PERMISSION[s.permissionLevel]].filter(Boolean).join(" · "),
    }));
  },

  // The property covering the app's address: one for exactly its address
  // first, else the narrowest domain property it's on.
  matchApp(app: App, resources) {
    const host = hostnameOf(app.url);
    if (!host) return undefined;
    const prefix = resources.find((r) => !r.id.startsWith("sc-domain:") && hostnameOf(r.id) === host);
    if (prefix) return prefix;
    return resources
      .filter((r) => r.id.startsWith("sc-domain:") && onDomain(host, r.id.slice("sc-domain:".length)))
      .sort((a, b) => b.id.length - a.id.length)[0];
  },
  // A site the account can't see isn't something it could add.
  suggestOnlyMatched: true,

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Google Search Console account connected" };
    let d: Daily;
    try {
      d = await daily(conn, auth);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
    if (!d.through) return { state: "up", at, summary: "No search data yet: Google hasn't shown the site in search results" };
    const drop = searchDrop(d.week, d.previousWeek);
    const link = { url: dashboardOf(conn.resource), label: "Open Search Console" };
    if (drop) {
      const reason = dropReason(drop, d.through);
      return { state: "down", at, detail: reason, summary: reason, link };
    }
    const vs = change(d.week.clicks, d.previousWeek.clicks);
    return {
      state: "up",
      at,
      summary: [
        `${plural(d.week.clicks, "click")} in the 7 days to ${dayName(d.through)}`,
        vs ? `${vs} on the week before` : undefined,
        d.week.position !== undefined ? `avg position ${d.week.position}` : undefined,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: search clicks fell sharply`, body: reason }
      : { title: `${app}: search clicks have recovered`, body: "Clicks from Google Search are no longer down by half on the week before." };
  },
};
