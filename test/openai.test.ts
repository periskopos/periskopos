import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkEvery } from "../shared/catalog.ts";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { BUDGET_MAX_USD, ORGANIZATION, budgetOf, monthStart, openai, spendByProject, usd } from "../server/integrations/openai.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// OpenAI's administration API is faked: nothing here reaches the network,
// and every call must be a GET.

const realFetch = globalThis.fetch;
const ADMIN_KEY = "sk-admin-abc123";
let calls: URL[];
let projectPages: { data: unknown[]; has_more: boolean; last_id?: string }[];
// Cost pages, each a list of buckets; the next page's cursor is its index.
let costPages: { start_time: number; results: unknown[] }[][];
let refuse: { status: number; body: unknown } | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const cost = (project_id: string | null, value: number, currency = "usd") => ({ object: "organization.costs.result", amount: { value, currency }, line_item: null, project_id });

beforeEach(() => {
  clearHttpCache();
  calls = [];
  refuse = undefined;
  projectPages = [
    {
      data: [
        { id: "proj_starmap1", object: "organization.project", name: "Star-Map", created_at: 1_700_000_000, archived_at: null, status: "active" },
        { id: "proj_moonbase", object: "organization.project", name: "Moon Base", created_at: 1_700_000_000, archived_at: 1_750_000_000, status: "archived" },
      ],
      has_more: true,
      last_id: "proj_moonbase",
    },
    { data: [{ id: "proj_comet123", object: "organization.project", name: "Comet", created_at: 1_700_000_000, archived_at: null, status: "active" }], has_more: false },
  ];
  costPages = [
    [
      { start_time: 1, results: [cost("proj_starmap1", 100.25), cost("proj_moonbase", 3)] },
      { start_time: 2, results: [cost("proj_starmap1", 60), cost(null, 1.5)] },
    ],
    [{ start_time: 3, results: [cost("proj_starmap1", 51.75), cost("proj_comet123", 0.2), cost("proj_comet123", 9, "eur")] }],
  ];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(url);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    assert.equal(url.host, "api.openai.com");
    if (refuse) return json(refuse.body, refuse.status);
    if (url.pathname === "/v1/organization/projects") {
      assert.equal(url.searchParams.get("include_archived"), "true");
      return json({ object: "list", ...projectPages[url.searchParams.get("after") ? 1 : 0] });
    }
    if (url.pathname === "/v1/organization/costs") {
      assert.equal(url.searchParams.get("bucket_width"), "1d");
      assert.equal(url.searchParams.get("group_by"), "project_id");
      const i = Number(url.searchParams.get("page") ?? 0);
      const more = i + 1 < costPages.length;
      return json({ object: "page", data: costPages[i]!.map((b) => ({ object: "bucket", end_time: b.start_time + 86400, ...b })), has_more: more, next_page: more ? String(i + 1) : null });
    }
    return json({ error: { message: "Not found" } }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const authWith = (key: string) => ({ service: { id: "s", ownerId: "u", type: "openai", name: "OpenAI", canWrite: false }, token: async () => key }) as ServiceAuth;
const auth = authWith(ADMIN_KEY);
const conn = (resource: string, settings?: Record<string, unknown>): Connection => ({ id: "c", appId: "a", type: "openai", serviceId: "s", resource, ...(settings ? { settings } : {}) });

describe("OpenAI account", () => {
  test("testing the key counts projects, archived ones too, every page", async () => {
    assert.deepEqual(await openai.testService!(auth), { message: "Connected: 3 projects, 1 archived" });
    assert.equal(calls[1]!.searchParams.get("after"), "proj_moonbase");
  });

  test("lists the whole organization first, then each project", async () => {
    assert.deepEqual(await openai.listResources!(auth), [
      { id: ORGANIZATION, label: "Whole organization", detail: "Every project's spend together" },
      { id: "proj_starmap1", label: "Star-Map", settings: { name: "Star-Map" } },
      { id: "proj_moonbase", label: "Moon Base", detail: "Archived", settings: { name: "Moon Base" } },
      { id: "proj_comet123", label: "Comet", settings: { name: "Comet" } },
    ]);
  });

  test("a project or user key: says only an admin key can read costs", async () => {
    refuse = { status: 403, body: { error: { message: "You have insufficient permissions for this operation. Missing scopes: api.management.read." } } };
    await assert.rejects(openai.testService!(authWith("sk-proj-xyz")), /Only an OpenAI admin key can read projects and costs/);
    const r = await openai.check!(conn("proj_starmap1"), authWith("sk-proj-xyz"));
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /admin key/);
  });

  test("an admin key that's been revoked: rejected, not mistaken for the wrong kind", async () => {
    refuse = { status: 401, body: { error: { message: "Incorrect API key provided" } } };
    await assert.rejects(openai.testService!(auth), /OpenAI rejected the key \(401\)/);
  });

  test("checked hourly; over budget needs attention, it isn't an outage", () => {
    assert.equal(checkEvery("openai", 5), "every 1 h");
    assert.equal(openai.incidentKind, "spend");
  });
});

describe("the monthly budget", () => {
  test("parse: a project or the organization, a name, and a budget in dollars", () => {
    assert.deepEqual(openai.parse({ resource: "proj_starmap1", settings: { name: "Star-Map", budgetUsd: 150 } }), { resource: "proj_starmap1", settings: { name: "Star-Map", budgetUsd: 150 } });
    assert.deepEqual(openai.parse({ resource: ORGANIZATION, settings: { budgetUsd: " $1,200.50 " } }), { resource: ORGANIZATION, settings: { budgetUsd: 1200.5 } });
    assert.deepEqual(openai.parse({ resource: "proj_starmap1", settings: { budgetUsd: "" } }), { resource: "proj_starmap1" }, "no budget: none");
    assert.throws(() => openai.parse({ resource: "sk-admin-oops", settings: {} }), /Pick the project from the list/);
  });

  test("a budget must be more than 0 and sane", () => {
    assert.equal(budgetOf(undefined), undefined);
    assert.equal(budgetOf(0.5), 0.5);
    for (const bad of [0, -5, "ten", Number.NaN, Infinity, BUDGET_MAX_USD + 1, true]) {
      assert.throws(() => budgetOf(bad), /Monthly budget must be an amount in dollars/, String(bad));
    }
  });

  test("amounts in words: cents only while they matter", () => {
    assert.equal(usd(212), "$212");
    assert.equal(usd(212.4), "$212");
    assert.equal(usd(3.2), "$3.20");
    assert.equal(usd(0), "$0");
    assert.equal(usd(1234.5), "$1,235");
  });
});

describe("OpenAI spend", () => {
  test("costs from the start of this month UTC, every page, summed by project, dollars only", async () => {
    const now = Date.UTC(2026, 9, 29, 15);
    const { byProject, partial } = await spendByProject(auth, now);
    assert.equal(partial, false);
    assert.equal(byProject.get("proj_starmap1"), 212);
    assert.equal(byProject.get("proj_moonbase"), 3);
    assert.equal(byProject.get("proj_comet123"), 0.2, "a cost in another currency isn't added in");
    assert.equal(byProject.get(null), 1.5);
    assert.equal(monthStart(now), Date.UTC(2026, 9, 1) / 1000);
    assert.equal(calls[0]!.searchParams.get("start_time"), String(Date.UTC(2026, 9, 1) / 1000));
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.searchParams.get("page"), "1");
  });

  test("over its budget: down, with the amounts and where to look", async () => {
    const r = await openai.check!(conn("proj_starmap1", { budgetUsd: 150 }), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "$212 spent this month, over its $150 budget");
    assert.equal(r.summary, r.detail);
    assert.equal(r.link?.label, "Open OpenAI usage");
    assert.equal(openai.notice!("down", "Star-Map", r.detail!, 0).title, "Star-Map: OpenAI spend is over budget");
  });

  test("under its budget: up, saying how much of it is used", async () => {
    const r = await openai.check!(conn("proj_starmap1", { budgetUsd: 400 }), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "$212 spent this month · 53% of its $400 budget");
    const atBudget = await openai.check!(conn("proj_starmap1", { budgetUsd: 212 }), auth);
    assert.equal(atBudget.state, "up", "spending exactly the budget isn't over it");
    assert.equal(atBudget.summary, "$212 spent this month · 100% of its $212 budget");
  });

  test("without a budget: up, the spend only; one costs read serves every project", async () => {
    assert.deepEqual(
      { ...(await openai.check!(conn("proj_comet123"), auth)), at: "" },
      { state: "up", at: "", summary: "$0.20 spent this month" },
    );
    const before = calls.filter((c) => c.pathname.endsWith("/costs")).length;
    await openai.check!(conn("proj_starmap1"), auth);
    assert.equal(calls.filter((c) => c.pathname.endsWith("/costs")).length, before);
  });

  test("the whole organization adds every project, and costs outside one", async () => {
    const r = await openai.check!(conn(ORGANIZATION, { budgetUsd: 200 }), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "$217 spent this month, over its $200 budget");
  });

  test("an archived project says so", async () => {
    const r = await openai.check!(conn("proj_moonbase", { budgetUsd: 1 }), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /^Moon Base is archived in OpenAI/);
    assert.equal(r.summary, "Archived · $3.00 spent this month");
  });

  test("a project gone from the organization says so", async () => {
    const r = await openai.check!(conn("proj_deleted9"), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /isn't in the OpenAI organization any more/);
  });
});
