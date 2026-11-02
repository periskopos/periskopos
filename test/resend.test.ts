import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { describeDomain, resend } from "../server/integrations/resend.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";
import { obviousMatch } from "../server/suggestions.ts";

// Resend, the email service: is the domain an app sends from still
// verified? Everything here is a fake; nothing reaches the network.

const realFetch = globalThis.fetch;
let domains: { id: string; name: string; status: string; region?: string }[];
let refuse: { status: number; body: unknown } | undefined;
const calls: string[] = [];

beforeEach(() => {
  clearHttpCache();
  domains = [
    { id: "d_exo_1234", name: "example.org", status: "verified", region: "eu-west-1" },
    { id: "d_mail_5678", name: "mail.example.net", status: "failed", region: "us-east-1" },
  ];
  refuse = undefined;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    // Resend answers only the account's own key.
    if (new Headers(init?.headers).get("authorization") !== "Bearer re_test") return new Response(JSON.stringify({ statusCode: 401, message: "API key is invalid", name: "validation_error" }), { status: 401, headers: { "content-type": "application/json" } });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(refuse.body, refuse.status);
    if (url.pathname === "/domains") return json({ data: domains });
    const one = url.pathname.match(/^\/domains\/(.+)$/);
    if (one) {
      const d = domains.find((x) => x.id === decodeURIComponent(one[1]!));
      return d ? json(d) : json({ statusCode: 404, message: "Domain not found", name: "not_found" }, 404);
    }
    return json({ message: "Not found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "resend", name: "My Resend", canWrite: false }, token: async () => "re_test" } as ServiceAuth;
const conn = (name: string, id: string): Connection => ({ id: "c", appId: "a", type: "resend", serviceId: "s", resource: name, settings: { id } });
const app = (url: string): App => ({ id: "a", slug: "x", ownerId: "u", name: "X", url, live: true, checkIntervalMin: 5, connections: [] });

describe("Resend: a sending domain's state", () => {
  test("each status in words, and whether the app's emails are at risk", () => {
    assert.deepEqual(describeDomain("verified"), { state: "up", text: "Verified" });
    assert.equal(describeDomain("pending").state, "unknown", "still being set up: no alarm");
    assert.equal(describeDomain("failed").state, "down");
    assert.equal(describeDomain("partially_verified").state, "down");
    assert.match(describeDomain("temporary_failure").text, /can't find its DNS records/);
    assert.equal(describeDomain("brand_new").text, "Domain status: brand new");
  });

  test("check: verified is up; failed is down, with the reason and a link to it", async () => {
    const ok = await resend.check!(conn("example.org", "d_exo_1234"), auth);
    assert.equal(ok.state, "up");
    assert.equal(ok.summary, "Verified · eu-west-1");
    assert.equal(ok.link, undefined, "nothing to look at");

    const bad = await resend.check!(conn("mail.example.net", "d_mail_5678"), auth);
    assert.equal(bad.state, "down");
    assert.match(bad.detail!, /^mail\.example\.net: Its DNS records failed verification/);
    assert.deepEqual(bad.link, { url: "https://resend.com/domains/d_mail_5678", label: "Open the domain in Resend" });
  });

  test("a domain removed from the account is down, said plainly", async () => {
    const r = await resend.check!(conn("old.example.com", "d_gone_0000"), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /isn't in this Resend account any more/);
  });

  test("a Sending access key: says which key it needs", async () => {
    refuse = { status: 401, body: { statusCode: 401, message: "This API key is restricted to only send emails", name: "restricted_api_key" } };
    await assert.rejects(resend.testService!(auth), /can only send emails\. Create one with Full access/);
  });
});

describe("Resend: connecting it", () => {
  test("the account lists its domains, and Test says how many are verified", async () => {
    assert.deepEqual((await resend.testService!(auth)).message, "Connected: 2 domains, 1 verified");
    assert.deepEqual(calls, ["GET /domains"]);
    const list = await resend.listResources!(auth);
    assert.deepEqual(list.map((r) => [r.id, r.settings]), [["example.org", { id: "d_exo_1234" }], ["mail.example.net", { id: "d_mail_5678" }]]);
  });

  test("an app's sending domain is the one its address is on, a subdomain included", async () => {
    const list = await resend.listResources!(auth);
    assert.equal(obviousMatch(app("https://example.org/"), "resend", list)?.id, "example.org");
    assert.equal(obviousMatch(app("https://example.net/"), "resend", list)?.id, "mail.example.net");
    assert.equal(obviousMatch(app("https://other.example/"), "resend", list), undefined);
  });

  test("parse: a domain picked from the list, with its id", () => {
    assert.deepEqual(resend.parse({ resource: "Example.org", settings: { id: "d_exo_1234" } }), { resource: "example.org", settings: { id: "d_exo_1234" } });
    assert.throws(() => resend.parse({ resource: "example.org", settings: {} }), /Pick the domain from the list/);
    assert.throws(() => resend.parse({ resource: "not a domain", settings: { id: "d_exo_1234" } }), /sending domain looks like/);
  });
});
