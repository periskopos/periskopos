import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, AppStatus, Connection, Deploy, ServiceView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { deployState } from "../server/deploys.ts";
import * as history from "../server/history.ts";
import { clearHttpCache } from "../server/http.ts";
import { github, latestPerWorkflow } from "../server/integrations/github.ts";
import { phaseOf, renderIntegration, slowAfterMs } from "../server/integrations/render.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { authFor } from "../server/keys/secrets.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// Keys come from the environment here instead of .env.local.
process.env.PERISKOPOS_TEST_RENDER_KEY = "rnd_test";
process.env.PERISKOPOS_TEST_GITHUB_KEY = "ghp_test";

// ── A fake GitHub and Render ────────────────────────────────────────────

const H = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Fake = { deploys: unknown[]; commits: unknown[]; runs: unknown[]; compare: Record<string, string>; calls: string[] };
let fake: Fake;
const realFetch = globalThis.fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  clearHttpCache();
  fake = { deploys: [], commits: [], runs: [], compare: {}, calls: [] };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    fake.calls.push(url.pathname + url.search);
    if (url.host === "api.render.com") {
      if (url.pathname === "/v1/owners") return json([{ owner: { name: "Me" } }]);
      if (url.pathname === "/v1/services")
        return json([{ service: { id: "srv-abc", name: "star-map", type: "static_site", dashboardUrl: "https://dashboard.render.com/static/srv-abc", serviceDetails: { url: "https://example.org" } } }]);
      if (url.pathname.endsWith("/deploys")) return json(fake.deploys.map((deploy) => ({ deploy, cursor: "x" })));
    }
    if (url.host === "api.github.com") {
      if (url.pathname === "/user") return json({ login: "me" });
      if (url.pathname.endsWith("/commits")) return json(fake.commits);
      if (url.pathname.endsWith("/actions/runs")) return json({ workflow_runs: fake.runs });
      const m = url.pathname.match(/\/compare\/(.+)\.\.\.(.+)$/);
      if (m) return json({ status: fake.compare[`${m[1]}...${m[2]}`] ?? "behind" });
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const commit = (sha: string, msAgo: number, message = `change ${sha}`) => ({
  sha,
  html_url: `https://github.com/o/r/commit/${sha}`,
  commit: { message: `${message}\n\nbody`, committer: { date: iso(msAgo) } },
});
const deploy = (id: string, status: string, sha: string, startedAgo: number, tookMs?: number) => ({
  id,
  status,
  commit: { id: sha, message: `change ${sha}`, createdAt: iso(startedAgo) },
  createdAt: iso(startedAgo),
  finishedAt: tookMs === undefined ? null : iso(startedAgo - tookMs),
});

// ── Setup: one user, one app, GitHub + Render services ──────────────────

let db: DatabaseSync;
let userId: string;
let app: App;
let gh: Connection;
let rn: Connection;

function setUp() {
  db = openDb(":memory:");
  userId = store.createUser(db, "Me").id;
  const ghService = store.createService(db, userId, { type: "github", name: "My GitHub", secretRef: "PERISKOPOS_TEST_GITHUB_KEY", canWrite: false });
  const rnService = store.createService(db, userId, { type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_RENDER_KEY", canWrite: false });
  app = store.createApp(db, userId, { name: "Star-Map", url: "http://star-map.example" });
  gh = store.addConnection(db, app, { type: "github", serviceId: ghService.id, resource: "o/r", settings: { branch: "main", paths: ["apps/star-map"] } });
  rn = store.addConnection(db, app, { type: "render", serviceId: rnService.id, resource: "srv-abc", settings: {} });
  app = store.getApp(db, userId, app.slug)!;
  return { ghService, rnService };
}

describe("render", () => {
  test("deploy phases", () => {
    assert.equal(phaseOf("live"), "live");
    assert.equal(phaseOf("queued"), "in-progress");
    assert.equal(phaseOf("build_in_progress"), "in-progress");
    assert.equal(phaseOf("build_failed"), "failed");
    assert.equal(phaseOf("deactivated"), "other");
  });

  test("too slow: 20 min until 5 deploys to learn from, then 3× the median", () => {
    const d = (min: number): Deploy => ({ id: "d", status: "deactivated", phase: "other", startedAt: iso(H), finishedAt: iso(H - min * 60_000) });
    assert.equal(slowAfterMs([d(4), d(5)]).limitMs, 20 * 60_000);
    const { limitMs, usualMs } = slowAfterMs([d(4), d(5), d(6), d(4), d(5)]);
    assert.equal(usualMs, 5 * 60_000);
    assert.equal(limitMs, 15 * 60_000);
  });

  test("check: live is up, a failed latest deploy is down, a long-running one is down", async () => {
    const { rnService } = setUp();
    const auth = authFor(rnService);
    fake.deploys = [deploy("d2", "live", "bbb", 2 * H, 4 * 60_000)];
    let r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Live: bbb/);

    clearHttpCache();
    fake.deploys = [deploy("d3", "build_failed", "ccc", H, 60_000), deploy("d2", "live", "bbb", 2 * H, 4 * 60_000)];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^Deploy failed \(build failed\): ccc/);

    clearHttpCache();
    fake.deploys = [deploy("d4", "build_in_progress", "ddd", 30 * 60_000), deploy("d2", "live", "bbb", 2 * H, 4 * 60_000)];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^Deploy running for 30 min/);

    clearHttpCache();
    fake.deploys = [deploy("d4", "build_in_progress", "ddd", 2 * 60_000), deploy("d2", "live", "bbb", 2 * H, 4 * 60_000)];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^Deploying ddd/);
  });

  test("check: a running or canceled deploy is judged by the newest one that finished", async () => {
    const { rnService } = setUp();
    const auth = authFor(rnService);
    const failed = deploy("d3", "build_failed", "ccc", H, 60_000);
    const live = deploy("d2", "live", "bbb", 2 * H, 4 * 60_000);

    // A redeploy running (in time) after a failure: deploys aren't working yet.
    fake.deploys = [deploy("d4", "build_in_progress", "ddd", 2 * 60_000), failed, live];
    let r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "down", "no false 'went live' while it runs");
    assert.match(r.detail!, /^Deploy failed \(build failed\): ccc/);
    assert.match(r.summary!, /^Deploying ddd/);

    clearHttpCache();
    fake.deploys = [deploy("d4", "canceled", "ddd", 2 * 60_000, 30_000), failed, live];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "down", "canceling a deploy doesn't fix the failed one");

    clearHttpCache();
    fake.deploys = [deploy("d4", "canceled", "ddd", 2 * 60_000, 30_000), live];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "up");

    clearHttpCache();
    fake.deploys = [deploy("d1", "build_in_progress", "aaa", 60_000)];
    r = await renderIntegration.check!(rn, auth);
    assert.equal(r.state, "unknown", "the first deploy ever has no verdict yet");
  });

  test("a missing key is unknown, with what to do", async () => {
    setUp();
    const svc = store.createService(db, userId, { type: "render", name: "Other", secretRef: "PERISKOPOS_NOT_SET_ANYWHERE", canWrite: false });
    const r = await renderIntegration.check!(rn, authFor(svc));
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /Add PERISKOPOS_NOT_SET_ANYWHERE=/);
  });
});

