import { hostnameOf, onDomain } from "../../shared/format.ts";
import type { CheckResult } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// SendGrid, the email service: is the domain an app sends from still
// authenticated, and are its emails bouncing or being reported as spam?
// A DNS record that breaks un-authenticates the domain, and mailbox
// providers then send its emails to spam or refuse them while the app
// itself looks fine. Reads only: a restricted key with read access to
// Sender Authentication and Stats is enough, and only GET endpoints are used.

const API = "https://api.sendgrid.com/v3";

type DnsRecord = { valid?: boolean; host?: string; type?: string };
type Domain = {
  id: number;
  domain: string;
  subdomain?: string;
  valid: boolean;
  default?: boolean;
  dns?: Record<string, DnsRecord | undefined>;
};
type Metrics = { requests?: number; delivered?: number; bounces?: number; spam_reports?: number };
type StatsDay = { date: string; stats: { metrics?: Metrics }[] };

// The read access each endpoint needs, in the words of SendGrid's key screen.
const ACCESS: Record<string, string> = { "/whitelabel": "Sender Authentication", "/stats": "Stats" };

async function sg<T>(auth: ServiceAuth, path: string, ttlMs = 60_000): Promise<T> {
  try {
    return await getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "SendGrid", ttlMs });
  } catch (err) {
    // A restricted key without the scope is refused with 403 "access forbidden": say which access to grant.
    if (err instanceof ProviderError && err.status === 403) {
      const access = Object.entries(ACCESS).find(([prefix]) => path.startsWith(prefix))?.[1];
      if (access) {
        throw new ProviderError(403, `This SendGrid key can't read ${access}. Edit it in SendGrid → Settings → API Keys and give it Read Access to ${access}.`, err.body);
      }
    }
    throw err;
  }
}

// The last 7 days, today included; SendGrid takes dates as YYYY-MM-DD (UTC).
const weekAgo = (now = Date.now()) => new Date(now - 6 * 86_400_000).toISOString().slice(0, 10);

export type SendingRates = { requests: number; delivered: number; bounces: number; spamReports: number };

export function sumStats(days: StatsDay[]): SendingRates {
  const total: SendingRates = { requests: 0, delivered: 0, bounces: 0, spamReports: 0 };
  for (const day of days) {
    for (const { metrics: m } of day.stats ?? []) {
      total.requests += m?.requests ?? 0;
      total.delivered += m?.delivered ?? 0;
      total.bounces += m?.bounces ?? 0;
      total.spamReports += m?.spam_reports ?? 0;
    }
  }
  return total;
}

// When the numbers mean emails are being lost. Bounces over 5% of what was
// sent is where SendGrid and the mailbox providers start treating a sender
// as one with a bad list (healthy lists stay under 2%). Spam reports are
// judged against what was delivered, as Gmail and Yahoo do: they ask senders
// to stay under 0.1% and start filtering or refusing mail at 0.3%, so 0.3%
// is the line where emails are actually at risk (0.1% would alarm on a
// sender that's merely above the recommendation). Under 100 emails in the
// week, one bounce or one report swings the rate too far to judge.
export const MAX_BOUNCE_RATE = 0.05;
export const MAX_SPAM_RATE = 0.003;
export const MIN_VOLUME = 100;

const pct = (n: number) => `${(n * 100).toFixed(n !== 0 && n < 0.01 ? 2 : 1).replace(/\.?0+$/, "")}%`;

export function judgeRates(r: SendingRates): { state: "up" | "down"; text: string; problems: string[] } {
  if (r.requests === 0) return { state: "up", text: "No emails sent this week", problems: [] };
  const bounceRate = r.bounces / r.requests;
  const spamRate = r.delivered ? r.spamReports / r.delivered : 0;
  const text = `${r.requests.toLocaleString("en-US")} sent this week · ${pct(bounceRate)} bounced · ${pct(spamRate)} spam reports`;
  if (r.requests < MIN_VOLUME) return { state: "up", text, problems: [] };
  const problems: string[] = [];
  if (bounceRate > MAX_BOUNCE_RATE) problems.push(`${pct(bounceRate)} of emails bounced this week (${r.bounces} of ${r.requests}; over ${pct(MAX_BOUNCE_RATE)} hurts delivery)`);
  if (spamRate > MAX_SPAM_RATE) problems.push(`${pct(spamRate)} of delivered emails were reported as spam this week (${r.spamReports} of ${r.delivered}; over ${pct(MAX_SPAM_RATE)}, Gmail and Yahoo filter or refuse them)`);
  return { state: problems.length ? "down" : "up", text, problems };
}

