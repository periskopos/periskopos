import type { App, ConnectionDetails } from "../../../../shared/types.ts";
import { api } from "../../api.ts";

// Each app's requests over the last day, from its Cloudflare domain. Reading one costs
// calls to Cloudflare, so it's kept a while, across visits to the page.

const KEEP_MS = 10 * 60_000;
const read = new Map<string, { requests: number | undefined; at: number }>();

const zoneOf = (app: App) => app.connections.find((c) => c.type === "cloudflare-zone");
const isDue = (app: App) => {
  const known = read.get(app.slug);
  return Boolean(zoneOf(app)) && (!known || Date.now() - known.at >= KEEP_MS);
};

async function readOne(app: App): Promise<void> {
  const zone = zoneOf(app);
  if (!zone) return;
  read.set(app.slug, { requests: read.get(app.slug)?.requests, at: Date.now() }); // one at a time
  try {
    const { details } = await api<{ details: ConnectionDetails }>("GET", `/apps/${encodeURIComponent(app.slug)}/connections/${encodeURIComponent(zone.id)}/details`);
    read.set(app.slug, { requests: details.shape === "traffic" ? details.traffic?.totals.day.requests : undefined, at: Date.now() });
  } catch {
    read.set(app.slug, { requests: undefined, at: Date.now() }); // can't be read: said as "serving" only
  }
}

// Reads whatever's due, and says whether there was anything to read.
export async function refreshRequests(apps: App[]): Promise<boolean> {
  const due = apps.filter(isDue);
  await Promise.all(due.map(readOne));
  return due.length > 0;
}

// Only for an app whose domain is still connected: a figure can't outlive its source.
export function knownRequests(apps: App[]): Map<string, number> {
  const known = new Map<string, number>();
  for (const app of apps) {
    const requests = zoneOf(app) ? read.get(app.slug)?.requests : undefined;
    if (requests !== undefined) known.set(app.slug, requests);
  }
  return known;
}
