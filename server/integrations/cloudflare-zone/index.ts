import type { Connection, TrafficDetails } from "../../../shared/types.ts";
import { badRequest } from "../../errors.ts";
import { postJson } from "../../http.ts";
import { requiredText } from "../../validate.ts";
import { hostnameOf, onDomain } from "../../../shared/format.ts";
import { described } from "../types.ts";
import type { Integration, ServiceAuth } from "../types.ts";
import { API, HEX32, PERMISSION, cf, dashboardOf, refused, zoneIdOf } from "./api.ts";
import type { CfEnvelope, CfZone } from "./api.ts";
import { auditZone } from "./audit.ts";
import { checkZone } from "./health.ts";
import { daily, hourly, shapeTraffic } from "./traffic.ts";
import { visitors } from "./visitors.ts";

// A domain on Cloudflare (a "zone"): is Cloudflare serving it properly, how
// much traffic it gets, how much of it fails, and who visits. Uses the same
// Cloudflare account (service) as Pages; the token needs Zone → Zone → Read
// and Zone → Analytics → Read. DNS and certificate reads are optional: when
// the token lacks them the check says which permission to add, and never
// turns the app red over it.
//
// api.ts reads Cloudflare; traffic.ts and visitors.ts are the Traffic
// panel; health.ts is the status check; audit.ts runs the configuration
// checks in https.ts, injected-scripts.ts (against page.ts's reading of the
// site's policy), www-email.ts and insights.ts.

export { clearZoneCache } from "./api.ts";
export { SPIKE_MIN_REQUESTS, SPIKE_RATE, compact, daily, errorSpike, hourly, shapeTraffic, toPoint, totalsOf } from "./traffic.ts";
export { visitors } from "./visitors.ts";
export { covers } from "./health.ts";
export { cspAllows, pagePolicies } from "./page.ts";
export { cleanText, dashboardLink, insightFindings, insightSeverity } from "./insights.ts";
export type { CfInsight } from "./insights.ts";
export { auditZone } from "./audit.ts";

// The app page's Traffic panel: the zone, its traffic, its visitors.
export async function zoneDetails(conn: Connection, auth: ServiceAuth): Promise<TrafficDetails> {
  const dashboardUrl = dashboardOf(conn);
  const [zone, traffic, visitorsView] = await Promise.all([
    cf<CfZone>(auth, `/zones/${zoneIdOf(conn)}`),
    Promise.all([hourly(conn, auth), daily(conn, auth)]).then(
      ([h, d]) => ({ traffic: shapeTraffic(h, d) }),
      (err: unknown) => ({
        trafficError: refused(err) ? `Traffic can't be read with this token. ${PERMISSION.analytics}.` : (err as Error).message,
      }),
    ),
    visitors(conn, auth),
  ]);
  return {
    shape: "traffic",
    zone: zone.name,
    status: zone.status,
    paused: zone.paused,
    developmentMode: (zone.development_mode ?? 0) > 0,
    ...(dashboardUrl ? { dashboardUrl } : {}),
    ...traffic,
    visitors: visitorsView,
  };
}

export const cloudflareZone: Integration = {
  ...described("cloudflare-zone"),

  statusParts: () => [
    "CDN/Cache",
    "CDN Cache Purge",
    "Authoritative DNS",
    "DNS Updates",
    "SSL Certificate Provisioning",
    "Analytics",
    "Web Analytics",
    "Zones",
    "Firewall",
    "Rules",
  ],

  // The app's domain is the one its address is on, whatever it's called.
  // Several can contain it (a zone and a sub-zone): the longest is the
  // app's own. A domain the account doesn't hold isn't offered at all.
  matchApp(app, resources) {
    const host = hostnameOf(app.url);
    return host ? resources.filter((r) => onDomain(host, r.id.toLowerCase())).sort((a, b) => b.id.length - a.id.length)[0] : undefined;
  },
  suggestOnlyMatched: true,
  // Its DNS record and certificate are checked for the app's own name.
  suggestedSettings: (app, r) => ({ ...r.settings, host: hostnameOf(app.url) }),

  // The app page's Traffic panel (cached inside, so the page's refresh
  // doesn't hammer Cloudflare).
  details: zoneDetails,

  parse({ resource, settings }) {
    const zone = requiredText(resource, "Domain", 253).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(zone)) throw badRequest("A Cloudflare domain looks like example.com");
    const s = (settings ?? {}) as Record<string, unknown>;
    if (typeof s.zoneId !== "string" || !HEX32.test(s.zoneId) || typeof s.accountId !== "string" || !HEX32.test(s.accountId)) {
      throw badRequest("Pick the domain from the list so its Cloudflare zone is known");
    }
    // The app's own hostname, when it's on this domain: that's the name DNS
    // and the certificate are checked for. Otherwise the domain itself.
    const host = typeof s.host === "string" && onDomain(s.host.toLowerCase(), zone) ? s.host.toLowerCase() : zone;
    return {
      resource: zone,
      settings: { zoneId: s.zoneId, accountId: s.accountId, host },
    };
  },

  async listResources(auth) {
    const zones = await cf<CfZone[]>(auth, "/zones?per_page=50");
    if (zones.length === 0) {
      throw new Error(
        "This token can't see any domains. In Cloudflare → My Profile → API Tokens, edit it: add Zone → Zone → Read and Zone → Analytics → Read, with Zone Resources set to All zones (or your domains).",
      );
    }
    return zones.map((z) => ({
      id: z.name,
      label: z.name,
      detail: [z.account?.name, z.plan?.name, z.paused ? "paused" : z.status !== "active" ? z.status : undefined].filter(Boolean).join(" · "),
      settings: { zoneId: z.id, accountId: z.account?.id ?? "" },
    }));
  },

  // Is Cloudflare serving the domain (active, not paused), does the app's
  // name resolve, is the edge certificate fine, and are requests failing?
  async check(conn, auth) {
    const at = new Date().toISOString();
    if (!auth)
      return {
        state: "unknown",
        at,
        detail: "No Cloudflare service connected",
      };
    return checkZone(conn, auth, at);
  },

  async audit(conn, auth) {
    if (!auth) return { findings: [], notes: ["No Cloudflare service connected"] };
    return auditZone(conn, auth);
  },

  actions: () => [
    {
      id: "purge-cache",
      label: "Purge cache",
      description:
        "Empties Cloudflare's cache for the whole domain, so the next visits fetch fresh copies from your app. Nothing is deleted from the app itself; pages may load a little slower until the cache fills again.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "purge-cache") throw new Error(`Cloudflare has no action "${actionId}" for a domain`);
    const res = await postJson<CfEnvelope<{ id?: string } | null>>(
      `${API}/zones/${zoneIdOf(conn)}/purge_cache`,
      { purge_everything: true },
      { token: await auth.token(), provider: "Cloudflare" },
    );
    if (res.success === false) throw new Error(`Cloudflare: ${res.errors?.[0]?.message ?? "the purge was refused"}`);
    return {
      ok: true,
      message: `Cache purged for ${conn.resource}. The next visits fetch fresh copies from your app.`,
    };
  },

  notice(event, app, reason) {
    if (event === "up")
      return {
        title: `${app}: the domain is fine again`,
        body: "Cloudflare is serving it and errors are back to normal.",
      };
    return /failed \(5xx\)/.test(reason)
      ? { title: `${app}: requests are failing`, body: reason }
      : { title: `${app}: the domain needs attention`, body: reason };
  },
};
