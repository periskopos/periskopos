import { ACCOUNTS, isHostType } from "../shared/catalog.ts";
import { hostnameOf } from "../shared/format.ts";
import type { App, Resource, Service, Suggestion, SuggestionKind } from "../shared/types.ts";
import { integrations } from "./integrations/index.ts";
import { authFor } from "./keys/secrets.ts";

// "Get more from this app": what my connected accounts could add to an app
// that it doesn't have yet, and, where one thing in the account is plainly
// the app's (its domain, a Worker serving its address, a repo named like
// it), that thing, so it can be connected in one click. Anything less sure
// is offered as a choice, never guessed.

// Names compared loosely: "periskopos.com", "Periskopos-com" and
// "periskopos_com" are one name.
const simple = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// The names an app goes by: its slug, its address (whole, and its first
// label), its name.
function namesOf(app: App): Set<string> {
  const host = hostnameOf(app.url).replace(/^www\./, "");
  return new Set([app.slug, simple(host), simple(host.split(".")[0] ?? ""), simple(app.name)].filter(Boolean));
}

// Everything that looks like this app's: a host serving the app's address,
// or anything named like the app. A kind with its own way of knowing (a
// domain) decides for itself. The likeliest comes first: one serving the
// address, then one named after the whole address (the periskopos.com repo
// for periskopos.com), then the rest (the periskopos repo).
export function likelyMatches(app: App, kind: SuggestionKind, resources: Resource[]): Resource[] {
  const integration = integrations[kind];
  if (integration?.matchApp) {
    const one = integration.matchApp(app, resources);
    return one ? [one] : [];
  }
  const host = hostnameOf(app.url);
  const bare = host.replace(/^www\./, "");
  const names = namesOf(app);
  const nameOf = (r: Resource) => simple(integration?.resourceName?.(r) ?? r.label);
  const serves = (r: Resource) =>
    isHostType(kind) && !!host && (r.detail ?? "").toLowerCase().split(/[\s·,]+/).some((d) => d === host || d === bare);
  const rank = (r: Resource) => (serves(r) ? 0 : nameOf(r) === simple(bare) ? 1 : 2);
  return resources.filter((r) => serves(r) || names.has(nameOf(r))).sort((a, b) => rank(a) - rank(b));
}

// The one resource that is plainly this app's, if there is exactly one.
export function obviousMatch(app: App, kind: SuggestionKind, resources: Resource[]): Resource | undefined {
  const hits = likelyMatches(app, kind, resources);
  return hits.length === 1 ? hits[0] : undefined;
}

type Lister = (service: Service, kind: SuggestionKind) => Promise<Resource[]>;

// Lists what an account holds, for this kind of connection; cached a few
// minutes, since the Overview asks every time it opens.
const LIST_TTL_MS = 5 * 60_000;
const listed = new Map<string, { at: number; resources: Promise<Resource[]> }>();
const listResources: Lister = (service, kind) => {
  const key = `${service.id} ${kind}`;
  const hit = listed.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.resources;
  // Each kind lists its own: a Cloudflare account's Workers and Pages
  // projects for a host, its zones for a domain.
  const list = integrations[kind]?.listResources;
  const resources = list ? list(authFor(service)) : Promise.resolve([]);
  // A failure isn't kept: the next look tries again.
  resources.catch(() => listed.delete(key));
  listed.set(key, { at: Date.now(), resources });
  return resources;
};

export function clearSuggestionCache() {
  listed.clear();
}

export async function suggestionsFor(app: App, services: Service[], list: Lister = listResources): Promise<Suggestion[]> {
  const has = new Set(app.connections.map((c) => c.type));
  // Where an app runs: one host is enough, so a second isn't suggested.
  const hasHost = app.connections.some((c) => isHostType(c.type));
  const wanted = services.flatMap((service) =>
    ACCOUNTS[service.type].offers
      .filter((kind) => !has.has(kind) && !(isHostType(kind) && hasHost))
      .map((kind) => ({ service, kind })),
  );
  const out = await Promise.all(
    wanted.map(async ({ service, kind }): Promise<Suggestion | undefined> => {
      const integration = integrations[kind];
      const onlyMatched = integration?.suggestOnlyMatched === true;
      const base = { serviceId: service.id, serviceName: service.name, serviceType: service.type, kind };
      let resources: Resource[];
      try {
        resources = await list(service, kind);
      } catch {
        // The account can't be read right now: still say what it could add.
        return onlyMatched ? undefined : base;
      }
      const hits = likelyMatches(app, kind, resources);
      if (!hits.length) return !onlyMatched && resources.length ? base : undefined;
      const offer = (r: Resource) => ({ resource: r.id, label: r.label, settings: integration?.suggestedSettings?.(app, r) ?? r.settings ?? {} });
      // Two or more named like the app (periskopos and periskopos.com):
      // offered side by side, the likeliest first, never picked for you.
      return hits.length === 1 ? { ...base, match: offer(hits[0]!) } : { ...base, choices: hits.slice(0, 10).map(offer) };
    }),
  );
  return out.filter((s): s is Suggestion => s !== undefined);
}