describe("github", () => {
  test("parse: owner/name, a branch, and clean folder paths", () => {
    const p = github.parse({ resource: "acme/apps", settings: { branch: "main", paths: " /apps/star-map/, packages ,," } });
    assert.deepEqual(p, { resource: "acme/apps", settings: { branch: "main", paths: ["apps/star-map", "packages"] } });
    assert.throws(() => github.parse({ resource: "not a repo", settings: {} }));
    assert.throws(() => github.parse({ resource: "o/r", settings: { paths: "../secrets" } }));
  });

  test("CI: the newest run of each workflow decides", () => {
    const run = (id: number, workflow_id: number, conclusion: string) => ({ id, workflow_id, name: `wf${workflow_id}`, status: "completed", conclusion, head_sha: "a", created_at: iso(id), html_url: "" });
    const latest = latestPerWorkflow([run(1, 1, "success"), run(2, 1, "failure"), run(3, 2, "failure")] as never);
    assert.deepEqual(latest.map((r) => r.id), [1, 3]);
  });

  test("CI: a run still going doesn't clear a failure, and alone gives no verdict", async () => {
    const { ghService } = setUp();
    const run = (id: number, workflow_id: number, status: string, conclusion: string | null, msAgo: number) => ({ id, workflow_id, name: `wf${workflow_id}`, status, conclusion, head_sha: "aaa", created_at: iso(msAgo), html_url: "" });
    fake.commits = [commit("aaa", H)];
    // The fix is being tested: the newest finished run still failed.
    fake.runs = [run(2, 7, "in_progress", null, 60_000), run(1, 7, "completed", "failure", H)];
    let r = await github.check!(gh, authFor(ghService));
    assert.equal(r.state, "down", "no false 'CI is passing again' while the fix runs");

    clearHttpCache();
    fake.runs = [run(2, 7, "queued", null, 60_000), run(1, 7, "completed", "success", H)];
    r = await github.check!(gh, authFor(ghService));
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^CI running/);

    clearHttpCache();
    fake.runs = [run(2, 7, "in_progress", null, 60_000)];
    r = await github.check!(gh, authFor(ghService));
    assert.equal(r.state, "unknown", "a workflow that has only ever been running flips nothing");
  });

  test("listing repos follows the pages, up to a cap", async () => {
    const { ghService } = setUp();
    const pages: number[] = [];
    const repo = (n: number) => ({ full_name: `o/r${n}`, private: false, default_branch: "main", pushed_at: null });
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      assert.equal(url.pathname, "/user/repos");
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      const size = page < 3 ? 100 : 7;
      return json(Array.from({ length: size }, (_, i) => repo((page - 1) * 100 + i)));
    }) as typeof fetch;
    const list = await github.listResources!(authFor(ghService));
    assert.equal(list.length, 207);
    assert.deepEqual(pages, [1, 2, 3]);

    clearHttpCache();
    pages.length = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      pages.push(Number(new URL(String(input)).searchParams.get("page")));
      return json(Array.from({ length: 100 }, (_, i) => repo(i)));
    }) as typeof fetch;
    await github.listResources!(authFor(ghService));
    assert.equal(pages.length, 10, "never more than 10 pages");
  });

  test("check: failing CI is down; no CI is up", async () => {
    const { ghService } = setUp();
    fake.commits = [commit("aaa", H)];
    fake.runs = [{ id: 1, workflow_id: 7, name: "Tests", status: "completed", conclusion: "failure", head_sha: "aaa", created_at: iso(H), html_url: "" }];
    let r = await github.check!(gh, authFor(ghService));
    assert.equal(r.state, "down");
    assert.equal(r.detail, "CI failing on main: Tests");

    clearHttpCache();
    fake.runs = [];
    r = await github.check!(gh, authFor(ghService));
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^No CI · latest change aaa/);
  });
});

