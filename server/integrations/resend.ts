import { hostnameOf, onDomain } from "../../shared/format.ts";
import type { CheckResult } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Resend, the email service: is the domain an app sends from still
// verified? A DNS record that breaks or changes (a host move, a cleanup)
// un-verifies it, and its emails stop arriving while the app itself looks
// fine. Reads only: a Resend key that can read domains can also send, so
// only GET endpoints are used.

const API = "https://api.resend.com";

type Domain = { id: string; name: string; status: string; region?: string };

async function rs<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  try {
    return await getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "Resend", ttlMs });
  } catch (err) {
    // A Sending access key is refused here: say which key it needs.
    if (err instanceof ProviderError && (err.status === 401 || err.status === 403) && /restricted/i.test(err.body)) {
      throw new ProviderError(err.status, "This Resend key can only send emails. Create one with Full access (Resend → API Keys) and paste it on the Accounts page.");
    }
    throw err;
  }
}

// What a domain's status means for the app's emails.
export function describeDomain(status: string): { state: "up" | "down" | "unknown"; text: string } {
  switch (status) {
    case "verified":
      return { state: "up", text: "Verified" };
    case "not_started":
    case "pending":
      return { state: "unknown", text: "Waiting for its DNS records to be checked" };
    case "partially_verified":
    case "partially_failed":
      return { state: "down", text: "Some of its DNS records aren't verified: some emails may not arrive" };
    case "failed":
      return { state: "down", text: "Its DNS records failed verification: emails from it won't be delivered" };
    case "temporary_failure":
      return { state: "down", text: "Resend can't find its DNS records right now: emails from it may not be delivered" };
    default:
      return { state: "unknown", text: `Domain status: ${status.replace(/_/g, " ")}` };
  }
}

export const resend: Integration = {
  ...described("resend"),

  // The app's sending domain is the one its address is on (mail.example.org
  // or example.org for example.org): the longest that contains it.
  matchApp(app, resources) {
    const host = hostnameOf(app.url);
    if (!host) return undefined;
    const on = resources.filter((r) => onDomain(host, r.id) || onDomain(r.id, host));
    return on.sort((a, b) => b.id.length - a.id.length)[0];
  },
  suggestOnlyMatched: true,

  parse({ resource, settings }) {
    const name = requiredText(resource, "Domain", 253).toLowerCase();
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw badRequest("A sending domain looks like example.com or mail.example.com");
    const s = (settings ?? {}) as Record<string, unknown>;
    if (typeof s.id !== "string" || !/^[\w-]{6,64}$/.test(s.id)) throw badRequest("Pick the domain from the list so its Resend id is known");
    return { resource: name, settings: { id: s.id } };
  },

  async testService(auth) {
    const { data } = await rs<{ data: Domain[] }>(auth, "/domains", 0);
    const verified = data.filter((d) => d.status === "verified").length;
    return { message: `Connected: ${data.length} domain${data.length === 1 ? "" : "s"}, ${verified} verified` };
  },

  async listResources(auth) {
    const { data } = await rs<{ data: Domain[] }>(auth, "/domains");
    if (data.length === 0) throw new Error("This Resend account has no domains yet. Add the domain your app sends from in Resend → Domains.");
    return data.map((d) => ({
      id: d.name,
      label: d.name,
      detail: [describeDomain(d.status).text, d.region].filter(Boolean).join(" · "),
      settings: { id: d.id },
    }));
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Resend account connected" };
    try {
      const d = await rs<Domain>(auth, `/domains/${encodeURIComponent(String(conn.settings?.id ?? ""))}`);
      const { state, text } = describeDomain(d.status);
      return {
        state,
        at,
        ...(state === "up" ? {} : { detail: `${conn.resource}: ${text}` }),
        summary: [text, d.region].filter(Boolean).join(" · "),
        ...(state === "up" ? {} : { link: { url: `https://resend.com/domains/${encodeURIComponent(d.id)}`, label: "Open the domain in Resend" } }),
      };
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return { state: "down", at, detail: `${conn.resource} isn't in this Resend account any more: emails from it won't be sent` };
      }
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: emails may not arrive`, body: reason }
      : { title: `${app}: email sending is fine again`, body: "Its domain is verified in Resend." };
  },
};
