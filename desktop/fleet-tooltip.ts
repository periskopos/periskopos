import { summarize } from "../shared/fleet.ts";
import type { App, AppStatus } from "../shared/types.ts";
import type { GlanceApp } from "./tray-glance.ts";
import { fetchOnce } from "./wait-http.ts";

// What the tray icon says when you hover it: the same headline as the
// Fleet's top bar.
export function tooltipFor(statuses: AppStatus[]): string {
  return `Periskopos: ${summarize(statuses).text}`;
}

// How many apps need me: the number on a Mac's dock icon.
export const attentionCount = (statuses: AppStatus[]): number =>
  statuses.filter((s) => s.state === "down" || s.state === "attention").length;

// The dock badge for that count: empty clears it, and a huge one stays legible.
export const badgeText = (count: number): string => (count <= 0 ? "" : count > 99 ? "99+" : String(count));

// The route inside the window for a link a notification carries
// (http://localhost:4100/#/apps/star-map → "#/apps/star-map"), or undefined
// for anything that isn't this Periskopos.
export function routeFromNoticeUrl(url: string | undefined, port: number): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "http:" || !local || Number(u.port || 80) !== port) return undefined;
    return u.hash.startsWith("#/") ? u.hash : "#/";
  } catch {
    return undefined;
  }
}

// Reads one of the page's own lists with the app's session key. Failure is
// silent (undefined): the tray just keeps what it said.
async function fetchList<T>(origin: string, token: string, route: string, field: string): Promise<T[] | undefined> {
  try {
    const { status, body } = await fetchOnce(`${origin}${route}`, { "x-periskopos-token": token }, 20_000);
    if (status !== 200) return undefined;
    const list = (JSON.parse(body) as Record<string, unknown>)[field];
    return Array.isArray(list) ? (list as T[]) : undefined;
  } catch {
    return undefined;
  }
}

// The status the page itself shows.
export const fetchStatuses = (origin: string, token: string): Promise<AppStatus[] | undefined> =>
  fetchList<AppStatus>(origin, token, "/api/status", "statuses");

// The apps' names and slugs, for the tray's glance. Only those two are kept:
// the rest of an app (its connections, its notes) has no business in the shell.
export async function fetchApps(origin: string, token: string): Promise<GlanceApp[] | undefined> {
  const apps = await fetchList<Partial<App>>(origin, token, "/api/apps", "apps");
  return apps
    ?.filter((a): a is Partial<App> & GlanceApp => typeof a.slug === "string" && typeof a.name === "string")
    .map((a) => ({ slug: a.slug, name: a.name }));
}
