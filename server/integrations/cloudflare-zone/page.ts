import { APP_USER_AGENT } from "../../config.ts";

// The site's own pages, fetched the way a visitor would: the start of the
// home page and the Content-Security-Policy it enforces, and whether a
// script Cloudflare adds would get past that policy.

const PAGE_TIMEOUT_MS = 10_000;
const PAGE_BYTES = 64_000;
const USER_AGENT = `${APP_USER_AGENT} (configuration check)`;

export const pageGet = (url: string, redirect: RequestRedirect) =>
  fetch(url, { method: "GET", redirect, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS), headers: { "user-agent": USER_AGENT } });

export async function headOfPage(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (text.length < PAGE_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel().catch(() => {});
  return text;
}

// The policies a page enforces: its headers, and its <meta http-equiv> tags.
// A browser applies every one, so a script must pass them all.
export function pagePolicies(headers: Headers, html: string): { header: string[]; meta: string[] } {
  const header = (headers.get("content-security-policy") ?? "")
    .split(",") // several headers arrive joined by commas, which no policy contains
    .map((p) => p.trim())
    .filter(Boolean);
  const meta: string[] = [];
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["'\s>]/i.test(tag)) continue;
    const content = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    const value = (content?.[2] ?? content?.[3] ?? "").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    if (value.trim()) meta.push(value.trim());
  }
  return { header, meta };
}

// The sources a policy gives <script> elements: script-src-elem, else
// script-src, else default-src. Undefined when it says nothing about scripts.
function scriptSources(policy: string): string[] | undefined {
  const directives = new Map<string, string[]>();
  for (const part of policy.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values.map((v) => v.toLowerCase()));
  }
  return directives.get("script-src-elem") ?? directives.get("script-src") ?? directives.get("default-src");
}

// Would every policy let this script run? An inline script needs
// 'unsafe-inline' with no nonce or hash beside it (they switch it off); a
// script from the site itself needs 'self' (or a scheme or *); one from
// another host needs that host.
export function cspAllows(policies: string[], what: "inline" | "self" | { host: string }): boolean {
  return policies.every((policy) => {
    const src = scriptSources(policy);
    if (!src) return true;
    if (what === "inline") return src.includes("'unsafe-inline'") && !src.some((s) => /^'(nonce-|sha(256|384|512)-|strict-dynamic')/.test(s));
    if (src.includes("*") || src.includes("https:")) return true;
    if (what === "self") return src.includes("'self'");
    const host = what.host.toLowerCase();
    return src.some((s) => {
      const bare = s.replace(/^https:\/\//, "").replace(/\/.*$/, "");
      return bare === host || (bare.startsWith("*.") && host.endsWith(bare.slice(1)));
    });
  });
}
