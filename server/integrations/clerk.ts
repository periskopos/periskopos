import { hostnameOf, onDomain } from "../../shared/format.ts";
import type { CheckResult, Resource } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Clerk, the sign-in service: does its Backend API still answer the app's
// key, and how many people use the app? When the key is rotated or revoked,
// the app's server can't check who's signed in while the site itself looks
// fine. One secret key is one Clerk instance (an application's Production
// or Development side), so the account holds exactly one resource. Clerk
// keys can't be limited to reading, so only GET endpoints are used.

const API = "https://api.clerk.com/v1";

type Instance = { id: string; environment_type?: string };
type Domain = { id: string; name: string; is_satellite: boolean; frontend_api_url?: string };
type Count = { total_count: number };

async function ck<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Clerk", ttlMs });
}

// sk_test_ keys belong to a Development instance: its users are test
// accounts, not the app's real ones.
const isDevelopment = (token: string, instance?: Instance) =>
  instance?.environment_type ? instance.environment_type !== "production" : token.startsWith("sk_test_");

// A week ago, to the hour, so the count is asked once an hour rather than on
// every check (the cache key holds the URL).
const weekAgoMs = (now = Date.now()) => Math.floor((now - 7 * 86_400_000) / 3_600_000) * 3_600_000;

const n = (x: number) => x.toLocaleString("en-US");

export function usersSummary(total: number, thisWeek: number): string {
  return `${n(total)} user${total === 1 ? "" : "s"} · ${n(thisWeek)} signed up this week`;
}

// The instance's domains, primary first: the names the app is reached on.
function domainNames(domains: Domain[]): string[] {
  return [...domains].sort((a, b) => Number(a.is_satellite) - Number(b.is_satellite)).map((d) => d.name.toLowerCase());
}

const domainsOf = (r: Resource): string[] => (Array.isArray(r.settings?.domains) ? (r.settings.domains as unknown[]).filter((d): d is string => typeof d === "string") : []);

export const clerk: Integration = {
  ...described("clerk"),

  // The app's Clerk instance is the one serving its domain (example.org,
  // or a satellite domain), the app being on it or under it.
  matchApp(app, resources) {
    const host = hostnameOf(app.url);
    if (!host) return undefined;
    return resources.find((r) => domainsOf(r).some((d) => onDomain(host, d)));
  },
  suggestOnlyMatched: true,
  suggestedSettings(_app, r) {
    return { instance: r.settings?.instance };
  },

  parse({ resource, settings }) {
    const name = requiredText(resource, "Application", 253).toLowerCase();
    if (!/^[a-z0-9_.:-]+$/.test(name)) throw badRequest("Pick the Clerk application from the list");
    const s = (settings ?? {}) as Record<string, unknown>;
    if (typeof s.instance !== "string" || !/^ins_[A-Za-z0-9]{10,40}$/.test(s.instance)) throw badRequest("Pick the Clerk application from the list so its instance is known");
    return { resource: name, settings: { instance: s.instance } };
  },

  async testService(auth) {
    const token = await auth.token();
    const [instance, users] = await Promise.all([ck<Instance>(auth, "/instance", 0), ck<Count>(auth, "/users/count", 0)]);
    const kind = isDevelopment(token, instance) ? "Development instance (test users only)" : "Production instance";
    return { message: `Connected: ${kind}, ${n(users.total_count)} user${users.total_count === 1 ? "" : "s"}` };
  },

  async listResources(auth) {
    const token = await auth.token();
    const [instance, { data }] = await Promise.all([ck<Instance>(auth, "/instance"), ck<{ data: Domain[] }>(auth, "/domains")]);
    const names = domainNames(data);
    const dev = isDevelopment(token, instance);
    return [
      {
        // A Production instance goes by its domain; a Development one by
        // Clerk's own (proper-gecko-12.clerk.accounts.dev), or its id.
        id: names[0] ?? instance.id,
        label: names[0] ?? instance.id,
        detail: [dev ? "Development instance" : "Production instance", names.length > 1 ? `also ${names.slice(1).join(", ")}` : ""].filter(Boolean).join(" · "),
        settings: { instance: instance.id, domains: dev ? [] : names },
      },
    ];
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Clerk account connected" };
    try {
      const token = await auth.token();
      const [instance, total, recent] = await Promise.all([
        ck<Instance>(auth, "/instance", 10 * 60_000),
        ck<Count>(auth, "/users/count"),
        ck<Count>(auth, `/users/count?created_at_after=${weekAgoMs()}`, 10 * 60_000),
      ]);
      // A key pasted over the account's old one may be another application's.
      if (typeof conn.settings?.instance === "string" && instance.id !== conn.settings.instance) {
        return { state: "unknown", at, detail: `The Clerk key on this account is for a different instance than ${conn.resource}: connect it again from the list` };
      }
      const users = usersSummary(total.total_count, recent.total_count);
      return { state: "up", at, summary: isDevelopment(token, instance) ? `Development instance · ${users}` : users };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 401) {
        return {
          state: "down",
          at,
          detail: "Clerk refused the key: this key was rotated or revoked. If the app uses it too, it can't check who's signed in. Paste the new Secret key on the Accounts page.",
          link: { url: "https://dashboard.clerk.com/last-active?path=api-keys", label: "Open API keys in Clerk" },
        };
      }
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: sign-in may not work`, body: reason }
      : { title: `${app}: Clerk answers again`, body: "Its Backend API accepts the key." };
  },
};
