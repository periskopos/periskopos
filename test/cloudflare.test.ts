import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { openDb } from "../server/db.ts";
import { clearHttpCache } from "../server/http.ts";
import { cloudflareIntegration as cf, phaseOf } from "../server/integrations/cloudflare.ts";
import { authFor } from "../server/keys/secrets.ts";
import * as store from "../server/store.ts";

process.env.PERISKOPOS_TEST_CF_KEY = "cf_test";

const ACCOUNT = "a".repeat(32);
const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const realFetch = globalThis.fetch;
let deployments: unknown[] = [];
let projects: unknown[] = [{ name: "star-map", domains: ["example.org"] }];
let calls: { method: string; path: string }[] = [];

const ok = (result: unknown) => new Response(JSON.stringify({ success: true, result, errors: [] }), { headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearHttpCache();
  deployments = [];
  calls = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname + url.search });
    assert.equal(url.host, "api.cloudflare.com");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer cf_test");
    if (url.pathname === "/client/v4/accounts") return ok([{ id: ACCOUNT, name: "Me" }]);
    if (url.pathname === `/client/v4/accounts/${ACCOUNT}/pages/projects`) return ok(projects);
    if (url.pathname === `/client/v4/accounts/${ACCOUNT}/workers/scripts`) return ok([]);
    if (url.pathname.endsWith("/retry")) return ok({ id: "new1" });
    if (url.pathname.endsWith("/deployments")) return ok(deployments);
    return new Response(JSON.stringify({ success: false, errors: [{ message: "nope" }] }), { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const dep = (id: string, stage: string, status: string, sha: string, startedAgo: number, tookMs = 60_000) => ({
  id,
  created_on: iso(startedAgo),
  environment: "production",
  latest_stage: { name: stage, status, started_on: iso(startedAgo), ended_on: status === "active" ? null : iso(startedAgo - tookMs) },
  deployment_trigger: { metadata: { commit_hash: sha, commit_message: `change ${sha}\n\nbody` } },
});

function setUp() {
  const db = openDb(":memory:");
  const userId = store.createUser(db, "Me").id;
  const service = store.createService(db, userId, { type: "cloudflare", name: "My Cloudflare", secretRef: "PERISKOPOS_TEST_CF_KEY", canWrite: true });
  const app = store.createApp(db, userId, { name: "Star-Map", url: "http://star-map.example" });
  const conn = store.addConnection(db, app, { type: "cloudflare", serviceId: service.id, resource: "star-map", settings: { accountId: ACCOUNT } });
  return { conn, auth: authFor(service) };
}

describe("cloudflare pages", () => {
  test("deploy phases", () => {
    assert.equal(phaseOf({ latest_stage: { name: "deploy", status: "success" } }), "live");
    assert.equal(phaseOf({ latest_stage: { name: "build", status: "active" } }), "in-progress");
    assert.equal(phaseOf({ latest_stage: { name: "queued", status: "idle" } }), "in-progress");
    assert.equal(phaseOf({ latest_stage: { name: "build", status: "failure" } }), "failed");
    assert.equal(phaseOf({ latest_stage: { name: "deploy", status: "canceled" } }), "other");
  });

  test("parse needs the account from the picked project", () => {
    assert.throws(() => cf.parse({ resource: "star-map", settings: {} }));
    assert.throws(() => cf.parse({ resource: "bad name!", settings: { accountId: ACCOUNT } }));
    assert.deepEqual(cf.parse({ resource: "star-map", settings: { accountId: ACCOUNT } }), { resource: "star-map", settings: { kind: "pages", accountId: ACCOUNT, name: "star-map" } });
  });

  test("lists projects across accounts, and tests the key", async () => {
    const { auth } = setUp();
    assert.match((await cf.testService!(auth)).message, /Connected to Me/);
    const [p] = await cf.listResources!(auth);
    assert.equal(p.id, "star-map");
    assert.deepEqual(p.settings, { kind: "pages", name: "star-map", accountId: ACCOUNT });
    assert.equal(p.detail, "Pages · Me · example.org");
  });

  test("listing: an account with no Pages projects says which account it searched and what to change", async () => {
    const { auth } = setUp();
    projects = [];
    try {
      await assert.rejects(cf.listResources!(auth), /No Cloudflare Pages projects or Workers in Me, the only account this token can see.*Account Resources to All accounts/s);
    } finally {
      projects = [{ name: "star-map", domains: ["example.org"] }];
    }
  });

  test("check: live is up, a failed latest deploy is down, a running one is deploying", async () => {
    const { conn, auth } = setUp();
    deployments = [dep("d2", "deploy", "success", "bbb", 2 * H)];
    let r = await cf.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Live: bbb/);

    clearHttpCache();
    deployments = [dep("d3", "build", "failure", "ccc", H), dep("d2", "deploy", "success", "bbb", 2 * H)];
    r = await cf.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /Deploy failed \(build failed\)/);

    clearHttpCache();
    deployments = [dep("d4", "build", "active", "ddd", 60_000), dep("d2", "deploy", "success", "bbb", 2 * H)];
    r = await cf.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Deploying ddd/);
  });

  test("check: a deploy running after a failed one keeps the failure, not 'went live'", async () => {
    const { conn, auth } = setUp();
    deployments = [dep("d4", "build", "active", "ddd", 60_000), dep("d3", "build", "failure", "ccc", H), dep("d2", "deploy", "success", "bbb", 2 * H)];
    let r = await cf.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /Deploy failed \(build failed\): ccc/);

    clearHttpCache();
    deployments = [dep("d4", "build", "canceled", "ddd", 60_000), dep("d3", "build", "failure", "ccc", H)];
    r = await cf.check!(conn, auth);
    assert.equal(r.state, "down", "a canceled deploy fixes nothing");
  });

  test("details link each deploy to the dashboard", async () => {
    const { conn, auth } = setUp();
    deployments = [dep("d2", "deploy", "success", "bbb", H)];
    const d = await cf.details!(conn, auth);
    assert.ok(d.shape === "deploys");
    assert.equal(d.deploys[0].url, `https://dash.cloudflare.com/${ACCOUNT}/pages/view/star-map/d2`);
  });

  test("redeploy retries the newest deploy, but not while one is running", async () => {
    const { conn, auth } = setUp();
    deployments = [dep("d4", "build", "active", "ddd", 60_000)];
    let r = await cf.run!(conn, auth, "redeploy");
    assert.equal(r.ok, false);
    assert.equal(calls.some((c) => c.method === "POST"), false);

    clearHttpCache();
    deployments = [dep("d2", "deploy", "success", "bbb", H)];
    r = await cf.run!(conn, auth, "redeploy");
    assert.equal(r.ok, true);
    assert.deepEqual(calls.at(-1), { method: "POST", path: `/client/v4/accounts/${ACCOUNT}/pages/projects/star-map/deployments/d2/retry` });
  });
});
