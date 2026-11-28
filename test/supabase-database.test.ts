import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection, DatabaseDetails } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { IDLE_WARN_DAYS, idleDaysOf, idleWarning, requestsByDay, supabase } from "../server/integrations/supabase.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// The Supabase project's use and what runs beside it (the app page's
// Database panel), and the warning before a free project is paused for being
// idle. Everything here is a fake; nothing reaches the network, and only GET
// is ever sent.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const REF = "abcdefghijklmnopqrst";
const auth = { service: { id: "s", ownerId: "u", type: "supabase", name: "Supabase", canWrite: false }, token: async () => "test-token" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "supabase", serviceId: "s", resource: REF, settings: { name: "shop" } };

type Fake = { plan: string; counts: unknown; functions: unknown; backups: unknown; health: unknown };
let fake: Fake;
let methods: string[];
const realFetch = globalThis.fetch;
const project = { id: REF, ref: REF, name: "shop", region: "eu-central-1", status: "ACTIVE_HEALTHY", organization_id: "acme-org", organization_slug: "acme-org", database: { version: "17.4.1.054" } };

beforeEach(() => {
  clearHttpCache();
  methods = [];
  // A project in use today on the free plan.
  fake = {
    plan: "free",
    counts: { result: [{ timestamp: iso(2 * 60 * 60_000), total_rest_requests: 120, total_auth_requests: 3, total_storage_requests: 1, total_realtime_requests: 0 }, { timestamp: iso(3 * DAY), total_rest_requests: 40, total_auth_requests: 0, total_storage_requests: 0, total_realtime_requests: 2 }] },
    functions: [
      { id: "1", slug: "old", name: "old", status: "ACTIVE", version: 1, created_at: NOW - 30 * DAY, updated_at: NOW - 30 * DAY },
      { id: "2", slug: "send-mail", name: "send-mail", status: "ACTIVE", version: 4, created_at: NOW - 9 * DAY, updated_at: NOW - DAY },
    ],
    backups: { region: "eu-central-1", walg_enabled: false, pitr_enabled: false, backups: [] },
    health: [{ name: "auth", healthy: true }, { name: "db", healthy: true }, { name: "rest", healthy: true }],
  };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    methods.push(init?.method ?? "GET");
    const answer = (x: unknown) => (typeof x === "number" ? json({ message: "Forbidden" }, x) : json(x));
    const p = url.pathname;
    if (p === "/v1/projects") return json([project]);
    if (p === `/v1/projects/${REF}`) return json(project);
    if (p === "/v1/organizations/acme-org") return json({ id: "acme-org", name: "Acme", plan: fake.plan });
    if (p === `/v1/projects/${REF}/analytics/endpoints/usage.api-counts`) {
      assert.equal(url.searchParams.get("interval"), "7day");
      return answer(fake.counts);
    }
    if (p === `/v1/projects/${REF}/functions`) return answer(fake.functions);
    if (p === `/v1/projects/${REF}/database/backups`) return answer(fake.backups);
    if (p === `/v1/projects/${REF}/health`) return json(fake.health);
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  assert.ok(methods.every((m) => m === "GET"), "only GET");
  globalThis.fetch = realFetch;
});

describe("requests and idleness", () => {
  test("requests fall into the last 7 UTC days, oldest first; the newest one with any is the last", () => {
    const r = requestsByDay(
      [
        { timestamp: iso(60_000), total_rest_requests: 5 },
        { timestamp: iso(DAY), total_auth_requests: 2, total_storage_requests: 1 },
        { timestamp: iso(20 * DAY), total_rest_requests: 999 }, // outside the window: not counted
        { timestamp: iso(30_000), total_rest_requests: 0 }, // nothing in it: not the last
      ],
      NOW,
    );
    assert.equal(r.days.length, 7);
    assert.equal(r.days.at(-1)!.day, new Date(NOW).toISOString().slice(0, 10));
    assert.equal(r.total, 8);
    assert.equal(r.lastAt, iso(60_000));
  });

  test("idle days count whole days since the last request; none in the window is a week", () => {
    assert.equal(idleDaysOf(iso(DAY - 1000), NOW), 0);
    assert.equal(idleDaysOf(iso(5 * DAY + 1000), NOW), 5);
    assert.equal(idleDaysOf(undefined, NOW), 7);
  });

  test("only a free project idle long enough is warned about, and the warning names the policy", () => {
    assert.equal(idleWarning("free", iso((IDLE_WARN_DAYS - 1) * DAY), NOW), undefined);
    assert.match(idleWarning("free", iso(IDLE_WARN_DAYS * DAY + 1000), NOW)!, /^No API requests for 5 days: Supabase pauses a free project after a week without activity/);
    assert.match(idleWarning("Free", undefined, NOW)!, /^No API requests in the last 7 days/);
    assert.equal(idleWarning("pro", undefined, NOW), undefined, "paid projects aren't paused for being idle");
    assert.equal(idleWarning(undefined, undefined, NOW), undefined, "an unknown plan claims nothing");
  });
});