// Which of the domain's DNS records aren't in place ("mail_cname", "dkim1"…).
function brokenRecords(d: Domain): string[] {
  return Object.entries(d.dns ?? {})
    .filter(([, r]) => r && r.valid === false)
    .map(([, r]) => r!.host ?? "")
    .filter(Boolean);
}

export function describeDomain(d: Domain): { state: "up" | "down"; short: string; text: string } {
  if (d.valid) return { state: "up", short: "Authenticated", text: "Authenticated" };
  const broken = brokenRecords(d);
  return {
    state: "down",
    short: "Not authenticated",
    text: `Not authenticated${broken.length ? ` (DNS records not found: ${broken.join(", ")})` : ""}: its emails may land in spam or be refused`,
  };
}

export const sendgrid: Integration = {
  ...described("sendgrid"),

  // The app's sending domain is the one its address is on (em.example.org
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
    const id = typeof s.id === "number" ? s.id : typeof s.id === "string" && /^\d{1,15}$/.test(s.id) ? Number(s.id) : undefined;
    if (!id || !Number.isSafeInteger(id)) throw badRequest("Pick the domain from the list so its SendGrid id is known");
    return { resource: name, settings: { id } };
  },

  async testService(auth) {
    const domains = await sg<Domain[]>(auth, "/whitelabel/domains", 0);
    // Stats are half of what it watches: a key without them is said now, not at the first check.
    await sg<StatsDay[]>(auth, `/stats?start_date=${weekAgo()}`, 0);
    const valid = domains.filter((d) => d.valid).length;
    return { message: `Connected: ${domains.length} authenticated domain${domains.length === 1 ? "" : "s"}, ${valid} valid` };
  },

  async listResources(auth) {
    const domains = await sg<Domain[]>(auth, "/whitelabel/domains");
    if (domains.length === 0) throw new Error("This SendGrid account has no authenticated domains yet. Add the domain your app sends from in SendGrid → Settings → Sender Authentication.");
    // A domain can be authenticated more than once (for subusers): one entry each, the valid one first.
    const byName = new Map<string, Domain>();
    for (const d of [...domains].sort((a, b) => Number(b.valid) - Number(a.valid))) {
      const name = d.domain.toLowerCase();
      if (!byName.has(name)) byName.set(name, d);
    }
    return [...byName.entries()].map(([name, d]) => ({
      id: name,
      label: name,
      detail: [describeDomain(d).short, d.default ? "default" : ""].filter(Boolean).join(" · "),
      settings: { id: d.id },
    }));
  },

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No SendGrid account connected" };
    const link = { url: "https://app.sendgrid.com/settings/sender_auth", label: "Open Sender Authentication in SendGrid" };
    let domain: ReturnType<typeof describeDomain>;
    try {
      const d = await sg<Domain>(auth, `/whitelabel/domains/${encodeURIComponent(String(conn.settings?.id ?? ""))}`);
      domain = describeDomain(d);
    } catch (err) {
      if (err instanceof ProviderError && err.status === 404) {
        return { state: "down", at, detail: `${conn.resource} isn't authenticated in this SendGrid account any more: its emails may land in spam or be refused`, link };
      }
      return { state: "unknown", at, detail: (err as Error).message };
    }

    // The stats are the account's, not the domain's: SendGrid counts them for all its sending.
    let rates: ReturnType<typeof judgeRates> | undefined;
    let statsProblem = "";
    try {
      rates = judgeRates(sumStats(await sg<StatsDay[]>(auth, `/stats?start_date=${weekAgo()}`, 10 * 60_000)));
    } catch (err) {
      statsProblem = (err as Error).message;
    }

    const problems = [...(domain.state === "down" ? [`${conn.resource}: ${domain.text}`] : []), ...(rates?.problems ?? [])];
    const summary = [domain.short, rates?.text].filter(Boolean).join(" · ");
    if (problems.length) {
      return {
        state: "down",
        at,
        detail: problems.join("; "),
        summary,
        link: domain.state === "down" ? link : { url: "https://app.sendgrid.com/statistics", label: "Open Stats in SendGrid" },
      };
    }
    // The domain is fine; stats that can't be read are said, without alarm.
    return { state: "up", at, summary: statsProblem ? `${summary} · stats unavailable: ${statsProblem}` : summary };
  },

  notice(event, app, reason) {
    return event === "down"
      ? { title: `${app}: emails may not arrive`, body: reason }
      : { title: `${app}: email sending is fine again`, body: "Its domain is authenticated in SendGrid and its bounce and spam rates are normal." };
  },
};
