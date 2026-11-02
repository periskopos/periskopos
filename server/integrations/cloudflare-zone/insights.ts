import type { FindingDraft } from "../../../shared/types.ts";
import type { ServiceAuth } from "../types.ts";
import { AUDIT_PERMISSION, SETUP_TTL_MS, cf } from "./api.ts";
import type { Found, Read } from "./api.ts";

// Security Insights (Security Center): Cloudflare's own scan of the zone:
// dangling or unproxied DNS records, missing email records, WAF not
// deployed, and so on. Each open insight is a finding. Cloudflare doesn't
// document its issue_class values, so the plain wording below goes by what
// they contain, and anything else keeps Cloudflare's own words, tidied.

export type CfInsight = {
  id: string;
  dismissed?: boolean;
  status?: string; // "active" or "resolved"
  issue_class: string;
  issue_type?: string;
  severity?: string; // "Low", "Moderate", "Critical"
  subject?: string;
  resolve_link?: string;
  resolve_text?: string;
  timestamp?: string;
};
type CfInsightPage = { count?: number; page?: number; per_page?: number; issues?: CfInsight[] } | null;

const INSIGHTS_PER_PAGE = 100;
const INSIGHT_PAGES = 5; // 500 open insights on one domain is plenty

// Cloudflare's Critical is something exploitable as it stands (an exposed
// server, a record pointing at nothing someone could claim): real exposure,
// so high. Moderate is hardening that matters (WAF not deployed, missing
// DMARC): medium. Low is a suggestion: low. Anything unknown sits in the
// middle rather than being dropped or overstated.
export function insightSeverity(s: string | undefined): FindingDraft["severity"] {
  const v = (s ?? "").toLowerCase();
  return v === "critical" ? "high" : v === "low" ? "low" : "medium";
}

// What an insight is about, in words, by what its class says.
type Wording = { match: RegExp; title: (subject: string) => string; why: string };
const WORDING: Wording[] = [
  {
    match: /dangling/,
    title: (s) => `A DNS record for ${s} points at nothing`,
    why: "The record points at a server or service that no longer answers. Someone who claims that address (a deleted cloud bucket, a freed IP) could serve their own content on your domain.",
  },
  {
    match: /unproxied|exposed.?(origin|infra|ip)|origin.?exposed/,
    title: (s) => `${s} exposes your server's address`,
    why: "This DNS record isn't proxied through Cloudflare, so anyone can see your server's IP and reach it directly, around Cloudflare's protection and cache.",
  },
  {
    match: /rdp/,
    title: (s) => `Remote Desktop is exposed on ${s}`,
    why: "A Remote Desktop server reachable from the internet is a common way in for attackers, who try passwords against it all day.",
  },
  {
    match: /dmarc/,
    title: (s) => `${s} has no working DMARC record`,
    why: "Without a valid DMARC record, receiving mail servers can't tell mail really from you from someone sending in your name.",
  },
  {
    match: /spf/,
    title: (s) => `${s} has no working SPF record`,
    why: "Without a valid SPF record, mail servers can't check which servers may send mail for your domain, so spoofed mail gets through and yours may land in spam.",
  },
  {
    match: /dkim/,
    title: (s) => `${s} has no DKIM record`,
    why: "Without DKIM, your mail isn't signed, so receivers can't verify it really came from you.",
  },
  {
    match: /waf|managed.?rules?/,
    title: (s) => `Cloudflare's WAF managed rules aren't on for ${s}`,
    why: "The managed rules block common attacks (SQL injection, known exploits) before they reach your app. Without them, those requests go straight through.",
  },
  {
    match: /mfa|two.?factor|2fa/,
    title: () => "Cloudflare users without two-factor sign-in",
    why: "Someone with a password for one of these Cloudflare accounts could change your DNS or settings. A second factor stops a leaked password from being enough.",
  },
  {
    match: /login|sign.?in/,
    title: (s) => `A sign-in page on ${s} isn't protected`,
    why: "Sign-in pages get password-guessing and bot traffic. Cloudflare can rate-limit or challenge it before it reaches your app.",
  },
];

// Insights that say what this audit already checks from the zone's settings:
// when that setting could be read, the audit's own finding (or its all-clear)
// stands and the insight is dropped. Ours read the setting live; the scan
// may be days old. When the setting couldn't be read, the insight is kept.
const COVERED: { match: RegExp; setting: "ssl" | "alwaysHttps" | "minTls" | "hsts" }[] = [
  { match: /always.?use.?https/, setting: "alwaysHttps" },
  { match: /hsts|strict.?transport/, setting: "hsts" },
  { match: /(old|older|min|minimum|legacy).?tls|tls.?(version|1\.?[01])/, setting: "minTls" },
  { match: /missing.?tls|tls.?encryption|ssl.?mode|flexible|full.?strict|insecure.?ssl/, setting: "ssl" },
];

