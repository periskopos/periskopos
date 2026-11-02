import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { cleanText, cloudflareZone, cspAllows, dashboardLink, insightSeverity, pagePolicies } from "../server/integrations/cloudflare-zone/index.ts";
import type { CfInsight } from "../server/integrations/cloudflare-zone/index.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Cloudflare is faked: nothing here reaches the network, and every call
// must be a GET.

const ACCOUNT = "a".repeat(32);
const ZONE = "b".repeat(32);
const realFetch = globalThis.fetch;
const auth = { service: {}, token: async () => "cf_test" } as unknown as ServiceAuth;
const conn: Connection = { id: "c1", appId: "a1", type: "cloudflare-zone", serviceId: "s1", resource: "example.org", settings: { zoneId: ZONE, accountId: ACCOUNT, host: "example.org" } };
const app = {} as App;
const DASH = `https://dash.cloudflare.com/${ACCOUNT}/example.org`;

type Reply = { status: number; result?: unknown } | "unreachable";
let replies: Record<string, Reply>;
let calls: { method: string; path: string; search: string }[];
// Open insights served page by page (per_page from the request), or a refusal.
let insights: CfInsight[] | Reply;
// Whether the fake honours ?dismissed=false, as Cloudflare does.
let filtersDismissed: boolean;
// The site's own pages, by address: what the checks of Cloudflare's added
// scripts read the Content-Security-Policy from.
type Page = { status: number; headers?: Record<string, string>; body?: string };
let pages: Record<string, Page>;

const setting = (id: string, value: unknown): Reply => ({ status: 200, result: { id, value, editable: true } });
const refused: Reply = { status: 403 };
const P = `/client/v4/zones/${ZONE}`;

function hardened(): Record<string, Reply> {
  return {
    [`${P}/settings/ssl`]: setting("ssl", "strict"),
    [`${P}/settings/always_use_https`]: setting("always_use_https", "on"),
    [`${P}/settings/min_tls_version`]: setting("min_tls_version", "1.2"),
    [`${P}/settings/security_header`]: setting("security_header", { strict_transport_security: { enabled: true, max_age: 15552000, include_subdomains: false, preload: false, nosniff: true } }),
    [`${P}/settings/automatic_https_rewrites`]: setting("automatic_https_rewrites", "on"),
    [`${P}/dnssec`]: { status: 200, result: { status: "active" } },
    [`${P}/settings/rocket_loader`]: setting("rocket_loader", "off"),
    [`${P}/settings/email_obfuscation`]: setting("email_obfuscation", "off"),
    [`${P}/bot_management`]: { status: 200, result: { fight_mode: false } },
    [`/client/v4/accounts/${ACCOUNT}/rum/site_info/list`]: { status: 200, result: [] },
    [`${P}/email/routing`]: { status: 200, result: { enabled: true, status: "ready" } },
    [`${P}/dns_records`]: { status: 200, result: [] },
  };
}

beforeEach(() => {
  clearHttpCache();
  calls = [];
  replies = hardened();
  insights = [];
  filtersDismissed = true;
  pages = {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname, search: url.search });
    if (url.hostname !== "api.cloudflare.com") {
      calls[calls.length - 1].path = url.origin + url.pathname;
      const page = pages[url.origin + url.pathname];
      if (!page) throw new TypeError("fetch failed");
      return new Response(page.body ?? "", { status: page.status, headers: page.headers });
    }
    const insightsPath = url.pathname === `${P}/security-center/insights`;
    if (insightsPath && Array.isArray(insights)) {
      const per = Number(url.searchParams.get("per_page") ?? 25);
      const page = Number(url.searchParams.get("page") ?? 1);
      const open = filtersDismissed && url.searchParams.get("dismissed") === "false" ? insights.filter((i) => !i.dismissed) : insights;
      const result = { count: open.length, page, per_page: per, issues: open.slice((page - 1) * per, page * per) };
      return new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { "content-type": "application/json" } });
    }
    const reply = insightsPath ? (insights as Reply) : replies[url.pathname];
    if (reply === "unreachable") throw new TypeError("fetch failed");
    if (!reply) return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
    if (reply.status !== 200) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }), { status: reply.status });
    return new Response(JSON.stringify({ success: true, result: reply.result, errors: [] }), { headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  assert.ok(calls.every((c) => c.method === "GET"), "only GETs");
});