describe("is my last push live? (FR-I4)", () => {
  test("live when the live deploy contains the latest change", async () => {
    setUp();
    fake.commits = [commit("aaa", 2 * H)];
    fake.deploys = [deploy("d1", "live", "bbb", H, 60_000)];
    fake.compare["aaa...bbb"] = "ahead"; // bbb is newer and contains aaa
    const d = await deployState(db, app);
    assert.equal(d?.state, "live");
    assert.equal(d?.live?.url, "https://github.com/o/r/commit/bbb");
  });

  test("deploying when a running deploy contains it", async () => {
    setUp();
    fake.commits = [commit("ccc", 60_000)];
    fake.deploys = [deploy("d2", "build_in_progress", "ccc", 30_000), deploy("d1", "live", "bbb", H, 60_000)];
    const d = await deployState(db, app);
    assert.equal(d?.state, "deploying");
  });

  test("not deployed when nothing live or running contains it", async () => {
    setUp();
    fake.commits = [commit("ccc", 60_000)];
    fake.deploys = [deploy("d1", "live", "bbb", H, 60_000)];
    fake.compare["ccc...bbb"] = "behind";
    const d = await deployState(db, app);
    assert.equal(d?.state, "not-deployed");
    assert.equal(d?.latest?.message, "change ccc");
  });

  test("no answer without both a source and a host", async () => {
    setUp();
    store.deleteConnection(db, app, rn.id);
    assert.equal(await deployState(db, store.getApp(db, userId, app.slug)!), undefined);
  });
});

describe("deploy and CI incidents", () => {
  test("a failed deploy opens a deploy incident: 'needs attention', not downtime", async () => {
    setUp();
    const notices: Notice[] = [];
    const watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true });
    fake.deploys = [deploy("d3", "build_failed", "ccc", H, 60_000)];
    await watcher.checkConnection(app, rn);
    clearHttpCache();
    await watcher.checkConnection(app, rn);
    const incident = history.openIncidentFor(db, rn.id);
    assert.equal(incident?.kind, "deploy");
    assert.deepEqual(notices.map((n) => n.title), ["Star-Map: a deploy failed"]);

    // Deploy incidents never count against uptime: an hour of one, in two
    // hours watched, leaves it at 100%.
    db.prepare("UPDATE apps SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 3 * H).toISOString(), app.id);
    const id = history.startPeriod(db, Date.now() - 2 * H);
    history.heartbeat(db, id, Date.now());
    const uptime = () => history.uptime(db, app.id, Date.now() - 2 * H, Date.now()).uptimePct!;
    db.prepare("UPDATE incidents SET started_at = ? WHERE id = ?").run(iso(H), incident!.id);
    assert.equal(uptime(), 100);
    // The same hour as an outage would count: the measure does see it.
    db.prepare("UPDATE incidents SET kind = 'outage' WHERE id = ?").run(incident!.id);
    assert.ok(Math.abs(uptime() - 50) < 1, `${uptime()}`);
    db.prepare("UPDATE incidents SET kind = 'deploy' WHERE id = ?").run(incident!.id);

    clearHttpCache();
    fake.deploys = [deploy("d4", "live", "ddd", 60_000, 30_000), ...fake.deploys];
    await watcher.checkConnection(app, rn);
    assert.equal(notices.at(-1)?.title, "Star-Map: deploys are working again");
    assert.equal(history.openIncidentFor(db, rn.id), undefined);
  });
});

