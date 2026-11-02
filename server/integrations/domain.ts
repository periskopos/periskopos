import type { CheckResult } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { requiredText } from "../validate.ts";
import { expiredAgo } from "./ssl.ts";
import { described } from "./types.ts";
import type { Integration } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

// Domain registration expiry (PRD §7.4, FR-I5): looked up through RDAP.
// Some endings (mostly country ones) don't support it; for those I enter
// the date once (settings.expiresOn). A looked-up date always wins.
// Warns at 30 days, checks once a day.

export const DOMAIN_WARN_DAYS = 30;
const DAY_MS = 86_400_000;

// Second-level labels under which a country ending registers names:
// foo.co.uk, foo.com.au… Not a full public-suffix list, which is plenty
// for the domains I run; the connection's host can be edited if it's wrong.
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu", "or", "ne", "go"]);

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1];
  const sld = labels[labels.length - 2];
  return labels.slice(tld.length === 2 && SECOND_LEVEL.has(sld) ? -3 : -2).join(".");
}

export function expiryFromRdap(json: unknown): string | undefined {
  const events = (json as { events?: { eventAction?: string; eventDate?: string }[] })?.events ?? [];
  const date = events.find((e) => e.eventAction === "expiration")?.eventDate;
  return date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : undefined;
}

async function lookUp(domain: string): Promise<{ date?: string; why?: string }> {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json, application/json", "user-agent": APP_USER_AGENT },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });
    // 404 means either "this ending has no lookup service" or "no such
    // registration"; the lookup can't say which.
    if (res.status === 404) return { why: "No registration found (this domain ending may not offer expiry lookups)" };
    if (!res.ok) return { why: `The lookup answered HTTP ${res.status}` };
    const date = expiryFromRdap(await res.json());
    return date ? { date } : { why: "The lookup had no expiry date" };
  } catch (err) {
    return { why: `Couldn't reach the lookup service: ${(err as Error).message}` };
  }
}

export function evaluate(expiresIso: string, source: "looked up" | "entered", now = Date.now()): CheckResult {
  const at = new Date(now).toISOString();
  const left = Date.parse(expiresIso) - now;
  // Shown as dd/mm/yyyy (the UTC date, as the registry gives it).
  const date = expiresIso.slice(0, 10).split("-").reverse().join("/");
  if (left <= 0) return { state: "down", at, detail: `Domain expired ${expiredAgo(-left)} (${date})`, summary: "Expired" };
  // Whole days left, rounded up, so the warning means "30 or fewer days left".
  const days = Math.ceil(left / DAY_MS);
  if (days <= DOMAIN_WARN_DAYS) {
    return { state: "down", at, detail: `Domain expires in ${days} day${days === 1 ? "" : "s"} (${date})`, summary: `Expires in ${days} d` };
  }
  return { state: "up", at, summary: `Registered until ${date} · ${days} days left${source === "entered" ? " · date entered by hand" : ""}` };
}

export const domain: Integration = {
  ...described("domain"),
  confirmFailures: 1, // checked daily (shared/catalog.ts)

  parse({ resource, settings }) {
    const raw = requiredText(resource, "Domain", 260).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(raw)) throw badRequest("Domain must look like example.com");
    const s = (settings ?? {}) as Record<string, unknown>;
    if (s.expiresOn === undefined || s.expiresOn === "" || s.expiresOn === null) return { resource: raw };
    const entered = String(s.expiresOn);
    // Date.parse quietly rolls 2026-02-30 over to March 2: the date has to
    // come back out the same as it went in.
    const parsed = Date.parse(`${entered}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entered) || Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== entered) {
      throw badRequest("Enter the expiry date as YYYY-MM-DD");
    }
    return { resource: raw, settings: { expiresOn: entered } };
  },

  async check(conn): Promise<CheckResult> {
    const at = new Date().toISOString();
    const looked = await lookUp(registrableDomain(conn.resource));
    if (looked.date) return evaluate(looked.date, "looked up");
    const entered = typeof conn.settings?.expiresOn === "string" ? conn.settings.expiresOn : undefined;
    if (entered) return evaluate(new Date(`${entered}T00:00:00Z`).toISOString(), "entered");
    return { state: "unknown", at, detail: `${looked.why}. Enter the expiry date in this app's Settings.`, summary: "Expiry unknown" };
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: domain registration`, body: reason }
      : { title: `${app}: domain is fine again`, body: "The registration was renewed." };
  },
};
