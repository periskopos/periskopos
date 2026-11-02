import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text } from "./dom-helpers.ts";
import type { ServiceView, UsageMeter } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import { clearHttpCache } from "../server/http.ts";
import { WORKERS_FREE_DAILY, workersRequestsToday } from "../server/integrations/cloudflare.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";
import type { Notice } from "../server/alerts/notify.ts";
import * as store from "../server/store.ts";
import { USAGE_EVERY_MS, Watcher, usageLevel, usageNews } from "../server/watcher.ts";
import { mount } from "../web/src/dom.ts";
import { planLine } from "../web/src/views/services.ts";

// A free plan's limit, watched: Cloudflare Workers' 100,000 requests a day.
// Read every 30 minutes, shown on the Accounts page, and a notification
// once a day each when it nears the limit and when it's over. An account
// marked as on Workers Paid is left alone. Nothing reaches the network.

process.env.PERISKOPOS_TEST_PLANUSAGE_CF = "cf_usage_secret";
const ACCOUNT = "a".repeat(32);
const realFetch = globalThis.fetch;
let requests: number;
let graphql: { query: string; variables: Record<string, string> }[];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearHttpCache();
  requests = 1234;
  graphql = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/client/v4/accounts") return json({ success: true, result: [{ id: ACCOUNT, name: "Me" }] });
    if (url.pathname === "/client/v4/graphql") {
      graphql.push(JSON.parse(String(init?.body)));
      return json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests } }] }] } } });
    }
    return json({ success: false, errors: [{ message: "Not Found" }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const meter = (used: number, resetsAt = "2026-10-20T00:00:00.000Z"): UsageMeter => ({ label: "Workers requests today", used, limit: WORKERS_FREE_DAILY, resetsAt });

describe("reading Workers usage", () => {
  test("today's requests across the account, from midnight UTC; resets at the next one", async () => {
    const now = Date.parse("2026-10-19T15:30:00Z");
    const auth = { service: {}, token: async () => "t" } as unknown as ServiceAuth;
    assert.deepEqual(await workersRequestsToday(auth, now), [{ label: "Workers requests today", used: 1234, limit: 100_000, resetsAt: "2026-10-20T00:00:00.000Z" }]);
    assert.deepEqual(graphql[0]!.variables, { accountTag: ACCOUNT, start: "2026-10-19T00:00:00.000Z", end: "2026-10-19T15:30:00.000Z" });
    assert.match(graphql[0]!.query, /workersInvocationsAdaptive/);
  });

  test("levels, and news only when a level goes up within the same day", () => {
    assert.deepEqual([meter(79_999), meter(80_000), meter(100_000)].map(usageLevel), ["ok", "near", "over"]);
    const before = { at: "x", meters: [meter(85_000)] };
    assert.deepEqual(usageNews(before, [meter(90_000)]), [], "already warned today");
    assert.deepEqual(usageNews(before, [meter(100_500)]).map((n) => n.level), ["over"]);
    assert.deepEqual(usageNews(before, [meter(85_000, "2026-10-21T00:00:00.000Z")]).map((n) => n.level), ["near"], "a new day starts over");
    assert.deepEqual(usageNews({ at: "x", error: "refused" }, [meter(85_000)]).map((n) => n.level), ["near"]);
  });
});

describe("the watcher", () => {
  let db: DatabaseSync;
  let userId: string;
  let notices: Notice[];
  let watcher: Watcher;
  beforeEach(() => {
    db = openDb(":memory:");
    userId = store.createUser(db, "Me").id;
    notices = [];
    watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", isOnline: async () => true });
  });

  test("stores the reading, warns once near the limit and once over it, and leaves a paid account alone", async () => {
    const cf = store.createService(db, userId, { type: "cloudflare", name: "My Cloudflare", secretRef: "PERISKOPOS_TEST_PLANUSAGE_CF", canWrite: false });
    store.createService(db, userId, { type: "github", name: "My GitHub", canWrite: false }); // no free limit to watch
    let now = Date.now();
    await watcher.checkPlanUsage(userId, now);
    const read = store.getService(db, userId, cf.id)!.planUsage;
    assert.ok(read && "meters" in read && read.meters[0]!.used === 1234);
    assert.equal(notices.length, 0);

    requests = 85_000;
    clearHttpCache();
    await watcher.checkPlanUsage(userId, now + 60_000);
    assert.equal(graphql.length, 1, "not again within 30 minutes");
    now += USAGE_EVERY_MS;
    await watcher.checkPlanUsage(userId, now);
    assert.deepEqual(notices.map((n) => n.title), ["My Cloudflare: 85% of the free plan's limit"]);
    assert.match(notices[0]!.body, /Workers requests today: 85,000 of 100,000\. It resets in/);

    clearHttpCache();
    requests = 90_000;
    now += USAGE_EVERY_MS;
    await watcher.checkPlanUsage(userId, now);
    assert.equal(notices.length, 1, "near is said once");

    clearHttpCache();
    requests = 100_001;
    now += USAGE_EVERY_MS;
    await watcher.checkPlanUsage(userId, now);
    assert.equal(notices[1]?.title, "My Cloudflare: over the free plan's limit");
    assert.match(notices[1]!.body, /or move to Workers Paid/);

    store.setServicePaidPlan(db, store.getService(db, userId, cf.id)!, true);
    assert.equal(store.getService(db, userId, cf.id)!.planUsage, undefined, "the paid plan has nothing to show");
    const calls = graphql.length;
    await watcher.checkPlanUsage(userId, now + 2 * USAGE_EVERY_MS);
    assert.equal(graphql.length, calls);
  });
});

describe("the Accounts page", () => {
  const view = (over: Partial<ServiceView>): ServiceView => ({ id: "s", ownerId: "u", type: "cloudflare", name: "My Cloudflare", canWrite: false, keyState: "set", apps: [], ...over });
  const draw = (s: ServiceView) => {
    const root = document.createElement("div");
    const line = planLine(s);
    if (line) mount(root, line);
    return root;
  };

  test("a bar per limit, amber near it; the plan when it's paid; the limit before the first reading", () => {
    const at = new Date().toISOString();
    const near = draw(view({ planUsage: { at, meters: [meter(85_000, new Date(Date.now() + 3 * 3_600_000).toISOString())] } }));
    assert.match(text(near), /Workers requests today: 85,000 of 100,000 \(85%\) · resets in 3 h/);
    assert.ok(near.querySelector(".usage-meter--near"));
    const bar = near.querySelector("[role=meter]")!;
    assert.deepEqual([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax")], ["85000", "100000"]);
    assert.equal((near.querySelector(".usage-fill") as HTMLElement).style.width, "85%");

    assert.match(text(draw(view({ paidPlan: true }))), /No daily limit to watch/);
    assert.match(text(draw(view({}))), /Workers Free: 100,000 requests a day/);
    assert.match(text(draw(view({ planUsage: { at, error: "Cloudflare refused the analytics" } }))), /Couldn't read usage: Cloudflare refused/);
    assert.equal(planLine(view({ type: "github" })), undefined, "no plan, no line");
  });
});