const run = () => cloudflareZone.audit!(conn, auth, app);
const keys = (r: { findings: { key: string }[] }) => r.findings.map((f) => f.key).sort();

describe("Cloudflare zone configuration checks", () => {
  test("a fully hardened zone has no findings and no notes", async () => {
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, []);
  });

  for (const [mode, severity] of [["flexible", "high"], ["full", "medium"]] as const) {
    test(`SSL/TLS mode ${mode} is ${severity}`, async () => {
      replies[`${P}/settings/ssl`] = setting("ssl", mode);
      const r = await run();
      assert.deepEqual(keys(r), ["ssl-mode"]);
      assert.equal(r.findings[0]!.severity, severity);
      assert.equal(r.findings[0]!.fix.link?.url, `${DASH}/ssl-tls`);
      assert.match(r.findings[0]!.fix.steps, /Full \(strict\)/);
    });
  }

  test("SSL off is high, and the HTTPS settings that depend on it aren't piled on", async () => {
    replies[`${P}/settings/ssl`] = setting("ssl", "off");
    replies[`${P}/settings/always_use_https`] = setting("always_use_https", "off");
    replies[`${P}/settings/automatic_https_rewrites`] = setting("automatic_https_rewrites", "off");
    const r = await run();
    assert.deepEqual(keys(r), ["ssl-mode"]);
    assert.equal(r.findings[0]!.severity, "high");
  });

  test("Always Use HTTPS off is medium", async () => {
    replies[`${P}/settings/always_use_https`] = setting("always_use_https", "off");
    const r = await run();
    assert.deepEqual(keys(r), ["always-use-https"]);
    assert.equal(r.findings[0]!.severity, "medium");
    assert.equal(r.findings[0]!.fix.link?.url, `${DASH}/ssl-tls/edge-certificates`);
  });

  test("minimum TLS below 1.2 is medium; 1.3 is fine", async () => {
    replies[`${P}/settings/min_tls_version`] = setting("min_tls_version", "1.0");
    let r = await run();
    assert.deepEqual(keys(r), ["min-tls-version"]);
    assert.equal(r.findings[0]!.severity, "medium");
    clearHttpCache();
    replies[`${P}/settings/min_tls_version`] = setting("min_tls_version", "1.3");
    r = await run();
    assert.deepEqual(r.findings, []);
  });

  test("HSTS off is low", async () => {
    replies[`${P}/settings/security_header`] = setting("security_header", { strict_transport_security: { enabled: false, max_age: 0 } });
    const r = await run();
    assert.deepEqual(keys(r), ["hsts"]);
    assert.equal(r.findings[0]!.severity, "low");
  });

  test("Automatic HTTPS Rewrites off is low", async () => {
    replies[`${P}/settings/automatic_https_rewrites`] = setting("automatic_https_rewrites", "off");
    const r = await run();
    assert.deepEqual(keys(r), ["automatic-https-rewrites"]);
    assert.equal(r.findings[0]!.severity, "low");
  });

  test("DNSSEC disabled or pending is low, linking DNS settings", async () => {
    for (const status of ["disabled", "pending"]) {
      clearHttpCache();
      replies[`${P}/dnssec`] = { status: 200, result: { status } };
      const r = await run();
      assert.deepEqual(keys(r), ["dnssec"]);
      assert.equal(r.findings[0]!.severity, "low");
      assert.equal(r.findings[0]!.fix.link?.url, `${DASH}/dns/settings`);
    }
  });

  test("no Zone Settings permission: one note naming it, no findings", async () => {
    for (const id of ["ssl", "always_use_https", "min_tls_version", "security_header", "automatic_https_rewrites"]) replies[`${P}/settings/${id}`] = refused;
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ["Add Zone → Zone Settings → Read to the Cloudflare token to check the SSL/TLS and HTTPS settings"]);
  });

  test("no DNS permission: a note for DNSSEC", async () => {
    replies[`${P}/dnssec`] = refused;
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ["Add Zone → DNS → Read to the Cloudflare token to check DNSSEC"]);
  });

  test("keys are stable across runs", async () => {
    replies[`${P}/settings/ssl`] = setting("ssl", "flexible");
    replies[`${P}/settings/security_header`] = setting("security_header", { strict_transport_security: { enabled: false } });
    replies[`${P}/dnssec`] = { status: 200, result: { status: "disabled" } };
    const first = keys(await run());
    assert.deepEqual(first, ["dnssec", "hsts", "ssl-mode"]);
    clearHttpCache();
    assert.deepEqual(keys(await run()), first);
  });

  test("an unreachable Cloudflare throws, so earlier findings are kept", async () => {
    for (const k of Object.keys(replies)) replies[k] = "unreachable";
    await assert.rejects(run(), /Can't reach Cloudflare/);
  });
});

