import type { DatabaseSync } from "node:sqlite";
import type { App, ProviderIncident, ProviderIndicator, ProviderMaintenance, ProviderPart, ProviderPartState, ProviderStatus, ServiceType } from "../shared/types.ts";
import { ACCOUNTS } from "../shared/catalog.ts";
import { integrations } from "./integrations/index.ts";
import * as store from "./store.ts";
import { APP_USER_AGENT } from "./config.ts";

// Provider status pages (FR-I3): "is it them or me?". Every provider
// publishes a Statuspage-style summary; one fetch per provider however many
// apps use it, for every account I've connected. Each incident names the
// parts of the provider it affects, and only those my apps use count for
// banners and notifications (Cloudflare's WARP isn't my Worker); the
// Accounts page shows everything.

export const PROVIDER_EVERY_MS = 5 * 60_000;

type SummaryComponent = { id?: string; name?: string; group_id?: string | null; status?: string };
type Summary = {
  status?: { indicator?: string; description?: string };
  // Every part the page lists, groups among them: a part's group is how a
  // provider that names parts by region ("Frankfurt" under App Platform,
  // and under Spaces) says which product it is.
  components?: (SummaryComponent & { group?: boolean })[];
  incidents?: {
    name?: string;
    impact?: string;
    shortlink?: string;
    status?: string;
    started_at?: string;
    created_at?: string;
    components?: SummaryComponent[];
    incident_updates?: { body?: string; created_at?: string; display_at?: string }[];
  }[];
  scheduled_maintenances?: { name?: string; status?: string; scheduled_for?: string; scheduled_until?: string; shortlink?: string; components?: SummaryComponent[] }[];
};

// Every part the page lists (not its groups), with its state and group: kept
// whole, since which of them my apps use changes with the apps.
export type Component = { name: string; state: ProviderPartState; group?: string };
export type Fetched = Pick<ProviderStatus, "indicator" | "description" | "incidents" | "maintenance"> & { components?: Component[] };

const PART_STATE: Record<string, ProviderPartState> = {
  operational: "operational",
  degraded_performance: "degraded",
  partial_outage: "partial",
  major_outage: "major",
  under_maintenance: "maintenance",
};

// The parts an incident names, and the group each belongs to: "Frankfurt"
// and "App Platform" both, so a product counts however its page is laid out.
const partsOf = (components: SummaryComponent[] | undefined, groupOf: (c: SummaryComponent) => string | undefined) =>
  [...new Set((components ?? []).flatMap((c) => [c.name, groupOf(c)]).filter((n): n is string => Boolean(n)))];

const INDICATORS = new Set<ProviderIndicator>(["none", "minor", "major", "critical", "maintenance"]);

export function parseSummary(json: Summary): Fetched {
  const raw = json.status?.indicator ?? "";
  const all = json.components ?? [];
  const groupNames = new Map(all.filter((c) => c.group && c.id).map((c) => [c.id!, c.name]));
  const groupIdOf = new Map(all.filter((c) => c.id && c.group_id).map((c) => [c.id!, c.group_id!]));
  const groupOf = (c: SummaryComponent) => {
    const id = c.group_id ?? (c.id ? groupIdOf.get(c.id) : undefined);
    return id ? groupNames.get(id) : undefined;
  };
  return {
    components: all
      .filter((c) => !c.group && c.name)
      .map((c): Component => {
        const group = groupOf(c);
        return { name: c.name!, state: PART_STATE[c.status ?? ""] ?? "unknown", ...(group ? { group } : {}) };
      }),
    indicator: INDICATORS.has(raw as ProviderIndicator) ? (raw as ProviderIndicator) : "unknown",
    description: json.status?.description ?? "No description",
    incidents: (json.incidents ?? []).slice(0, 10).map((i): ProviderIncident => {
      const parts = partsOf(i.components, groupOf);
      const startedAt = i.started_at ?? i.created_at;
      // The newest update first, as the page lists them; a long one is cut.
      const latest = i.incident_updates?.find((u) => u.body?.trim());
      const body = latest?.body?.trim().replace(/\s+/g, " ");
      const at = latest?.display_at ?? latest?.created_at;
      return {
        ...(body ? { update: { body: body.length > 280 ? `${body.slice(0, 279)}…` : body, ...(at ? { at } : {}) } } : {}),
        name: i.name ?? "Incident",
        impact: i.impact ?? "none",
        ...(i.shortlink ? { url: i.shortlink } : {}),
        ...(i.status ? { status: i.status } : {}),
        ...(startedAt ? { startedAt } : {}),
        ...(parts.length ? { parts } : {}),
      };
    }),
    // What's planned or under way, soonest first (a busy provider lists
    // dozens of data-centre windows; the page groups them by day).
    maintenance: (json.scheduled_maintenances ?? [])
      .filter((m) => m.status === "scheduled" || m.status === "in_progress" || m.status === "verifying")
      .sort((a, b) => String(a.scheduled_for ?? "").localeCompare(String(b.scheduled_for ?? "")))
      .slice(0, 25)
      .map((m): ProviderMaintenance => {
        const parts = partsOf(m.components, groupOf);
        return {
          name: m.name ?? "Maintenance",
          status: m.status ?? "scheduled",
          ...(m.scheduled_for ? { scheduledFor: m.scheduled_for } : {}),
          ...(m.scheduled_until ? { scheduledUntil: m.scheduled_until } : {}),
          ...(m.shortlink ? { url: m.shortlink } : {}),
          ...(parts.length ? { parts } : {}),
        };
      }),
  };
}

