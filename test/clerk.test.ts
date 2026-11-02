import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { clerk, usersSummary } from "../server/integrations/clerk.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Clerk, the sign-in service: does its Backend API answer the key, and how
// many people use the app? Everything here is a fake; nothing reaches the
// network.

const realFetch = globalThis.fetch;
let instance: { object: string; id: string; environment_type: string };
let domains: { object: string; id: string; name: string; is_satellite: boolean; frontend_api_url: string }[];
let total: number;
let recent: number;
let refuse: { status: number; body: unknown } | undefined;
const calls: string[] = [];

beforeEach(() => {
  clearHttpCache();
  instance = { object: "instance", id: "ins_2abcDEF456ghi789", environment_type: "production" };
  domains = [
    { object: "domain", id: "dmn_sat", name: "star-map.app", is_satellite: true, frontend_api_url: "https://clerk.star-map.app" },
    { object: "domain", id: "dmn_main", name: "example.org", is_satellite: false, frontend_api_url: "https://clerk.example.org" },
  ];
  total = 1204;
  recent = 37;
  refuse = undefined;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    assert.equal(url.host, "api.clerk.com");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(refuse.body, refuse.status);
    if (url.pathname === "/v1/instance") return json(instance);
    if (url.pathname === "/v1/domains") return json({ data: domains, total_count: domains.length });
    if (url.pathname === "/v1/users/count") {
      const after = url.searchParams.get("created_at_after");
      if (after) {
        const ms = Number(after);
        assert.ok(Date.now() - ms >= 7 * 86_400_000 && Date.now() - ms < 7 * 86_400_000 + 3_600_000, "a week ago, to the hour, in ms");
      }
      return json({ object: "total_count", total_count: after ? recent : total });
    }
    return json({ errors: [{ message: "not found", code: "resource_not_found" }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const authWith = (key: string) => ({ service: { id: "s", ownerId: "u", type: "clerk", name: "My Clerk", canWrite: false }, token: async () => key }) as ServiceAuth;
const auth = authWith("sk_live_abc");
const conn = (instanceId = "ins_2abcDEF456ghi789"): Connection => ({ id: "c", appId: "a", type: "clerk", serviceId: "s", resource: "example.org", settings: { instance: instanceId } });
const app = (url: string): App => ({ id: "a", slug: "x", ownerId: "u", name: "X", url, live: true, checkIntervalMin: 5, connections: [] });

describe("Clerk: is sign-in working", () => {
  test("users in words", () => {
    assert.equal(usersSummary(1204, 37), "1,204 users · 37 signed up this week");
    assert.equal(usersSummary(1, 0), "1 user · 0 signed up this week");
  });

  test("check: the Backend API answers, with its users and this week's sign-ups", async () => {
    const r = await clerk.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "1,204 users · 37 signed up this week");
    assert.ok(calls.some((c) => /^GET \/v1\/users\/count\?created_at_after=\d+$/.test(c)));
    assert.ok(calls.every((c) => c.startsWith("GET ")));
  });

  test("check: a revoked key is down, said plainly", async () => {
    refuse = { status: 401, body: { errors: [{ message: "Invalid authentication", code: "authentication_invalid" }] } };
    const r = await clerk.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /this key was rotated or revoked/);
    assert.equal(r.link?.label, "Open API keys in Clerk");
  });

  test("check: a Development instance says so", async () => {
    instance.environment_type = "development";
    const r = await clerk.check!(conn(), authWith("sk_test_abc"));
    assert.equal(r.state, "up");
    assert.equal(r.summary, "Development instance · 1,204 users · 37 signed up this week");
  });

  test("check: a key for another instance isn't taken for this one", async () => {
    const r = await clerk.check!(conn("ins_somethingElse0001"), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /different instance than example\.org/);
  });

  test("other failures are unknown, not down", async () => {
    refuse = { status: 500, body: { errors: [{ message: "oops" }] } };
    const r = await clerk.check!(conn(), auth);
    assert.equal(r.state, "unknown");
  });
});

describe("Clerk: connecting it", () => {
  test("Test says which instance the key is for, and its users", async () => {
    assert.equal((await clerk.testService!(auth)).message, "Connected: Production instance, 1,204 users");
    clearHttpCache();
    instance.environment_type = "development";
    assert.equal((await clerk.testService!(authWith("sk_test_abc"))).message, "Connected: Development instance (test users only), 1,204 users");
  });

  test("the account holds one resource: the instance, by its primary domain", async () => {
    const list = await clerk.listResources!(auth);
    assert.deepEqual(list, [
      {
        id: "example.org",
        label: "example.org",
        detail: "Production instance · also star-map.app",
        settings: { instance: "ins_2abcDEF456ghi789", domains: ["example.org", "star-map.app"] },
      },
    ]);
  });

  test("an app on one of its domains is matched; a Development instance isn't", async () => {
    const list = await clerk.listResources!(auth);
    assert.equal(clerk.suggestOnlyMatched, true);
    assert.equal(clerk.matchApp!(app("https://example.org/"), list)?.id, "example.org");
    assert.equal(clerk.matchApp!(app("https://app.star-map.app/"), list)?.id, "example.org", "a satellite domain");
    assert.equal(clerk.matchApp!(app("https://other.example/"), list), undefined);
    assert.deepEqual(clerk.suggestedSettings!(app("https://example.org/"), list[0]!), { instance: "ins_2abcDEF456ghi789" });

    clearHttpCache();
    instance.environment_type = "development";
    domains = [{ object: "domain", id: "dmn_dev", name: "proper-gecko-12.clerk.accounts.dev", is_satellite: false, frontend_api_url: "https://proper-gecko-12.clerk.accounts.dev" }];
    const dev = await clerk.listResources!(authWith("sk_test_abc"));
    assert.equal(dev[0]!.detail, "Development instance");
    assert.equal(clerk.matchApp!(app("https://example.org/"), dev), undefined);
    assert.equal(clerk.matchApp!(app("https://proper-gecko-12.clerk.accounts.dev/"), dev), undefined, "not even on its own domain");
  });

  test("parse: the application picked from the list, with its instance", () => {
    assert.deepEqual(clerk.parse({ resource: "Example.org", settings: { instance: "ins_2abcDEF456ghi789", domains: ["x"] } }), {
      resource: "example.org",
      settings: { instance: "ins_2abcDEF456ghi789" },
    });
    assert.throws(() => clerk.parse({ resource: "example.org", settings: {} }), /so its instance is known/);
    assert.throws(() => clerk.parse({ resource: "not a domain!", settings: { instance: "ins_2abcDEF456ghi789" } }), /Pick the Clerk application/);
  });
});