const SITE = "https://example.org/";
const WWW = "https://www.example.org/";
const STRICT = "default-src 'self'; script-src 'self'; frame-ancestors 'none'";
const html = (head = "") => `<!doctype html><html><head>${head}</head><body>hi</body></html>`;
const site = (csp?: string, head = ""): Page => ({ status: 200, headers: { "content-type": "text/html; charset=utf-8", ...(csp ? { "content-security-policy": csp } : {}) }, body: html(head) });
const fresh = () => {
  clearHttpCache();
  return run();
};
const finding = (r: { findings: { key: string; severity: string }[] }, key: string) => r.findings.find((f) => f.key === key);

describe("what Cloudflare adds to pages, against the site's policy", () => {
  test("policies come from the header and from <meta> tags", () => {
    const h = new Headers({ "content-security-policy": "default-src 'self', script-src 'none'" });
    const p = pagePolicies(h, html(`<meta http-equiv="Content-Security-Policy" content="script-src 'self'"><meta name="x" content="y">`));
    assert.deepEqual(p, { header: ["default-src 'self'", "script-src 'none'"], meta: ["script-src 'self'"] });
  });

  test("which scripts a policy lets run", () => {
    assert.equal(cspAllows([], "inline"), true);
    assert.equal(cspAllows(["img-src 'self'"], "inline"), true, "no script or default directive says nothing");
    assert.equal(cspAllows([STRICT], "inline"), false);
    assert.equal(cspAllows(["script-src 'self' 'unsafe-inline'"], "inline"), true);
    assert.equal(cspAllows(["script-src 'unsafe-inline' 'nonce-abc'"], "inline"), false, "a nonce switches 'unsafe-inline' off");
    assert.equal(cspAllows(["script-src 'self' 'unsafe-inline'", STRICT], "inline"), false, "every policy must allow it");
    assert.equal(cspAllows([STRICT], "self"), true);
    assert.equal(cspAllows(["default-src 'none'"], "self"), false);
    assert.equal(cspAllows(["script-src-elem 'self'; script-src 'none'"], "self"), true, "script-src-elem wins for <script>");
    assert.equal(cspAllows([STRICT], { host: "static.cloudflareinsights.com" }), false);
    assert.equal(cspAllows(["script-src 'self' https://static.cloudflareinsights.com"], { host: "static.cloudflareinsights.com" }), true);
    assert.equal(cspAllows(["script-src *.cloudflareinsights.com"], { host: "static.cloudflareinsights.com" }), true);
  });

  test("nothing on: the site isn't fetched", async () => {
    pages[SITE] = site(STRICT);
    await fresh();
    assert.ok(!calls.some((c) => c.path === SITE));
  });

  test("Rocket Loader under a policy without inline scripts is high; with them, or no policy, nothing", async () => {
    replies[`${P}/settings/rocket_loader`] = setting("rocket_loader", "on");
    pages[SITE] = site(STRICT);
    assert.equal(finding(await fresh(), "rocket-loader-csp")?.severity, "high");
    pages[SITE] = site("script-src 'self' 'unsafe-inline'");
    assert.equal(finding(await fresh(), "rocket-loader-csp"), undefined);
    pages[SITE] = site();
    assert.equal(finding(await fresh(), "rocket-loader-csp"), undefined);
  });

  test("a <meta> policy counts as much as the header", async () => {
    replies[`${P}/settings/rocket_loader`] = setting("rocket_loader", "on");
    pages[SITE] = site(undefined, `<meta http-equiv='content-security-policy' content="script-src 'self'">`);
    assert.ok(finding(await fresh(), "rocket-loader-csp"));
  });

  test("Email Address Obfuscation only matters when the policy blocks the site's own scripts", async () => {
    replies[`${P}/settings/email_obfuscation`] = setting("email_obfuscation", "on");
    pages[SITE] = site(STRICT);
    assert.equal(finding(await fresh(), "email-obfuscation-csp"), undefined);
    pages[SITE] = site("default-src 'none'");
    assert.equal(finding(await fresh(), "email-obfuscation-csp")?.severity, "medium");
  });

  test("Bot Fight Mode is medium under a strict policy, unless the header carries a nonce", async () => {
    replies[`${P}/bot_management`] = { status: 200, result: { fight_mode: true } };
    pages[SITE] = site(STRICT);
    assert.equal(finding(await fresh(), "bot-fight-mode-csp")?.severity, "medium");
    pages[SITE] = site("script-src 'self' 'nonce-r4nd0m'");
    assert.equal(finding(await fresh(), "bot-fight-mode-csp"), undefined);
    pages[SITE] = site(undefined, `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'nonce-r4nd0m'">`);
    assert.ok(finding(await fresh(), "bot-fight-mode-csp"), "Cloudflare doesn't read nonces from <meta>");
  });

  test("Web Analytics' automatic setup for this zone is low when its beacon is blocked", async () => {
    const rum = (zone_tag: string) => ({ status: 200, result: [{ site_tag: "t", auto_install: true, ruleset: { zone_tag, enabled: true } }] }) as Reply;
    replies[`/client/v4/accounts/${ACCOUNT}/rum/site_info/list`] = rum("c".repeat(32));
    pages[SITE] = site(STRICT);
    assert.equal(finding(await fresh(), "web-analytics-csp"), undefined, "another zone's site");
    replies[`/client/v4/accounts/${ACCOUNT}/rum/site_info/list`] = rum(ZONE);
    assert.equal(finding(await fresh(), "web-analytics-csp")?.severity, "low");
    pages[SITE] = site("script-src 'self' https://static.cloudflareinsights.com");
    assert.equal(finding(await fresh(), "web-analytics-csp"), undefined);
  });

  test("a page that can't be read is a note, not a finding", async () => {
    replies[`${P}/settings/rocket_loader`] = setting("rocket_loader", "on");
    const r = await fresh();
    assert.deepEqual(r.findings, []);
    assert.match(r.notes!.join("\n"), /Content-Security-Policy wasn't read/);
  });

  test("permissions the token lacks are notes", async () => {
    replies[`${P}/bot_management`] = refused;
    replies[`${P}/email/routing`] = refused;
    replies[`/client/v4/accounts/${ACCOUNT}/rum/site_info/list`] = refused;
    const r = await fresh();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, [
      "Add Zone → Bot Management → Read to the Cloudflare token to check Bot Fight Mode",
      "Add Account → Account Analytics → Read to the Cloudflare token to check Web Analytics' automatic setup",
      "Add Zone → Email Routing Rules → Read to the Cloudflare token to check Email Routing",
    ]);
  });
});

