import { duration } from "../../shared/format.ts";
import type { CheckResult, Connection, ErrorIssue, ErrorsDetails } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Sentry: a project's unresolved errors. The app needs attention (not down)
// when a new error takes off: an unresolved issue first seen in the last
// 24 hours with NEW_MIN_EVENTS events or more. One stray event is noise;
// Sentry's own alerts are there for anything finer. The app's page marks
// which errors are new since its last deploy.

const SENTRY = "https://sentry.io";
export const NEW_MIN_EVENTS = 10;
const DAY_MS = 86_400_000;

type SIssue = {
  id: string;
  shortId: string;
  title: string;
  culprit?: string;
  level?: string;
  count?: string | number;
  userCount?: number;
  firstSeen: string;
  lastSeen: string;
  permalink?: string;
};
type SOrg = { slug: string; name: string; links?: { regionUrl?: string } };

// An organization lives in one region (sentry.io for the US, de.sentry.io
// for the EU); its projects are read there.
const regionOf = (v: unknown) => (typeof v === "string" && /^https:\/\/([a-z]{2}\.)?sentry\.io$/.test(v) ? v : SENTRY);

async function api<T>(auth: ServiceAuth, base: string, path: string, ttlMs?: number): Promise<T> {
  return getJson<T>(`${base}/api/0${path}`, { token: await auth.token(), provider: "Sentry", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const orgAndProject = (conn: Pick<Connection, "resource">) => {
  const [org, project] = conn.resource.split("/");
  return { org: encodeURIComponent(org!), project: encodeURIComponent(project!) };
};

export function toIssue(i: SIssue): ErrorIssue {
  return {
    id: i.id,
    shortId: i.shortId,
    title: i.title,
    ...(i.culprit ? { culprit: i.culprit } : {}),
    level: i.level ?? "error",
    count: Number(i.count ?? 0) || 0,
    users: i.userCount ?? 0,
    firstSeen: i.firstSeen,
    lastSeen: i.lastSeen,
    url: i.permalink && i.permalink.startsWith("https://") ? i.permalink : `${SENTRY}/issues/${encodeURIComponent(i.id)}/`,
  };
}

// The issues worth an alert: new in the last day, and frequent enough.
export const takingOff = (issues: ErrorIssue[], now = Date.now()) => issues.filter((i) => now - Date.parse(i.firstSeen) < DAY_MS && i.count >= NEW_MIN_EVENTS);

async function issues(conn: Connection, auth: ServiceAuth, query: string, ttlMs?: number): Promise<ErrorIssue[]> {
  const { org, project } = orgAndProject(conn);
  const list = await api<SIssue[]>(auth, regionOf(conn.settings?.regionUrl), `/projects/${org}/${project}/issues/?query=${encodeURIComponent(query)}&statsPeriod=24h&sort=freq&limit=25`, ttlMs);
  return list.map(toIssue);
}

export const sentry: Integration = {
  ...described("sentry"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Sentry project", 200);
    if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/i.test(id)) throw badRequest("Pick the project from the list: a Sentry project goes by organization/project");
    const s = (settings ?? {}) as Record<string, unknown>;
    return {
      resource: id,
      settings: {
        ...(typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {}),
        ...(typeof s.regionUrl === "string" && regionOf(s.regionUrl) === s.regionUrl ? { regionUrl: s.regionUrl } : {}),
      },
    };
  },

  async testService(auth) {
    const orgs = await api<SOrg[]>(auth, SENTRY, "/organizations/", 0);
    return { message: `Connected to ${orgs.map((o) => o.name).join(", ") || "Sentry"}` };
  },

  async listResources(auth) {
    const orgs = await api<SOrg[]>(auth, SENTRY, "/organizations/");
    const lists = await Promise.all(
      orgs.map(async (o) => {
        const region = regionOf(o.links?.regionUrl);
        const projects = await api<{ slug: string; name?: string; platform?: string | null }[]>(auth, region, `/organizations/${encodeURIComponent(o.slug)}/projects/`);
        return projects.map((p) => ({
          id: `${o.slug}/${p.slug}`,
          label: p.slug,
          detail: [o.name, p.platform].filter(Boolean).join(" · "),
          settings: { name: p.name ?? p.slug, ...(region !== SENTRY ? { regionUrl: region } : {}) },
        }));
      }),
    );
    const all = lists.flat();
    if (!all.length) throw new Error("This Sentry token sees no projects: it needs Read on Organization and Project.");
    return all;
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Sentry account connected" };
    try {
      const fresh = takingOff(await issues(conn, auth, "is:unresolved firstSeen:-24h"));
      if (fresh.length) {
        const top = fresh[0]!;
        return {
          state: "down",
          at,
          detail: `${fresh.length === 1 ? "A new error" : `${fresh.length} new errors`} in the last 24 h: ${top.title} (${top.count} events${top.users ? `, ${top.users} users` : ""})`,
          link: { url: top.url, label: `Open ${top.shortId} in Sentry` },
        };
      }
      return { state: "up", at, summary: "No new errors taking off" };
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth): Promise<ErrorsDetails> {
    const { org, project } = orgAndProject(conn);
    const list = await issues(conn, auth, "is:unresolved");
    const now = Date.now();
    return {
      shape: "errors",
      project: conn.resource,
      issues: list.slice(0, 10),
      newIn24h: list.filter((i) => now - Date.parse(i.firstSeen) < DAY_MS).length,
      link: { url: `${SENTRY}/organizations/${org}/projects/${project}/`, label: "All in Sentry" },
    };
  },

  notice(event, app, reason, downForMs) {
    if (event === "up") return { title: `${app}: the new errors have calmed down`, body: `No new error is taking off, ${duration(downForMs)} after the first.` };
    return { title: `${app}: a new error is taking off`, body: reason };
  },
};
