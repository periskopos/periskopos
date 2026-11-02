import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { branchFull, computeProblem, failedOperations, neon, quotaHit } from "../server/integrations/neon.ts";
import type { Endpoint, Operation, Project } from "../server/integrations/neon.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Neon, serverless Postgres: is the project's compute healthy, and within
// its limits? Everything here is a fake; nothing reaches the network.

const realFetch = globalThis.fetch;
const MIN = 60_000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

let project: Project;
let endpoints: Endpoint[];
let operations: Operation[];
let orgs: { id: string; name: string }[] | "refused";
let refuse: { status: number; body: unknown } | undefined;
const calls: string[] = [];

beforeEach(() => {
  clearHttpCache();
  project = { id: "shiny-wind-028834", name: "star-map", region_id: "aws-us-east-2", compute_time_seconds: 1000, settings: { quota: {} }, consumption_period_end: "2026-11-01T00:00:00Z" };
  endpoints = [
    { id: "ep-main-1", branch_id: "br-main", type: "read_write", current_state: "idle", updated_at: ago(60 * MIN) },
    { id: "ep-dev-1", branch_id: "br-dev", type: "read_write", current_state: "init", pending_state: "active", updated_at: ago(90 * MIN) },
  ];
  operations = [];
  orgs = [{ id: "org-one", name: "Personal" }, { id: "org-two", name: "Team" }];
  refuse = undefined;
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${url.pathname}${url.search}`);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer napi_test");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(refuse.body, refuse.status);
    const p = url.pathname.replace(/^\/api\/v2/, "");
    if (p === "/users/me/organizations") return orgs === "refused" ? json({ message: "not allowed for org keys" }, 404) : json({ organizations: orgs });
    if (p === "/projects") {
      const org = url.searchParams.get("org_id");
      const list = org === "org-two" ? [{ id: "cool-sun-1", name: "moon-base", region_id: "aws-eu-central-1", org_name: "Team" }] : [{ id: project.id, name: project.name, region_id: project.region_id, org_name: "Personal" }];
      return json({ projects: list, pagination: { cursor: "x" } });
    }
    if (p === `/projects/${project.id}`) return json({ project });
    if (p === `/projects/${project.id}/endpoints`) return json({ endpoints });
    if (p === `/projects/${project.id}/branches`) {
      return json({ branches: [{ id: "br-main", name: "main", default: true, logical_size: 30 * 2 ** 20 }, { id: "br-dev", name: "dev", default: false, logical_size: 1000 }] });
    }
    if (p === `/projects/${project.id}/operations`) return json({ operations });
    return json({ message: "project not found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "neon", name: "My Neon", canWrite: false }, token: async () => "napi_test" } as ServiceAuth;
const conn = (id = "shiny-wind-028834"): Connection => ({ id: "c", appId: "a", type: "neon", serviceId: "s", resource: id, settings: { name: "star-map" } });

describe("Neon: connecting it", () => {
  test("a personal key lists every organization's projects, and Test says how many", async () => {
    assert.equal((await neon.testService!(auth)).message, "Connected: 2 projects visible");
    const list = await neon.listResources!(auth);
    assert.deepEqual(list, [
      { id: "shiny-wind-028834", label: "star-map", detail: "Personal · aws-us-east-2", settings: { name: "star-map" } },
      { id: "cool-sun-1", label: "moon-base", detail: "Team · aws-eu-central-1", settings: { name: "moon-base" } },
    ]);
    assert.ok(calls.includes("/api/v2/projects?limit=400&org_id=org-one"));
  });

  test("an organization key can't list organizations: its projects are listed without one", async () => {
    orgs = "refused";
    assert.equal((await neon.testService!(auth)).message, "Connected: 1 project visible");
    assert.ok(calls.includes("/api/v2/projects?limit=400"));
  });

  test("a rejected key says what to do", async () => {
    refuse = { status: 401, body: { message: "authentication required" } };
    await assert.rejects(neon.testService!(auth), /Neon rejected the API key.*Account settings → API keys/);
  });

  test("parse: a project ID, with its name", () => {
    assert.deepEqual(neon.parse({ resource: "shiny-wind-028834", settings: { name: "star-map" } }), { resource: "shiny-wind-028834", settings: { name: "star-map" } });
    assert.throws(() => neon.parse({ resource: "Not A Project!", settings: {} }), /project ID looks like/);
    assert.throws(() => neon.parse({ resource: "", settings: {} }));
  });
});

describe("Neon: a project's health", () => {
  test("scaled to zero is normal: up, and other branches' computes don't count", async () => {
    const r = await neon.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "Scaled to zero (wakes on the next connection) · main branch · aws-us-east-2");
    assert.equal(r.detail, undefined);
  });

  test("an active compute is up", async () => {
    endpoints[0] = { ...endpoints[0]!, current_state: "active" };
    assert.match((await neon.check!(conn(), auth)).summary!, /^Compute active/);
  });

  test("a compute stuck starting is down, with a link to the project", async () => {
    endpoints[0] = { ...endpoints[0]!, current_state: "idle", pending_state: "active", updated_at: ago(40 * MIN) };
    const r = await neon.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /stuck going from idle to active for 40 min/);
    assert.deepEqual(r.link, { url: "https://console.neon.tech/app/projects/shiny-wind-028834", label: "Open the project in Neon" });
  });

  test("a compute that failed to start is down, in Neon's words; a later success clears it", async () => {
    operations = [{ id: "op1", action: "start_compute", status: "failed", error: "compute is suspended: quota exceeded", branch_id: "br-main", endpoint_id: "ep-main-1", created_at: ago(5 * MIN) }];
    const r = await neon.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Neon couldn't start its compute: compute is suspended: quota exceeded");

    clearHttpCache();
    operations.push({ id: "op2", action: "start_compute", status: "finished", branch_id: "br-main", endpoint_id: "ep-main-1", created_at: ago(1 * MIN) });
    assert.equal((await neon.check!(conn(), auth)).state, "up");
  });

  test("a quota used up is down, and says until when", async () => {
    project.settings = { quota: { compute_time_seconds: 1000 } };
    const r = await neon.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "The project used up its compute time quota: Neon suspended its computes until 2026-11-01");
  });

  test("a project that's gone is down; another failure is unknown", async () => {
    assert.equal((await neon.check!(conn("gone-project-1"), auth)).state, "down");
    refuse = { status: 403, body: {} };
    const r = await neon.check!(conn(), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /project-scoped key only sees its one project/);
  });

  test("the pieces, one by one", () => {
    const now = Date.now();
    assert.equal(computeProblem({ id: "e", branch_id: "b", type: "read_write", current_state: "active", disabled: true, updated_at: ago(0) }, now), "Connections to its compute are turned off in Neon");
    assert.equal(computeProblem({ id: "e", branch_id: "b", type: "read_write", current_state: "init", updated_at: ago(2 * MIN) }, now), undefined, "starting for 2 min is fine");
    assert.equal(quotaHit({ ...project, settings: { quota: { data_transfer_bytes: 0 } }, data_transfer_bytes: 99 }), undefined, "0 means unlimited");
    assert.match(quotaHit({ ...project, settings: { quota: { data_transfer_bytes: 50 } }, data_transfer_bytes: 99 })!, /data transfer quota/);
    assert.equal(branchFull({ ...project, branch_logical_size_limit_bytes: 512 * 2 ** 20 }, { id: "b", name: "main", logical_size: 512 * 2 ** 20 }), "Its main branch is full (512 MB of 512 MB): writes to it fail");
    assert.equal(branchFull({ ...project, branch_logical_size_limit_bytes: 512 * 2 ** 20 }, { id: "b", name: "main", logical_size: 2 ** 20 }), undefined);
    const ops: Operation[] = [
      { id: "1", action: "suspend_compute", status: "error", created_at: ago(MIN) },
      { id: "2", action: "start_compute", status: "error", branch_id: "br-dev", created_at: ago(MIN) },
      { id: "3", action: "apply_config", status: "failed", branch_id: "br-main", created_at: ago(3 * 86_400_000) },
    ];
    assert.deepEqual(failedOperations(ops, "br-main", now), [], "scale-to-zero, other branches and old failures don't count");
  });
});