describe("www and Email Routing", () => {
  const wwwRecord: Reply = { status: 200, result: [{ name: "www.example.org", type: "AAAA", content: "100::", proxied: true }] };

  test("a www record that answers an error is medium; a redirect or the site is fine", async () => {
    replies[`${P}/dns_records`] = wwwRecord;
    pages[WWW] = { status: 404, body: "not found" };
    const r = await fresh();
    assert.equal(finding(r, "www-broken")?.severity, "medium");
    assert.match(r.findings[0].why, /answers 404/);
    pages[WWW] = { status: 301, headers: { location: SITE } };
    assert.equal(finding(await fresh(), "www-broken"), undefined);
    pages[WWW] = site();
    assert.equal(finding(await fresh(), "www-broken"), undefined);
  });

  test("no www record: www isn't requested; one that doesn't answer is a note", async () => {
    await fresh();
    assert.ok(!calls.some((c) => c.path === WWW));
    replies[`${P}/dns_records`] = wwwRecord;
    const r = await fresh();
    assert.deepEqual(r.findings, []);
    assert.match(r.notes!.join("\n"), /www\.example\.org has a DNS record but didn't answer/);
  });

  test("no DNS permission: one note for www", async () => {
    replies[`${P}/dns_records`] = refused;
    assert.deepEqual((await fresh()).notes, ["Add Zone → DNS → Read to the Cloudflare token to check that www works"]);
  });

  test("Email Routing misconfigured is medium; ready or off is fine", async () => {
    replies[`${P}/email/routing`] = { status: 200, result: { enabled: true, status: "misconfigured" } };
    assert.equal(finding(await fresh(), "email-routing-records")?.severity, "medium");
    replies[`${P}/email/routing`] = { status: 200, result: { enabled: false, status: "unconfigured" } };
    assert.equal(finding(await fresh(), "email-routing-records"), undefined);
  });
});

const insight = (over: Partial<CfInsight>): CfInsight => ({
  id: `i-${Math.random().toString(36).slice(2)}`,
  dismissed: false,
  status: "active",
  issue_class: "dangling_a_records",
  issue_type: "exposed_infrastructure",
  severity: "Critical",
  subject: "old.example.org",
  resolve_link: `/${ACCOUNT}/example.org/dns/records`,
  resolve_text: "Delete the  <b>dangling</b> record in [DNS](https://example.com/docs)",
  timestamp: "2026-10-28T00:00:00Z",
  ...over,
});

describe("Cloudflare Security Insights", () => {
  test("severity: Critical is high, Moderate medium, Low low", () => {
    assert.equal(insightSeverity("Critical"), "high");
    assert.equal(insightSeverity("Moderate"), "medium");
    assert.equal(insightSeverity("Low"), "low");
    assert.equal(insightSeverity(undefined), "medium");
  });

  test("an open insight becomes a finding in plain words, with Cloudflare's fix and a full dashboard link", async () => {
    insights = [insight({})];
    const r = await run();
    assert.deepEqual(r.notes, []);
    assert.equal(r.findings.length, 1);
    const f = r.findings[0]!;
    assert.equal(f.key, "insight:dangling_a_records:old.example.org");
    assert.equal(f.severity, "high");
    assert.equal(f.title, "A DNS record for old.example.org points at nothing");
    assert.equal(f.fix.steps, "Delete the dangling record in DNS.");
    assert.equal(f.fix.link?.url, `https://dash.cloudflare.com/${ACCOUNT}/example.org/dns/records`);
    assert.ok(calls.some((c) => c.path.endsWith("/security-center/insights") && /dismissed=false/.test(c.search)));
  });

  test("the same insight reported twice is one finding: the first one's", async () => {
    insights = [insight({ resolve_text: "First steps" }), insight({ resolve_text: "Second steps", severity: "Low" })];
    const r = await run();
    assert.equal(r.findings.length, 1);
    assert.match(r.findings[0]!.fix.steps, /^First steps/);
    assert.equal(r.findings[0]!.severity, "high");
  });

  test("common classes get plain wording; an unknown one keeps Cloudflare's, tidied", async () => {
    insights = [
      insight({ issue_class: "unproxied_a_records", severity: "Moderate", subject: "api.example.org" }),
      insight({ issue_class: "dmarc_record_errors", issue_type: "email_security", severity: "Moderate", subject: "example.org" }),
      insight({ issue_class: "zones_without_waf_managed_rules", issue_type: "insecure_configuration", severity: "Low", subject: "example.org", resolve_link: "https://developers.cloudflare.com/waf/", resolve_text: undefined }),
      insight({ issue_class: "turnstile_not_enabled", issue_type: "configuration_suggestion", severity: "Low", subject: "example.org" }),
    ];
    const r = await run();
    const by = new Map(r.findings.map((f) => [f.key.split(":")[1], f]));
    assert.equal(by.get("unproxied_a_records")!.title, "api.example.org exposes your server's address");
    assert.equal(by.get("unproxied_a_records")!.severity, "medium");
    assert.equal(by.get("dmarc_record_errors")!.title, "example.org has no working DMARC record");
    const waf = by.get("zones_without_waf_managed_rules")!;
    assert.match(waf.title, /WAF managed rules/);
    assert.equal(waf.severity, "low");
    // A docs link isn't a settings page: the Security Center instead.
    assert.equal(waf.fix.link?.url, `https://dash.cloudflare.com/${ACCOUNT}/security-center`);
    assert.match(waf.fix.steps, /Security Insights/);
    assert.equal(by.get("turnstile_not_enabled")!.title, "Turnstile not enabled: example.org");
    assert.match(by.get("turnstile_not_enabled")!.why, /configuration suggestion/);
  });

  test("dismissed and resolved insights are skipped", async () => {
    insights = [insight({ dismissed: true }), insight({ status: "resolved", issue_class: "spf_record_errors" })];
    assert.deepEqual((await run()).findings, []);
    // Skipped here too, not only by Cloudflare's own filter.
    clearHttpCache();
    filtersDismissed = false;
    assert.deepEqual((await run()).findings, []);
  });

  test("insights about settings this audit reads are dropped; kept when the setting couldn't be read", async () => {
    insights = [
      insight({ issue_class: "always_use_https_not_enabled", subject: "example.org", severity: "Moderate" }),
      insight({ issue_class: "domains_without_hsts", subject: "example.org", severity: "Low" }),
      insight({ issue_class: "older_tls_version_supported", subject: "example.org", severity: "Moderate" }),
    ];
    replies[`${P}/settings/always_use_https`] = setting("always_use_https", "off");
    let r = await run();
    // The audit's own finding stands, once; the insights are gone.
    assert.deepEqual(keys(r), ["always-use-https"]);

    clearHttpCache();
    replies[`${P}/settings/always_use_https`] = refused;
    r = await run();
    assert.deepEqual(keys(r), ["insight:always_use_https_not_enabled:example.org"]);
  });

  test("insights are read page by page", async () => {
    insights = Array.from({ length: 150 }, (_, n) => insight({ subject: `h${n}.example.org` }));
    const r = await run();
    assert.equal(r.findings.length, 150);
    const pages = calls.filter((c) => c.path.endsWith("/security-center/insights")).map((c) => new URLSearchParams(c.search).get("page"));
    assert.deepEqual(pages, ["1", "2"]);
    // A full first page that holds them all: no second page asked for.
    clearHttpCache();
    calls = [];
    insights = Array.from({ length: 100 }, (_, n) => insight({ subject: `h${n}.example.org` }));
    assert.equal((await run()).findings.length, 100);
    assert.equal(calls.filter((c) => c.path.endsWith("/security-center/insights")).length, 1);
  });

  test("the same insight twice is one finding, and keys don't depend on the insight id", async () => {
    insights = [insight({ id: "a" }), insight({ id: "b" })];
    const first = keys(await run());
    assert.deepEqual(first, ["insight:dangling_a_records:old.example.org"]);
    clearHttpCache();
    insights = [insight({ id: "c" })];
    assert.deepEqual(keys(await run()), first);
  });

  test("no Security Center permission: a note naming it", async () => {
    insights = refused;
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ["Add Zone → Zone Security Center Insights → Read to the Cloudflare token to include Cloudflare's Security Insights"]);
  });

  test("Security Insights not available: a note saying so", async () => {
    insights = { status: 400 };
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes?.length, 1);
    assert.match(r.notes![0]!, /^Security Insights isn't available for example\.org/);
  });

  test("helpers: resolve text tidied, dashboard paths made full", () => {
    assert.equal(cleanText("  Turn on <i>HSTS</i>\n now "), "Turn on HSTS now.");
    assert.equal(dashboardLink(":account/:zone/ssl-tls", ACCOUNT, "example.org"), `https://dash.cloudflare.com/${ACCOUNT}/example.org/ssl-tls`);
    assert.equal(dashboardLink("https://dash.cloudflare.com/x/y", ACCOUNT, "z.com"), "https://dash.cloudflare.com/x/y");
    assert.equal(dashboardLink("https://evil.example/x", ACCOUNT, "z.com"), undefined);
    assert.equal(dashboardLink(undefined, ACCOUNT, "z.com"), undefined);
  });
});
