import type { App, CheckResult, Connection, Resource } from "../../shared/types.ts";
import { hostnameOf, onDomain } from "../../shared/format.ts";
import { badRequest } from "../errors.ts";
import { ProviderError } from "../http.ts";
import { requiredText, text } from "../validate.ts";
import { accessToken as googleToken, clearGoogleTokens, hashOf, keyFromPaste, readKey as readGoogleKey, send } from "./google-auth.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

// A site's visitors in Google Analytics (GA4): how many people came over 7
// and 28 days, and a warning when that falls sharply (a broken tag, a page
// gone from search, a redirect gone wrong). Reads only: the account is a
// Google Cloud service account (google-auth.ts) asking for the read-only
// Analytics scope, added as a Viewer on each property it watches. The one
// POST is runReport, which is how the Data API is read.

const ADMIN = "https://analyticsadmin.googleapis.com/v1beta";
const DATA = "https://analyticsdata.googleapis.com/v1beta";
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const PRODUCT = "Google Analytics";

// A sharp fall: the last 7 days had at most half the visitors of the 7
// days before, out of at least this many that week before (a site going
// from 6 visitors to 2 is noise, not news). As Search Console's clicks.
export const DROP_SHARE = 0.5;
export const DROP_MIN_VISITORS = 50;

// Visitor numbers settle over hours: the check and the app page share one
// answer for a while. The property list changes rarely.
const REPORT_TTL_MS = 30 * 60_000;
const PROPERTIES_TTL_MS = 5 * 60_000;
// Properties whose web streams are read for their address, at most: each
// is one call, and nobody watches more sites than this from one account.
const MAX_PROPERTIES = 50;

export const readKey = (saved: string) => readGoogleKey(saved, PRODUCT);

const answers = new Map<string, { until: number; value: Promise<unknown> }>();

export function clearAnalyticsCache() {
  clearGoogleTokens();
  answers.clear();
}

// What a 403 means: the API isn't turned on in the key's Cloud project, or
// the property hasn't added the service account.
function refused(message: string | undefined, email: string): string {
  if (message && /has not been used|is disabled|SERVICE_DISABLED/i.test(message)) {
    return `Google Analytics refused access: the Google Analytics Data API and Admin API need turning on in the service account's Google Cloud project (APIs & Services → Library)`;
  }
  return `Google Analytics refused access${message ? ` (${message})` : ""}. In Google Analytics, open Admin → Property access management → Add users, and add ${email} as a Viewer`;
}