export async function fetchProvider(type: ServiceType): Promise<Fetched> {
  const { label, status } = ACCOUNTS[type];
  if (!status) throw new Error(`${label} has no status page to read`);
  const res = await fetch(status.summaryUrl, {
    headers: { accept: "application/json", "user-agent": APP_USER_AGENT },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`${label}'s status page answered HTTP ${res.status}`);
  return parseSummary((await res.json()) as Summary);
}

// Degraded means something to tell me about; maintenance is shown, not announced.
export const isDegraded = (i: ProviderIndicator) => i === "minor" || i === "major" || i === "critical";

type Row = { provider: string; checked_at: string; indicator: ProviderIndicator; description: string; incidents: string };

// The incidents column holds the incidents, or (since maintenance and the
// parts are kept too) { incidents, maintenance, components }: older rows
// still read.
export function getStored(db: DatabaseSync, type: ServiceType): (Fetched & { checkedAt: string }) | undefined {
  const row = db.prepare("SELECT * FROM provider_status WHERE provider = ?").get(type) as Row | undefined;
  if (!row) return undefined;
  const saved = JSON.parse(row.incidents) as ProviderIncident[] | { incidents: ProviderIncident[]; maintenance?: ProviderMaintenance[]; components?: Component[] };
  const incidents = Array.isArray(saved) ? saved : saved.incidents;
  const maintenance = Array.isArray(saved) ? undefined : saved.maintenance;
  const components = Array.isArray(saved) ? undefined : saved.components;
  return { indicator: row.indicator, description: row.description, incidents, ...(maintenance ? { maintenance } : {}), ...(components ? { components } : {}), checkedAt: row.checked_at };
}

export function store_(db: DatabaseSync, type: ServiceType, f: Fetched, at: string) {
  db.prepare(
    `INSERT INTO provider_status (provider, checked_at, indicator, description, incidents) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (provider) DO UPDATE SET checked_at = excluded.checked_at, indicator = excluded.indicator,
       description = excluded.description, incidents = excluded.incidents`,
  ).run(type, at, f.indicator, f.description, JSON.stringify({ incidents: f.incidents, maintenance: f.maintenance ?? [], components: f.components ?? [] }));
}

// The parts of a provider that matter, given how my apps use it: the ones
// every app of the account relies on, and each connection's own (a Worker
// isn't Pages). An incident in any other part (Cloudflare's WARP or Zero
// Trust, GitHub Copilot) is shown on the Accounts page but doesn't touch my
// apps. undefined: every part counts (the provider lists nothing finer).
export function partsInUse(type: ServiceType, apps: App[]): Set<string> | undefined {
  const base = ACCOUNTS[type].status?.parts;
  if (!base) return undefined;
  const parts = new Set(base);
  for (const c of apps.flatMap((a) => a.connections)) {
    const integration = integrations[c.type];
    if (integration?.serviceType === type) integration.statusParts?.(c).forEach((p) => parts.add(p));
  }
  return parts;
}

// An incident that names no parts might be anything, so it counts.
export const affects = (parts: string[] | undefined, inUse: Set<string> | undefined) =>
  !inUse || !parts?.length || parts.some((p) => inUse.has(p));

const PART_RANK: Record<ProviderPartState, number> = { operational: 0, unknown: 1, maintenance: 2, degraded: 3, partial: 4, major: 5 };

// The parts my apps use, as the page has them now: one row per name (Render
// lists "Web Services" once per region), its worst state, and where it isn't
// operational. A provider that names no parts finer than itself (inUse
// undefined) shows what it lists, when that's a handful.
export function partsView(components: Component[] | undefined, inUse: Set<string> | undefined): ProviderPart[] {
  if (!components?.length) return [];
  const wanted = inUse ? components.filter((c) => inUse.has(c.name)) : components.length <= 12 ? components : [];
  const byName = new Map<string, Component[]>();
  for (const c of wanted) byName.set(c.name, [...(byName.get(c.name) ?? []), c]);
  return [...byName].map(([name, copies]) => {
    const state = copies.reduce<ProviderPartState>((worst, c) => (PART_RANK[c.state] > PART_RANK[worst] ? c.state : worst), "operational");
    const where = copies.filter((c) => c.state !== "operational" && c.group && copies.length > 1).map((c) => c.group!);
    return { name, state, ...(where.length ? { where } : {}) };
  });
}

const RANK: Record<string, number> = { none: 0, minor: 1, major: 2, critical: 3 };
const BY_RANK: ProviderIndicator[] = ["none", "minor", "major", "critical"];

// The provider's state as far as my apps are concerned: the worst incident
// in a part they use, maintenance under way in such a part, or nothing.
export function relevantIndicator(f: Fetched, inUse: Set<string> | undefined): ProviderIndicator {
  if (f.indicator === "unknown") return "unknown";
  const hits = f.incidents.filter((i) => affects(i.parts, inUse));
  if (hits.length) return BY_RANK[Math.max(1, ...hits.map((i) => RANK[i.impact] ?? 1))] ?? "minor";
  const working = (f.maintenance ?? []).some((m) => m.status !== "scheduled" && affects(m.parts, inUse));
  return working || (f.indicator === "maintenance" && !f.maintenance) ? "maintenance" : "none";
}

// Every provider I have an account with and that has a status page, with
// the apps that depend on it (perhaps none) and those apps themselves, for
// the parts they use.
export function providersInUse(db: DatabaseSync, ownerId: string): { type: ServiceType; apps: { slug: string; name: string }[]; using: App[] }[] {
  const usage = store.serviceUsage(db, ownerId);
  const allApps = store.listApps(db, ownerId);
  const byType = new Map<ServiceType, Map<string, { slug: string; name: string }>>();
  for (const service of store.listServices(db, ownerId)) {
    if (!ACCOUNTS[service.type].status) continue;
    if (!byType.has(service.type)) byType.set(service.type, new Map());
    for (const app of usage.get(service.id) ?? []) byType.get(service.type)!.set(app.slug, app);
  }
  return [...byType].map(([type, apps]) => ({
    type,
    apps: [...apps.values()],
    using: allApps.filter((a) => apps.has(a.slug)),
  }));
}

export function listProviders(db: DatabaseSync, ownerId: string): ProviderStatus[] {
  return providersInUse(db, ownerId).map(({ type, apps, using }) => {
    const stored = getStored(db, type);
    const inUse = partsInUse(type, using);
    const known: Fetched = stored ?? { indicator: "unknown", description: "Not checked yet", incidents: [] };
    return {
      id: type,
      label: ACCOUNTS[type].label,
      pageUrl: ACCOUNTS[type].status!.pageUrl,
      indicator: known.indicator,
      // No app uses it: nothing of its can affect my apps.
      relevantIndicator: apps.length ? relevantIndicator(known, inUse) : known.indicator === "unknown" ? "unknown" : "none",
      description: known.description,
      incidents: known.incidents.map((i) => ({ ...i, affectsYou: apps.length > 0 && affects(i.parts, inUse) })),
      ...(known.maintenance?.length ? { maintenance: known.maintenance } : {}),
      ...(apps.length ? { parts: partsView(known.components, inUse) } : {}),
      ...(stored ? { checkedAt: stored.checkedAt } : {}),
      apps,
    };
  });
}
