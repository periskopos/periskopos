import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { judgeRates, sendgrid, sumStats } from "../server/integrations/sendgrid.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// SendGrid, the email service: is the domain an app sends from still
// authenticated, and are its emails bouncing? Everything here is a fake;
// nothing reaches the network.

type Domain = { id: number; domain: string; subdomain?: string; valid: boolean; default?: boolean; dns?: Record<string, { valid: boolean; host: string }> };

const realFetch = globalThis.fetch;
let domains: Domain[];
let metrics: { requests: number; delivered: number; bounces: number; spam_reports: number }[];
let forbidden: Set<string>;
let refuse: { status: number; body: unknown } | undefined;
const calls: string[] = [];

beforeEach(() => {
  clearHttpCache();
  domains = [
    { id: 101, domain: "example.org", subdomain: "em123", valid: true, default: true },
    {
      id: 202,
      domain: "mail.example.net",
      subdomain: "em456",
      valid: false,
      dns: { mail_cname: { valid: true, host: "em456.mail.example.net" }, dkim1: { valid: false, host: "s1._domainkey.mail.example.net" } },
    },
  ];
  // Seven healthy days: 1,000 sent, 1% bounced, no spam reports.
  metrics = Array.from({ length: 7 }, () => ({ requests: 1000, delivered: 990, bounces: 10, spam_reports: 0 }));
  forbidden = new Set();
  refuse = undefined;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    assert.equal(url.host, "api.sendgrid.com");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(refuse.body, refuse.status);
    const area = url.pathname.split("/")[2]!;
    if (forbidden.has(area)) return json({ errors: [{ field: null, message: "access forbidden" }] }, 403);
    if (url.pathname === "/v3/whitelabel/domains") return json(domains);
    const one = url.pathname.match(/^\/v3\/whitelabel\/domains\/(\d+)$/);
    if (one) {
      const d = domains.find((x) => x.id === Number(one[1]));
      return d ? json(d) : json({ errors: [{ field: null, message: "authenticated domain not found" }] }, 404);
    }
    if (url.pathname === "/v3/stats") {
      assert.match(url.searchParams.get("start_date") ?? "", /^\d{4}-\d{2}-\d{2}$/);
      return json(metrics.map((m, i) => ({ date: `2026-10-${20 + i}`, stats: [{ metrics: m }] })));
    }
    return json({ errors: [{ message: "Not found" }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "sendgrid", name: "My SendGrid", canWrite: false }, token: async () => "SG.test" } as ServiceAuth;
const conn = (name: string, id: number): Connection => ({ id: "c", appId: "a", type: "sendgrid", serviceId: "s", resource: name, settings: { id } });
const app = (url: string): App => ({ id: "a", slug: "x", ownerId: "u", name: "X", url, live: true, checkIntervalMin: 5, connections: [] });

describe("SendGrid: bounce and spam rates", () => {
  test("the week's numbers added up, and judged", () => {
    const sum = sumStats([{ date: "d", stats: [{ metrics: { requests: 3, delivered: 2, bounces: 1, spam_reports: 0 } }, {}] }, { date: "e", stats: [] }]);
    assert.deepEqual(sum, { requests: 3, delivered: 2, bounces: 1, spamReports: 0 });
    assert.equal(judgeRates({ requests: 0, delivered: 0, bounces: 0, spamReports: 0 }).text, "No emails sent this week");
    assert.equal(judgeRates({ requests: 7000, delivered: 6930, bounces: 70, spamReports: 0 }).state, "up");
    assert.equal(judgeRates({ requests: 1000, delivered: 900, bounces: 100, spamReports: 0 }).state, "down", "10% bounced");
    assert.equal(judgeRates({ requests: 1000, delivered: 950, bounces: 50, spamReports: 0 }).state, "up", "5% is the line, not over it");
    assert.equal(judgeRates({ requests: 1000, delivered: 1000, bounces: 0, spamReports: 4 }).state, "down", "0.4% spam reports");
    assert.equal(judgeRates({ requests: 1000, delivered: 1000, bounces: 0, spamReports: 2 }).state, "up", "0.2%: over the advice, under the line");
    assert.equal(judgeRates({ requests: 20, delivered: 15, bounces: 5, spamReports: 1 }).state, "up", "too few emails to judge");
  });
});

describe("SendGrid: a sending domain's state", () => {
  test("check: an authenticated domain with healthy rates is up, the numbers in the summary", async () => {
    const r = await sendgrid.check!(conn("example.org", 101), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "Authenticated · 7,000 sent this week · 1% bounced · 0% spam reports");
    assert.ok(calls.every((c) => c.startsWith("GET ")));
  });

  test("check: a domain that isn't authenticated is down, naming the broken record", async () => {
    const r = await sendgrid.check!(conn("mail.example.net", 202), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^mail\.example\.net: Not authenticated \(DNS records not found: s1\._domainkey\.mail\.example\.net\): its emails may land in spam or be refused/);
    assert.equal(r.link?.url, "https://app.sendgrid.com/settings/sender_auth");
  });

  test("check: a high bounce rate is down, citing the numbers", async () => {
    metrics = Array.from({ length: 7 }, () => ({ requests: 1000, delivered: 920, bounces: 80, spam_reports: 0 }));
    const r = await sendgrid.check!(conn("example.org", 101), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^8% of emails bounced this week \(560 of 7000; over 5% hurts delivery\)$/);
    assert.match(r.summary!, /8% bounced/);
  });

  test("a domain removed from the account is down, said plainly", async () => {
    const r = await sendgrid.check!(conn("old.example.com", 999), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /isn't authenticated in this SendGrid account any more/);
  });

  test("a key without Stats: the domain is still checked, and the summary says what to grant", async () => {
    forbidden.add("stats");
    const r = await sendgrid.check!(conn("example.org", 101), auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Authenticated · stats unavailable: This SendGrid key can't read Stats\. .*Read Access to Stats/);
  });

  test("a key without Sender Authentication: says which read access to grant", async () => {
    forbidden.add("whitelabel");
    await assert.rejects(sendgrid.testService!(auth), /can't read Sender Authentication\. .*give it Read Access to Sender Authentication/);
    const r = await sendgrid.check!(conn("example.org", 101), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /Read Access to Sender Authentication/);
  });
});

describe("SendGrid: connecting it", () => {
  test("Test says how many domains are valid, and checks Stats can be read", async () => {
    assert.equal((await sendgrid.testService!(auth)).message, "Connected: 2 authenticated domains, 1 valid");
    assert.ok(calls.some((c) => c.startsWith("GET /v3/stats?start_date=")));
    clearHttpCache();
    forbidden.add("stats");
    await assert.rejects(sendgrid.testService!(auth), /can't read Stats/);
  });

  test("the account lists its domains once each, the valid one kept", async () => {
    domains.unshift({ id: 303, domain: "Example.org", valid: false }); // listed first by SendGrid, and still not the one kept
    const list = await sendgrid.listResources!(auth);
    assert.deepEqual(list.map((r) => [r.id, r.detail, r.settings]), [
      ["example.org", "Authenticated · default", { id: 101 }],
      ["mail.example.net", "Not authenticated", { id: 202 }],
    ]);
  });

  test("an account with no domains says where to add one", async () => {
    domains = [];
    await assert.rejects(sendgrid.listResources!(auth), /Settings → Sender Authentication/);
  });

  test("an app's sending domain is the one its address is on, a subdomain included", async () => {
    const list = await sendgrid.listResources!(auth);
    assert.equal(sendgrid.suggestOnlyMatched, true);
    assert.equal(sendgrid.matchApp!(app("https://example.org/"), list)?.id, "example.org");
    assert.equal(sendgrid.matchApp!(app("https://www.example.org/"), list)?.id, "example.org");
    assert.equal(sendgrid.matchApp!(app("https://example.net/"), list)?.id, "mail.example.net");
    assert.equal(sendgrid.matchApp!(app("https://other.example/"), list), undefined);
    // Both example.org and em.example.org are on example.org: the longest wins.
    domains.push({ id: 404, domain: "em.example.org", valid: true });
    clearHttpCache();
    const more = await sendgrid.listResources!(auth);
    assert.equal(sendgrid.matchApp!(app("https://example.org/"), more)?.id, "em.example.org");
    assert.equal(sendgrid.matchApp!(app("https://www.example.org/"), more)?.id, "example.org");
  });

  test("parse: a domain picked from the list, with its id", () => {
    assert.deepEqual(sendgrid.parse({ resource: "Example.org", settings: { id: 101 } }), { resource: "example.org", settings: { id: 101 } });
    assert.deepEqual(sendgrid.parse({ resource: "example.org", settings: { id: "101" } }), { resource: "example.org", settings: { id: 101 } });
    assert.throws(() => sendgrid.parse({ resource: "example.org", settings: {} }), /Pick the domain from the list/);
    assert.throws(() => sendgrid.parse({ resource: "not a domain", settings: { id: 101 } }), /sending domain looks like/);
  });

  test("a rejected key is reported, not thrown", async () => {
    refuse = { status: 401, body: { errors: [{ field: null, message: "authorization required" }] } };
    const r = await sendgrid.check!(conn("example.org", 101), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /SendGrid rejected the key \(401\)/);
  });
});