type InsightContext = { zone: string; account?: string; read: Record<(typeof COVERED)[number]["setting"], boolean> };

const words = (s: string) => s.toLowerCase().replace(/[_-]+/g, " ");
const humanize = (s: string) => {
  const t = s.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
// Cloudflare's resolve text can carry Markdown links, HTML and stray spaces.
export function cleanText(s: string): string {
  const t = s
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return !t || /[.!?]$/.test(t) ? t : `${t}.`;
}

// A resolve link on the dashboard, as a full address: "https://dash…" as
// is, "/<account>/<zone>/dns" and ":account/:zone/…" style paths filled in.
// Anything else (a docs page, another site) isn't a settings page.
export function dashboardLink(link: string | undefined, account: string | undefined, zone: string): string | undefined {
  const raw = link?.trim();
  if (!raw) return undefined;
  if (/^https:\/\/dash\.cloudflare\.com(\/|$)/.test(raw)) return raw;
  if (/^[a-z]+:\/\//i.test(raw) || raw.startsWith("//")) return undefined;
  const path = raw
    .replace(/^\/+/, "")
    .replace(/:account(_id)?|\{account_?id\}|\$\{?account_?id\}?/gi, account ?? "")
    .replace(/:zone(_name)?|\{zone(_name)?\}/gi, zone);
  if (!path || /\/\//.test(path) || path.startsWith("/")) return undefined;
  return `https://dash.cloudflare.com/${path}`;
}

export function insightFindings(issues: CfInsight[], ctx: InsightContext): FindingDraft[] {
  const out = new Map<string, FindingDraft>();
  const center = ctx.account ? { url: `https://dash.cloudflare.com/${ctx.account}/security-center`, label: "Open Security Center on Cloudflare" } : undefined;
  for (const i of issues) {
    if (i.dismissed === true || i.status === "resolved" || !i.issue_class) continue;
    const cls = words(i.issue_class);
    const covered = COVERED.find((c) => c.match.test(cls));
    if (covered && ctx.read[covered.setting]) continue;
    const subject = i.subject?.trim() || ctx.zone;
    const key = `insight:${i.issue_class}:${subject}`;
    if (out.has(key)) continue;
    const w = WORDING.find((x) => x.match.test(cls));
    const url = dashboardLink(i.resolve_link, ctx.account, ctx.zone);
    const steps = i.resolve_text ? cleanText(i.resolve_text) : "";
    out.set(key, {
      key,
      severity: insightSeverity(i.severity),
      title: w ? w.title(subject) : `${humanize(i.issue_class)}: ${subject}`,
      why: w?.why ?? `Cloudflare's Security Insights flagged this${i.issue_type ? ` as ${words(i.issue_type)}` : ""} for ${subject}.`,
      fix: {
        steps: steps || "In the Cloudflare dashboard, open Security Center → Security Insights, find this insight and follow its steps to resolve it.",
        ...(url ? { link: { url, label: "Fix it on Cloudflare" } } : center ? { link: center } : {}),
      },
    });
  }
  return [...out.values()];
}

// Every open insight on the zone, a page at a time.
export async function zoneInsights(auth: ServiceAuth, zoneId: string): Promise<CfInsight[]> {
  const all: CfInsight[] = [];
  for (let page = 1; page <= INSIGHT_PAGES; page++) {
    const res = await cf<CfInsightPage>(auth, `/zones/${zoneId}/security-center/insights?dismissed=false&per_page=${INSIGHTS_PER_PAGE}&page=${page}`, SETUP_TTL_MS);
    const batch = res?.issues ?? [];
    all.push(...batch);
    if (batch.length < INSIGHTS_PER_PAGE || (res?.count !== undefined && all.length >= res.count)) break;
  }
  return all;
}

export function addInsights(insights: Read<CfInsight[]>, ctx: InsightContext, { findings, notes }: Found) {
  if (insights.ok) {
    findings.push(...insightFindings(insights.value, ctx));
  } else if (insights.refused) {
    notes.push(AUDIT_PERMISSION.insights);
  } else {
    notes.push(`Security Insights isn't available for ${ctx.zone} (${insights.message.replace(/^Cloudflare:\s*/, "")})`);
  }
}