describe("services API (FR-S1–S5)", () => {
  const TOKEN = "t".repeat(43);
  const BASE = "http://localhost:4100";
  let gc: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    const distDir = tempDir("periskopos-web-");
    writeFileSync(path.join(distDir, "index.html"), "");
    gc = createApp({ db, token: TOKEN, port: 4100, distDir });
  });

  const call = async (method: string, p: string, body?: unknown) => {
    const res = await gc.request(`${BASE}/api${p}`, {
      method,
      headers: { "x-periskopos-token": TOKEN, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: res.status === 204 ? undefined : await res.json() };
  };

  test("connect, test, list resources, connect an app, remove", async () => {
    await call("POST", "/setup", { name: "Me" });
    // Render needs a key variable; GitHub can use gh.
    assert.equal((await call("POST", "/services", { type: "render", name: "R" })).status, 400);
    assert.equal((await call("POST", "/services", { type: "render", name: "R", secretRef: "lower_case" })).status, 400);
    const created = await call("POST", "/services", { type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_RENDER_KEY" });
    assert.equal(created.status, 201);
    const svc = created.body.service as ServiceView;
    assert.equal(svc.keyState, "set");
    assert.equal(svc.canWrite, false);
    assert.equal(JSON.stringify(created.body).includes("rnd_test"), false, "the key itself is never returned");

    assert.deepEqual((await call("POST", `/services/${svc.id}/test`)).body, { ok: true, message: "Connected to Me" });
    const { resources } = (await call("GET", `/services/${svc.id}/resources`)).body;
    assert.equal(resources[0].id, "srv-abc");

    await call("POST", "/apps", { name: "Star-Map", url: "http://star-map.example" });
    // The service must match the integration.
    assert.equal((await call("POST", "/apps/star-map/connections", { type: "github", serviceId: svc.id, resource: "o/r" })).status, 400);
    const conn = await call("POST", "/apps/star-map/connections", { type: "render", serviceId: svc.id, resource: "srv-abc", settings: resources[0].settings });
    assert.equal(conn.status, 201);

    const listed = (await call("GET", "/services")).body.services as ServiceView[];
    assert.deepEqual(listed[0].apps, [{ slug: "star-map", name: "Star-Map" }]);

    fake.deploys = [deploy("d1", "live", "bbb", H, 60_000)];
    const { status } = (await call("GET", "/apps/star-map/status")).body as { status: AppStatus };
    assert.ok(Object.values(status.checks).some((c) => c.summary?.startsWith("Live: bbb")));

    const details = (await call("GET", `/apps/star-map/connections/${conn.body.connection.id}/details`)).body.details;
    assert.equal(details.deploys[0].url, "https://dashboard.render.com/static/srv-abc/deploys/d1");

    // Removing the service removes its connections (FR-S4).
    assert.equal((await call("DELETE", `/services/${svc.id}`)).status, 204);
    const { app: after } = (await call("GET", "/apps/star-map")).body as { app: App };
    assert.deepEqual(after.connections.map((c) => c.type), ["site"]);
  });
});

describe("commit messages", () => {
  test("the first line, and a long one ends in … rather than mid-word", async () => {
    const { firstLine } = await import("../server/integrations/github.ts");
    assert.equal(firstLine("Fix the thing\n\nLong body"), "Fix the thing");
    const long = `moon-base: ${"simulation fixes from the scenes audit ".repeat(4)}`;
    const cut = firstLine(long);
    assert.equal(cut.length, 120);
    assert.ok(cut.endsWith("…"));
    assert.equal(firstLine("x".repeat(120)), "x".repeat(120), "exactly 120 stays whole");
  });
});
