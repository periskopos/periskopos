import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { githubSecurity, securityHealth } from "../server/integrations/github-security.ts";
import { paddle } from "../server/integrations/paddle.ts";
import { DAY_MS, FAILED_MIN, paymentsHealth, revenueOf } from "../server/integrations/payments.ts";
import { stripe } from "../server/integrations/stripe.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Payments (Stripe, Paddle) and GitHub security alerts. Everything here is
// a fake; nothing reaches the network.

const NOW = Date.now();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
let seen: URL[];
let answer: (u: URL) => Response;
beforeEach(() => {
  clearHttpCache();
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    seen.push(u);
    return answer(u);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const authOf = (type: string, token: string) => ({ service: { id: "s", ownerId: "u", type, name: type, canWrite: false }, token: async () => token }) as ServiceAuth;
const connOf = (type: string, resource: string): Connection => ({ id: "c", appId: "a", type, serviceId: "s", resource, settings: {} });

describe("Payments, whatever the provider", () => {
  test("revenue per currency: 7 days, the 7 before, 30 days; biggest first", () => {
    const at = (days: number) => NOW - days * DAY_MS;
    const r = revenueOf(
      [
        { at: at(1), amount: 1000, currency: "eur" },
        { at: at(10), amount: 500, currency: "eur" },
        { at: at(20), amount: 200, currency: "EUR" },
        { at: at(2), amount: 9000, currency: "usd" },
        { at: at(40), amount: 99999, currency: "usd" },
      ],
      NOW,
    );
    assert.deepEqual(r, [
      { currency: "USD", last7d: 9000, prev7d: 0, last30d: 9000 },
      { currency: "EUR", last7d: 1000, prev7d: 500, last30d: 1700 },
    ]);
  });

  test("needs attention when payments fail far more than usual, or webhooks stop arriving", () => {
    const at = new Date().toISOString();
    const base = { provider: "Stripe", mode: "live" as const, webhooks: { failing24h: 0 } };
    assert.equal(paymentsHealth({ ...base, failed: { last24h: FAILED_MIN - 1, prev7d: 0 } }, at).state, "up", "a few failures are normal");
    assert.equal(paymentsHealth({ ...base, failed: { last24h: 8, prev7d: 49 } }, at).state, "up", "7 a day is the usual here");
    const spike = paymentsHealth({ ...base, failed: { last24h: 30, prev7d: 14 } }, at);
    assert.deepEqual([spike.state, spike.detail], ["down", "30 failed payments in the last 24 h (usually 2 a day)"]);
    assert.match(paymentsHealth({ ...base, failed: { last24h: 0, prev7d: 0 }, webhooks: { failing24h: 0, disabledEndpoints: 1 } }, at).detail!, /A webhook endpoint is disabled/);
    assert.match(paymentsHealth({ ...base, failed: { last24h: 0, prev7d: 0 }, webhooks: { failing24h: 4 } }, at).detail!, /4 events .* haven't reached/);
  });
});

describe("Stripe", () => {
  const charge = (id: string, daysAgo: number, amount: number, extra: Record<string, unknown> = {}) => ({ id, amount, currency: "eur", created: Math.floor((NOW - daysAgo * DAY_MS) / 1000), status: "succeeded", paid: true, ...extra });
  const stripeAnswers = (u: URL) => {
    if (u.pathname === "/v1/charges/search") {
      // Failed charges: 2 in the last day, 6 in the week before it.
      const q = u.searchParams.get("query")!;
      assert.match(q, /^status:'failed' AND created>\d+ AND created<=\d+$/);
      const [from, to] = [...q.matchAll(/\d+/g)].map((m) => Number(m[0]));
      const days = Math.round((to! - from!) / 86_400);
      return json({ data: Array.from({ length: days === 1 ? 2 : days === 7 ? 6 : 0 }, (_, i) => charge(`ch_f${i}`, 0, 1, { status: "failed" })), has_more: false });
    }
    if (u.pathname === "/v1/events") return json({ data: [{ id: "evt_1" }], has_more: false });
    if (u.pathname === "/v1/webhook_endpoints") return json({ data: [{ id: "we_1", status: "enabled" }], has_more: false });
    if (u.pathname === "/v1/charges") {
      return u.searchParams.get("starting_after")
        ? json({ data: [charge("ch_3", 20, 300)], has_more: false })
        : json({ data: [charge("ch_1", 1, 1000, { amount_refunded: 200 }), charge("ch_2", 2, 500, { status: "failed", paid: false })], has_more: true });
    }
    if (u.pathname === "/v1/account") return json({ id: "acct_123", settings: { dashboard: { display_name: "Star Shop" } } });
    if (u.pathname === "/v1/balance") return json({ livemode: true });
    return json({ error: { message: "nope" } }, 404);
  };

  test("details: revenue less refunds, pages followed, webhooks read, the mode from the key", async () => {
    answer = stripeAnswers;
    const d = await stripe.details!(connOf("stripe", "acct_123"), authOf("stripe", "rk_test_abc"));
    assert.ok(d.shape === "payments");
    assert.deepEqual(d.revenue, [{ currency: "EUR", last7d: 800, prev7d: 0, last30d: 1100 }]);
    assert.deepEqual([d.mode, d.payments7d, d.webhooks, d.partial, d.link.url], ["test", 1, { failing24h: 1 }, undefined, "https://dashboard.stripe.com/test/payments"]);
    assert.deepEqual(d.failed, { last24h: 2, prev7d: 6 }, "the last day and the week before it, counted apart");
    const events = seen.find((u) => u.pathname === "/v1/events")!;
    assert.equal(events.searchParams.get("delivery_success"), "false");
    assert.ok(Number(events.searchParams.get("created[lte]")) <= Math.floor((NOW - 3_600_000) / 1000) + 5, "the last hour is left out");
  });

  test("the account a key belongs to; parse takes only an account", async () => {
    answer = stripeAnswers;
    assert.deepEqual(await stripe.listResources!(authOf("stripe", "rk_live_abc")), [{ id: "acct_123", label: "Star Shop", detail: "live", settings: { name: "Star Shop" } }]);
    assert.equal((await stripe.testService!(authOf("stripe", "rk_live_abc"))).message, "Connected to Stripe (live)");
    assert.throws(() => stripe.parse({ resource: "https://evil", settings: {} }), /Pick the account/);
  });
});

describe("Paddle", () => {
  test("a sandbox key reads the sandbox; counts come from Paddle's totals; next pages stay on its API", async () => {
    answer = (u) => {
      if (u.pathname === "/subscriptions") return json({ data: [{}], meta: { pagination: { estimated_total: 3 } } });
      if (u.pathname === "/notifications") return json({ data: [], meta: { pagination: { estimated_total: 0 } } });
      if (u.pathname === "/transactions" && u.searchParams.get("status") === "past_due") return json({ data: [{}], meta: { pagination: { estimated_total: 7 } } });
      if (u.pathname === "/transactions" && u.searchParams.get("after")) {
        return json({ data: [{ id: "txn_2", status: "completed", created_at: new Date(NOW - 9 * DAY_MS).toISOString(), details: { totals: { total: "2500", currency_code: "USD" } } }], meta: { pagination: { has_more: false } } });
      }
      return json({
        data: [{ id: "txn_1", status: "completed", created_at: new Date(NOW - DAY_MS).toISOString(), billed_at: new Date(NOW - DAY_MS).toISOString(), details: { totals: { total: "16500", currency_code: "USD" } } }],
        meta: { pagination: { has_more: true, next: "https://sandbox-api.paddle.com/transactions?after=txn_1" } },
      });
    };
    const d = await paddle.details!(connOf("paddle", "account"), authOf("paddle", "pdl_sdbx_apikey_x"));
    assert.ok(d.shape === "payments");
    assert.ok(seen.every((u) => u.origin === "https://sandbox-api.paddle.com"));
    assert.deepEqual(d.revenue, [{ currency: "USD", last7d: 16500, prev7d: 2500, last30d: 19000 }]);
    assert.deepEqual([d.mode, d.pastDue, d.failed, d.webhooks], ["test", 3, { last24h: 7, prev7d: 7 }, { failing24h: 0 }]);
  });

  test("never follows a next page off Paddle's API", async () => {
    answer = (u) =>
      u.pathname === "/transactions" && !u.searchParams.get("status")?.includes("past_due")
        ? json({ data: [], meta: { pagination: { has_more: true, next: "https://evil.example/steal" } } })
        : json({ data: [], meta: { pagination: { estimated_total: 0 } } });
    await assert.rejects(paddle.details!(connOf("paddle", "account"), authOf("paddle", "pdl_live_apikey_x")), /outside its API/);
    assert.ok(seen.every((u) => u.origin === "https://api.paddle.com"));
  });
});

describe("GitHub security alerts", () => {
  const dep = (n: number, severity: string, name: string) => ({ number: n, html_url: `https://github.com/acme/shop/security/dependabot/${n}`, created_at: new Date().toISOString(), security_vulnerability: { severity, package: { name } } });
  const at = new Date().toISOString();

  test("anything high or critical, or any leaked secret, needs attention; lower ones are counted", () => {
    const calm = securityHealth("acme/shop", { alerts: [dep(1, "moderate", "lodash"), dep(2, "low", "qs"), dep(3, "moderate", "x")] }, { alerts: [] }, at);
    assert.deepEqual([calm.state, calm.summary], ["up", "Dependabot: 2 moderate, 1 low"]);
    const bad = securityHealth("acme/shop", { alerts: [dep(4, "critical", "next"), dep(5, "high", "next")] }, { alerts: [{ number: 1, html_url: "https://github.com/acme/shop/security/secret-scanning/1", created_at: at, secret_type_display_name: "Stripe API Key" }] }, at);
    assert.equal(bad.state, "down");
    assert.equal(bad.detail, "A leaked secret: Stripe API Key · 2 dependency alerts rated high or critical: next");
    assert.deepEqual(bad.link, { url: "https://github.com/acme/shop/security/secret-scanning/1", label: "Open the secret alert" });
  });

  test("a scanner that's off says so; both off is unknown, not a failure", async () => {
    answer = (u) =>
      u.pathname.endsWith("/secret-scanning/alerts")
        ? json({ message: "Secret scanning is disabled on this repository." }, 404)
        : u.pathname.endsWith("/dependabot/alerts")
          ? json([dep(1, "high", "axios")])
          : json({}, 404);
    const r = await githubSecurity.check!(connOf("github-security", "acme/shop"), authOf("github", "github_pat_x"));
    assert.equal(r.state, "down");
    assert.match(r.summary!, /Secret scanning alerts is off for this repository/);
    clearHttpCache();
    answer = () => json({ message: "Resource not accessible by personal access token" }, 403);
    const none = await githubSecurity.check!(connOf("github-security", "acme/shop"), authOf("github", "github_pat_x"));
    assert.equal(none.state, "unknown");
    assert.match(none.detail!, /needs Dependabot alerts: Read-only/);
  });

  test("picked like a GitHub repository", () => {
    assert.deepEqual(githubSecurity.parse({ resource: "acme/shop", settings: { branch: "main" } }), { resource: "acme/shop", settings: {} });
    assert.throws(() => githubSecurity.parse({ resource: "nope", settings: {} }), /owner\/name/);
  });
});