describe("the check", () => {
  test("a free project in use is up", async () => {
    const r = await supabase.check!(conn, auth);
    assert.equal(r.state, "up");
  });

  test("a free project idle for 6 days needs attention, with a link to open it", async () => {
    fake.counts = { result: [{ timestamp: iso(6 * DAY + 60_000), total_rest_requests: 10 }] };
    const r = await supabase.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^No API requests for 6 days: Supabase pauses a free project/);
    assert.equal(r.link?.url, `https://supabase.com/dashboard/project/${REF}`);
  });

  test("a paid project with no requests, or one whose requests can't be read, stays up", async () => {
    fake.counts = { result: [] };
    fake.plan = "pro";
    assert.equal((await supabase.check!(conn, auth)).state, "up");
    clearHttpCache();
    fake.plan = "free";
    fake.counts = 403;
    assert.equal((await supabase.check!(conn, auth)).state, "up", "no reading is no warning, never a false one");
  });
});

describe("the Database panel", () => {
  const read = async () => (await supabase.details!(conn, auth)) as DatabaseDetails;

  test("plan, where it runs, requests, how close a free project is to a pause, functions newest first, backups", async () => {
    const d = await read();
    assert.equal(d.shape, "database");
    assert.deepEqual([d.project, d.status, d.plan, d.region, d.postgres], ["shop", "Running", "free", "eu-central-1", "17.4.1.054"]);
    assert.equal(d.requests!.total, 166);
    assert.deepEqual(d.pausesWhenIdle, { afterDays: 7, idleDays: 0 });
    assert.deepEqual(d.functions!.map((f) => [f.name, f.version]), [["send-mail", 4], ["old", 1]]);
    assert.equal(d.functions![0]!.updatedAt, new Date(NOW - DAY).toISOString());
    assert.deepEqual(d.backups, { pitr: false, count: 0 });
    assert.deepEqual(d.notes, []);
    assert.equal(d.link.url, `https://supabase.com/dashboard/project/${REF}`);
  });

  test("a paid plan has no pause, and its newest finished backup is the latest", async () => {
    fake.plan = "pro";
    fake.backups = { pitr_enabled: false, backups: [{ status: "COMPLETED", inserted_at: "2026-11-27T02:00:00.000Z" }, { status: "COMPLETED", inserted_at: "2026-11-28T02:00:00.000Z" }, { status: "FAILED", inserted_at: "2026-11-28T03:00:00.000Z" }] };
    const d = await read();
    assert.equal(d.pausesWhenIdle, undefined);
    assert.deepEqual(d.backups, { pitr: false, count: 2, latest: "2026-11-28T02:00:00.000Z" });
  });

  test("a part the token can't read is left out and said, the rest still shown", async () => {
    fake.counts = 403;
    fake.functions = 403;
    const d = await read();
    assert.equal(d.requests, undefined, "never shown as zero");
    assert.equal(d.functions, undefined);
    assert.equal(d.pausesWhenIdle, undefined, "no idleness claimed without the requests");
    assert.deepEqual(d.notes.sort(), ["Edge Functions not shown: the token lacks Edge Functions: read", "Requests not shown: the token lacks Analytics usage: read"]);
    assert.equal(d.plan, "free");
  });
});