// One Analytics API call: GET without a body, POST (a report) with one.
// Answers are kept a while, by key, address and body.
async function api<T>(auth: ServiceAuth, url: string, body: unknown, ttlMs: number): Promise<T> {
  const saved = await auth.token();
  const id = hashOf(`${saved}\n${url}\n${JSON.stringify(body ?? null)}`);
  const hit = answers.get(id);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = (async () => {
    const token = await googleToken(saved, SCOPE, PRODUCT);
    const res = await send(url, {
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
      if (res.status === 403) throw new ProviderError(403, refused(message, readKey(saved).client_email));
      if (res.status === 401) throw new ProviderError(401, "Google rejected the token: choose Test on the Accounts page");
      if (res.status === 404) throw new ProviderError(404, "Google Analytics doesn't know this property: it may have been deleted");
      throw new ProviderError(res.status, `Google Analytics answered HTTP ${res.status}${message ? `: ${message}` : ""}`);
    }
    return (await res.json()) as T;
  })();
  if (answers.size >= 200) answers.clear();
  answers.set(id, { until: Date.now() + ttlMs, value });
  value.catch(() => answers.delete(id));
  return value;
}

// ── Properties ──────────────────────────────────────────────────────────

type PropertySummary = { property: string; displayName?: string; propertyType?: string };
type AccountSummary = { account?: string; displayName?: string; propertySummaries?: PropertySummary[] };
type DataStream = { type?: string; displayName?: string; webStreamData?: { defaultUri?: string; measurementId?: string } };

export type Property = { id: string; name: string; account?: string; sites: string[] };

const idOf = (resourceName: string) => resourceName.replace(/^properties\//, "");

// Every GA4 property the service account can read, page by page.
async function properties(auth: ServiceAuth): Promise<Property[]> {
  const out: Property[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < 10; page++) {
    const r = await api<{ accountSummaries?: AccountSummary[]; nextPageToken?: string }>(
      auth,
      `${ADMIN}/accountSummaries?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`,
      undefined,
      PROPERTIES_TTL_MS,
    );
    for (const a of r.accountSummaries ?? []) {
      for (const p of a.propertySummaries ?? []) {
        // Roll-up and sub-properties are views of other properties' data.
        if (p.propertyType && p.propertyType !== "PROPERTY_TYPE_ORDINARY") continue;
        out.push({ id: idOf(p.property), name: p.displayName ?? idOf(p.property), ...(a.displayName ? { account: a.displayName } : {}), sites: [] });
      }
    }
    if (!r.nextPageToken) break;
    pageToken = r.nextPageToken;
  }
  // Each property's web addresses, from its web data streams: how it's
  // matched to an app. One that can't be read just has none.
  await Promise.all(
    out.slice(0, MAX_PROPERTIES).map(async (p) => {
      const r = await api<{ dataStreams?: DataStream[] }>(auth, `${ADMIN}/properties/${p.id}/dataStreams?pageSize=200`, undefined, PROPERTIES_TTL_MS).catch(() => ({ dataStreams: [] }));
      p.sites = [...new Set((r.dataStreams ?? []).filter((s) => s.type === "WEB_DATA_STREAM").map((s) => siteOf(s.webStreamData?.defaultUri ?? "")).filter(Boolean))];
    }),
  );
  return out;
}

// A stream's default URI is "https://example.org" or, in older streams,
// just "example.org": its host either way, without "www.".
export function siteOf(uri: string): string {
  const host = hostnameOf(/^[a-z]+:\/\//i.test(uri) ? uri : `https://${uri}`);
  return host.replace(/^www\./, "");
}

const dashboardOf = (id: string) => `https://analytics.google.com/analytics/web/#/p${id}/reports/intelligenthome`;

// ── Visitors ────────────────────────────────────────────────────────────

export type Visitors = { visitors: number; sessions: number };
export type TrafficDrop = { visitors: number; before: number; dropPct: number };
type Report = { rows?: { dimensionValues?: { value?: string }[]; metricValues?: { value?: string }[] }[] };

// Week over week: at least half the visitors gone, from a week with enough
// of them to mean something.
export function trafficDrop(week: Visitors, previousWeek: Visitors): TrafficDrop | undefined {
  if (previousWeek.visitors < DROP_MIN_VISITORS) return undefined;
  if (week.visitors > previousWeek.visitors * (1 - DROP_SHARE)) return undefined;
  return { visitors: week.visitors, before: previousWeek.visitors, dropPct: Math.round((1 - week.visitors / previousWeek.visitors) * 100) };
}

// Three ranges in one report, up to yesterday (today is still coming in),
// in the property's own time zone. Active users over a range are counted
// once each, unlike adding up each day's.
const RANGES = [
  { startDate: "7daysAgo", endDate: "yesterday", name: "week" },
  { startDate: "14daysAgo", endDate: "8daysAgo", name: "previousWeek" },
  { startDate: "28daysAgo", endDate: "yesterday", name: "month" },
] as const;

export function rangesOf(report: Report): Record<(typeof RANGES)[number]["name"], Visitors> {
  const out = { week: { visitors: 0, sessions: 0 }, previousWeek: { visitors: 0, sessions: 0 }, month: { visitors: 0, sessions: 0 } };
  // A range with no visitors at all has no row.
  for (const row of report.rows ?? []) {
    const name = row.dimensionValues?.[0]?.value as keyof typeof out | undefined;
    if (!name || !(name in out)) continue;
    out[name] = { visitors: Number(row.metricValues?.[0]?.value ?? 0) || 0, sessions: Number(row.metricValues?.[1]?.value ?? 0) || 0 };
  }
  return out;
}

export async function visitors(conn: Connection, auth: ServiceAuth) {
  const report = await api<Report>(
    auth,
    `${DATA}/properties/${conn.resource}:runReport`,
    { dateRanges: RANGES, metrics: [{ name: "activeUsers" }, { name: "sessions" }] },
    REPORT_TTL_MS,
  );
  return rangesOf(report);
}

const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

export const dropReason = (d: TrafficDrop) =>
  `Visitors fell ${d.dropPct}% week over week: ${plural(d.visitors, "visitor")} in the last 7 days, ${d.before.toLocaleString("en")} the week before`;

// "+12%", "−40%": this week against the one before.
const change = (now: number, before: number) => {
  if (before === 0) return undefined;
  const pct = Math.round((now / before - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}%`;
};

export const googleAnalytics: Integration = {
  ...described("google-analytics"),
  // A week of numbers is already a confirmation: no need for two checks.
  confirmFailures: 1,
  keyFromPaste,

  // A property's id ("properties/123456789" or just the number), and the
  // name it goes by.
  parse({ resource, settings }) {
    const id = idOf(requiredText(resource, "Property", 40).trim());
    if (!/^\d{4,20}$/.test(id)) throw badRequest("A Google Analytics property is its number, like 123456789: pick it from the list");
    const name = text((settings as Record<string, unknown> | undefined)?.name, "Name", { max: 100, optional: true });
    return { resource: id, ...(name ? { settings: { name } } : {}) };
  },

  async testService(auth) {
    const email = readKey(await auth.token()).client_email;
    const list = await properties(auth);
    if (list.length === 0) return { message: `Key works for ${email}, but no Analytics property has added it yet` };
    return { message: `Connected as ${email}: ${list.length} propert${list.length === 1 ? "y" : "ies"} visible` };
  },

  async listResources(auth): Promise<Resource[]> {
    const list = await properties(auth);
    if (list.length === 0) {
      const email = readKey(await auth.token()).client_email;
      throw new Error(`No Google Analytics property has added this service account yet. In Google Analytics, open Admin → Property access management → Add users, and add ${email} as a Viewer.`);
    }
    return list.map((p) => ({
      id: p.id,
      label: p.name,
      detail: [p.sites.join(", ") || undefined, p.account].filter(Boolean).join(" · "),
      settings: { name: p.name, sites: p.sites },
    }));
  },

  // The property whose web stream is the app's address; else the one on
  // the nearest domain around it (example.org for app.example.org).
  matchApp(app: App, resources) {
    const host = siteOf(app.url);
    if (!host) return undefined;
    const sitesOf = (r: Resource) => (Array.isArray(r.settings?.sites) ? (r.settings.sites as string[]) : []);
    const exact = resources.find((r) => sitesOf(r).includes(host));
    if (exact) return exact;
    const around = resources
      .map((r) => ({ r, site: sitesOf(r).filter((s) => onDomain(host, s)).sort((a, b) => b.length - a.length)[0] }))
      .filter((x) => x.site)
      .sort((a, b) => b.site!.length - a.site!.length);
    return around[0]?.r;
  },
  // A site the account can't see isn't something it could add.
  suggestOnlyMatched: true,
  // The addresses are for matching, not for keeping.
  suggestedSettings: (_app, r) => (typeof r.settings?.name === "string" ? { name: r.settings.name } : {}),

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Google Analytics account connected" };
    let v: Awaited<ReturnType<typeof visitors>>;
    try {
      v = await visitors(conn, auth);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
    const link = { url: dashboardOf(conn.resource), label: "Open Google Analytics" };
    if (v.month.visitors === 0) return { state: "up", at, summary: "No visitors in the last 28 days: is the Google tag on the site?", link };
    const drop = trafficDrop(v.week, v.previousWeek);
    if (drop) {
      const reason = dropReason(drop);
      return { state: "down", at, detail: reason, summary: reason, link };
    }
    const vs = change(v.week.visitors, v.previousWeek.visitors);
    return {
      state: "up",
      at,
      summary: [`${plural(v.week.visitors, "visitor")} in 7 days`, `${v.month.visitors.toLocaleString("en")} in 28`, vs ? `${vs} on the week before` : undefined].filter(Boolean).join(" · "),
    };
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: visitors fell sharply`, body: reason }
      : { title: `${app}: visitors are back to usual`, body: "Visitors in Google Analytics are no longer down by half on the week before." };
  },
};
