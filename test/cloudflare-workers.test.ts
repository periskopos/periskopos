import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import { deployState, fromBuildChecks } from "../server/deploys.ts";
import * as history from "../server/history.ts";
import { clearHttpCache } from "../server/http.ts";
import { cloudflareIntegration as cf, kindOf } from "../server/integrations/cloudflare.ts";
import { github } from "../server/integrations/github.ts";
import type { BuildCheck } from "../server/integrations/types.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { authFor } from "../server/keys/secrets.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";

// Cloudflare Workers built by Workers Builds: the Worker's deployments come
// from Cloudflare, the commit and the build's outcome from GitHub's check
// runs. Everything here is a fake; nothing reaches the network.

process.env.PERISKOPOS_TEST_CF_KEY = "cf_test";
process.env.PERISKOPOS_TEST_GITHUB_KEY = "ghp_test";

const ACCOUNT = "a".repeat(32);
const CF = `/client/v4/accounts/${ACCOUNT}`;
const H = 3_600_000;
const BUILD = "3f2a67cc-fa0d-4e59-836f-4d4265906e54";
const BUILD_PAGE = `https://dash.cloudflare.com/${"a".repeat(32)}/workers/services/view/star-map/production/builds/${BUILD}`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type GhCommit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } } };
type Fake = {
  projects: unknown[];
  workers: unknown[] | 403;
  deployments: unknown[] | 403;
  // Commits on the branch, by `path` filter ("" = the whole branch).
  commits: Record<string, GhCommit[]>;
  // Check runs, by commit.
  checks: Record<string, unknown[]>;
  // Files changed between two commits, by "base...head".
  compare: Record<string, string[]>;
  // A Workers Build's log, by page cursor ("" = the first page).
  buildLog: Record<string, unknown> | 403;
  calls: string[];
};
let fake: Fake;
const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (result: unknown) => json({ success: true, result, errors: [] });
const refused = () => json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 403);

beforeEach(() => {
  clearHttpCache();
  fake = { projects: [], workers: [], deployments: [], commits: {}, checks: {}, compare: {}, buildLog: {}, calls: [] };
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    fake.calls.push(`${init?.method ?? "GET"} ${url.host}${url.pathname}${url.search}`);
    assert.equal(init?.method ?? "GET", "GET", "nothing here changes anything");
    if (url.host === "api.cloudflare.com") {
      if (url.pathname === "/client/v4/accounts") return ok([{ id: ACCOUNT, name: "acme.com" }]);
      if (url.pathname === `${CF}/pages/projects`) return ok(fake.projects);
      if (url.pathname === `${CF}/workers/scripts`) return fake.workers === 403 ? refused() : ok(fake.workers);
      if (url.pathname === `${CF}/workers/domains`) {
        return ok([
          { hostname: "example.org", service: "star-map", environment: "production" },
          { hostname: "other.example", service: "something-else", environment: "production" },
        ]);
      }
      if (url.pathname === `${CF}/workers/scripts/star-map/deployments`) {
        return fake.deployments === 403 ? refused() : ok({ deployments: fake.deployments });
      }
      const v = url.pathname.match(/\/workers\/scripts\/star-map\/versions\/(.+)$/);
      if (v) return ok({ id: v[1], number: 42, metadata: { created_on: iso(2 * H), source: "wrangler" } });
      if (url.pathname === `${CF}/builds/builds/${BUILD}/logs`) {
        return fake.buildLog === 403 ? refused() : ok(fake.buildLog[url.searchParams.get("cursor") ?? ""]);
      }
    }
    if (url.host === "api.github.com") {
      if (url.pathname === "/repos/acme/apps/commits") return json(fake.commits[url.searchParams.get("path") ?? ""] ?? []);
      const c = url.pathname.match(/^\/repos\/acme\/apps\/commits\/(\w+)\/check-runs$/);
      if (c) return json({ total_count: (fake.checks[c[1]] ?? []).length, check_runs: fake.checks[c[1]] ?? [] });
      if (url.pathname === "/repos/acme/apps/actions/runs") return json({ workflow_runs: [] });
      const cmp = url.pathname.match(/^\/repos\/acme\/apps\/compare\/(.+)$/);
      if (cmp && fake.compare[cmp[1]]) return json({ status: "ahead", files: fake.compare[cmp[1]].map((filename) => ({ filename })) });
    }
    return json({ success: false, errors: [{ message: "Not Found" }] }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const commit = (sha: string, msAgo: number): GhCommit => ({
  sha,
  html_url: `https://github.com/acme/apps/commit/${sha}`,
  commit: { message: `change ${sha}\n\nbody`, committer: { date: iso(msAgo) } },
});
const check = (sha: string, status: string, conclusion: string | null, name = "Workers Builds: star-map", completedMsAgo?: number) => ({
  id: sha.length,
  name,
  head_sha: sha,
  status,
  conclusion,
  ...(completedMsAgo !== undefined ? { completed_at: iso(completedMsAgo) } : {}),
  details_url: `https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/star-map/production/builds/${sha}`,
  html_url: `https://github.com/acme/apps/runs/1`,
  app: { slug: "cloudflare-workers-and-pages" },
});
const deployment = (id: string, msAgo: number, versions = [{ version_id: `v-${id}`, percentage: 100 }]) => ({
  id,
  source: "wrangler",
  strategy: "percentage",
  annotations: { "workers/triggered_by": "deployment" },
  versions,
  created_on: iso(msAgo),
});

// ── Setup: an app built from a monorepo folder, served by a Worker ──────

let db: DatabaseSync;
let userId: string;
let app: App;
let gh: Connection;
let worker: Connection;

function setUp() {
  db = openDb(":memory:");
  userId = store.createUser(db, "Me").id;
  const ghService = store.createService(db, userId, { type: "github", name: "My GitHub", secretRef: "PERISKOPOS_TEST_GITHUB_KEY", canWrite: false });
  const cfService = store.createService(db, userId, { type: "cloudflare", name: "My Cloudflare", secretRef: "PERISKOPOS_TEST_CF_KEY", canWrite: false });
  app = store.createApp(db, userId, { name: "Star-Map", url: "http://star-map.example" });
  gh = store.addConnection(db, app, { type: "github", serviceId: ghService.id, resource: "acme/apps", settings: { branch: "main", paths: ["apps/star-map"] } });
  worker = store.addConnection(db, app, {
    type: "cloudflare",
    serviceId: cfService.id,
    resource: "star-map",
    settings: cf.parse({ resource: "worker:star-map", settings: { kind: "worker", accountId: ACCOUNT } }).settings,
  });
  app = store.getApp(db, userId, app.slug)!;
  return { ghAuth: authFor(ghService), cfAuth: authFor(cfService) };
}

describe("cloudflare: Pages projects and Workers", () => {
  test("a Worker is listed next to a Pages project, labelled, with its custom domain", async () => {
    const { cfAuth } = setUp();
    fake.projects = [{ name: "old-site", subdomain: "old-site.pages.dev" }];
    fake.workers = [{ id: "star-map", has_assets: true }];
    const list = await cf.listResources!(cfAuth);
    assert.deepEqual(list, [
      { id: "old-site", label: "old-site", detail: "Pages · acme.com · old-site.pages.dev", settings: { kind: "pages", name: "old-site", accountId: ACCOUNT } },
      { id: "worker:star-map", label: "star-map", detail: "Worker · acme.com · example.org", settings: { kind: "worker", name: "star-map", accountId: ACCOUNT } },
    ]);
  });

  test("parse: a picked Worker keeps its kind; old connections without one are Pages", () => {
    assert.deepEqual(cf.parse({ resource: "worker:star-map", settings: { kind: "worker", name: "star-map", accountId: ACCOUNT } }), {
      resource: "star-map",
      settings: { kind: "worker", accountId: ACCOUNT, name: "star-map" },
    });
    assert.throws(() => cf.parse({ resource: "worker:bad name", settings: { kind: "worker", accountId: ACCOUNT } }));
    assert.equal(kindOf({ settings: { accountId: ACCOUNT, name: "star-map" } }), "pages");
    assert.equal(kindOf({ settings: { kind: "worker" } }), "worker");
    assert.equal(cf.buildCheckName!({ id: "c", appId: "a", type: "cloudflare", resource: "star-map", settings: { accountId: ACCOUNT } }), undefined);
    assert.deepEqual(cf.actions!({ id: "c", appId: "a", type: "cloudflare", resource: "star-map", settings: { accountId: ACCOUNT } }).map((a) => a.id), ["redeploy"]);
  });

  test("listing: Workers refused (403) still lists Pages, and the empty case names the permission", async () => {
    const { cfAuth } = setUp();
    fake.workers = 403;
    fake.projects = [{ name: "old-site" }];
    assert.deepEqual((await cf.listResources!(cfAuth)).map((r) => r.id), ["old-site"]);

    clearHttpCache();
    fake.projects = [];
    await assert.rejects(cf.listResources!(cfAuth), /No Cloudflare Pages projects or Workers in acme.com.*Account → Workers Scripts → Read/s);

    clearHttpCache();
    fake.workers = [];
    await assert.rejects(cf.listResources!(cfAuth), (err: Error) => /No Cloudflare Pages projects or Workers/.test(err.message) && !/Workers Scripts/.test(err.message));
  });

  test("deploys: the newest deployment is live, older ones superseded, no commit from Cloudflare", async () => {
    const { cfAuth } = setUp();
    fake.deployments = [deployment("d3", 2 * H), deployment("d2", 5 * H), deployment("d1", 30 * H)];
    const list = await cf.deploys!(worker, cfAuth);
    assert.deepEqual(list.map((d) => [d.id, d.status, d.phase]), [["d3", "live", "live"], ["d2", "superseded", "other"], ["d1", "superseded", "other"]]);
    assert.equal(list[0].commit, undefined);

    const details = await cf.details!(worker, cfAuth);
    assert.ok(details.shape === "deploys");
    assert.deepEqual(details.link, { url: `https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/star-map/production`, label: "All in Cloudflare" });
    assert.equal(details.deploys.length, 3);
  });

  test("check: up, live since when and which version; no deploy is up with nothing to say", async () => {
    const { cfAuth } = setUp();
    fake.deployments = [deployment("d3", 2 * H), deployment("d2", 5 * H)];
    const r = await cf.check!(worker, cfAuth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "Live since 2 h ago · version 42");

    clearHttpCache();
    fake.deployments = [];
    assert.deepEqual((await cf.check!(worker, cfAuth)).summary, "No deploys yet");
  });

  test("check: a 403 is unknown, naming the permission to add", async () => {
    const { cfAuth } = setUp();
    fake.deployments = 403;
    const r = await cf.check!(worker, cfAuth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /\(403\).*Account → Workers Scripts → Read/);
  });

  test("Workers offer no Redeploy, and name the GitHub check of their builds", async () => {
    const { cfAuth } = setUp();
    assert.deepEqual(cf.actions!(worker), []);
    await assert.rejects(cf.run!(worker, cfAuth, "redeploy"));
    assert.equal(cf.buildCheckName!(worker), "Workers Builds: star-map");
  });
});

describe("is my last push live? A Worker, from GitHub's build checks", () => {
  test("live: the newest commit's build succeeded; a newer commit outside the paths doesn't count", async () => {
    setUp();
    // The branch head touches another app; only apps/star-map commits count.
    fake.commits[""] = [commit("zzz0000", 60_000), commit("bbb1111", H)];
    fake.commits["apps/star-map"] = [commit("bbb1111", H), commit("aaa2222", 3 * H)];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success"), check("bbb1111", "completed", "success", "check")];
    fake.checks["aaa2222"] = [check("aaa2222", "completed", "success")];
    const d = await deployState(db, app);
    assert.equal(d?.state, "live");
    assert.equal(d?.latest?.sha, "bbb1111");
    assert.equal(d?.live?.url, "https://github.com/acme/apps/commit/bbb1111");
    assert.equal(fake.calls.some((c) => c.includes("zzz0000")), false, "a commit outside the paths is never looked at");
    // It stopped at the newest success: one check-runs call.
    assert.equal(fake.calls.filter((c) => c.endsWith("/check-runs?filter=all&per_page=100")).length, 1);
    assert.equal(fake.calls.some((c) => c.includes("api.cloudflare.com")), false, "Cloudflare isn't asked which commit it serves");
  });

  test("deploying: a newer build is still going", async () => {
    setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", 3 * 60_000), commit("bbb1111", H)];
    fake.checks["ccc3333"] = [check("ccc3333", "in_progress", null)];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success")];
    const d = await deployState(db, app);
    assert.equal(d?.state, "deploying");
    assert.equal(d?.live?.sha, "bbb1111");
    assert.equal(d?.detail, "Cloudflare is building ccc3333");
  });

  test("not deployed: the newest build failed", async () => {
    setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", H), commit("bbb1111", 2 * H)];
    fake.checks["ccc3333"] = [check("ccc3333", "completed", "failure")];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success")];
    const d = await deployState(db, app);
    assert.equal(d?.state, "not-deployed");
    assert.equal(d?.detail, "Cloudflare's build of ccc3333 failed");
    assert.equal(d?.live?.sha, "bbb1111");
  });

  // A real case (Star-Map here), 27 Oct 2026: Cloudflare's builds couldn't clone the
  // repository, so the release went out with `wrangler deploy`, and empty
  // commits pushed after it to retry the build failed too.
  test("live: deployed directly after the builds failed, and the newer commits change nothing", async () => {
    setUp();
    fake.commits["apps/star-map"] = [commit("eee5555", H), commit("ddd4444", 3 * H), commit("ccc3333", 4 * H), commit("bbb1111", 10 * H)];
    fake.checks["eee5555"] = [check("eee5555", "completed", "failure")];
    fake.checks["ddd4444"] = [check("ddd4444", "completed", "failure")];
    fake.checks["ccc3333"] = [check("ccc3333", "completed", "failure")];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success", undefined, 10 * H - 60_000)];
    fake.deployments = [deployment("direct", 2 * H), deployment("built", 10 * H - 30_000)];
    fake.compare["ddd4444...eee5555"] = []; // an empty commit
    const d = await deployState(db, app);
    assert.equal(d?.state, "live");
    assert.equal(d?.live?.sha, "ddd4444", "the newest commit when it was deployed");
    assert.equal(d?.detail, "Deployed directly, not by Cloudflare's build");
  });

  test("not deployed: deployed directly, but the latest change has new files", async () => {
    setUp();
    fake.commits["apps/star-map"] = [commit("eee5555", H), commit("ddd4444", 3 * H), commit("bbb1111", 10 * H)];
    fake.checks["eee5555"] = [check("eee5555", "completed", "failure")];
    fake.checks["ddd4444"] = [check("ddd4444", "completed", "failure")];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success", undefined, 10 * H - 60_000)];
    fake.deployments = [deployment("direct", 2 * H)];
    fake.compare["ddd4444...eee5555"] = ["apps/star-map/index.html", "README.md"];
    const d = await deployState(db, app);
    assert.equal(d?.state, "not-deployed");
    assert.equal(d?.detail, "Cloudflare's build of eee5555 failed");
  });

  test("not deployed: the newest deployment is the last good build's own, so nothing was deployed directly", async () => {
    setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", H), commit("bbb1111", 2 * H)];
    fake.checks["ccc3333"] = [check("ccc3333", "completed", "failure")];
    fake.checks["bbb1111"] = [check("bbb1111", "completed", "success", undefined, 2 * H - 60_000)];
    fake.deployments = [deployment("built", 2 * H - 30_000)];
    fake.compare["bbb1111...ccc3333"] = [];
    const d = await deployState(db, app);
    assert.equal(d?.state, "not-deployed");
    assert.equal(fake.calls.some((c) => c.includes("/compare/")), false, "no direct deploy, so no comparing");
  });

  test("a change with no build yet: waiting at first, not deployed later", () => {
    const at = (msAgo: number) => ({ sha: "ddd4444", message: "m", at: iso(msAgo) });
    const built: BuildCheck[] = [{ sha: "bbb1111", message: "m", at: iso(H), status: "completed", conclusion: "success", url: "u" }];
    assert.equal(fromBuildChecks(at(60_000), built, () => undefined).state, "deploying");
    const later = fromBuildChecks(at(H / 2), built, () => undefined);
    assert.equal(later.state, "not-deployed");
    assert.equal(later.detail, "Cloudflare hasn't built ddd4444");
    assert.equal(fromBuildChecks(at(H / 2), [], () => undefined).state, "unknown");
  });
});

describe("a failed Workers Build's log, read with Workers Builds Configuration: Read", () => {
  // A real case (Star-Map here), 27 Oct 2026: the log said why in one line.
  test("the end of the log, every page, each line with its time", async () => {
    const { cfAuth } = setUp();
    const t = Date.parse("2026-10-27T07:11:15Z") / 1000;
    fake.buildLog = {
      "": { lines: [[t, "Initializing build environment..."], [t + 10, "Success: Finished initializing build environment"]], cursor: "p2", truncated: false },
      p2: { lines: [[t + 11, "Cloning repository..."], [t + 11, "Failed: error occurred while fetching repository"]], truncated: false },
    };
    const r = await cf.buildLog!(worker, cfAuth, BUILD_PAGE);
    assert.deepEqual(r, {
      log: [
        "2026-10-27T07:11:15.000Z\tInitializing build environment...",
        "2026-10-27T07:11:25.000Z\tSuccess: Finished initializing build environment",
        "2026-10-27T07:11:26.000Z\tCloning repository...",
        "2026-10-27T07:11:26.000Z\tFailed: error occurred while fetching repository",
      ].join("\n"),
    });
  });

  test("a token without Workers Builds Configuration says which permission to add", async () => {
    const { cfAuth } = setUp();
    fake.buildLog = 403;
    const r = await cf.buildLog!(worker, cfAuth, BUILD_PAGE);
    assert.ok(r && "logProblem" in r);
    assert.match(r.logProblem, /\(403\).*Account → Workers Builds Configuration → Read/);
  });

  test("only this Worker's own builds, in its own account", async () => {
    const { cfAuth } = setUp();
    assert.equal(await cf.buildLog!(worker, cfAuth, BUILD_PAGE.replace("/star-map/", "/other-worker/")), undefined);
    assert.equal(await cf.buildLog!(worker, cfAuth, BUILD_PAGE.replace("a".repeat(32), "b".repeat(32))), undefined);
    assert.equal(await cf.buildLog!(worker, cfAuth, "https://github.com/acme/apps/runs/1"), undefined);
    assert.equal(fake.calls.length, 0, "nothing asked of Cloudflare");
  });
});

describe("a failed Workers Build notifies, as failing CI on GitHub", () => {
  test("GitHub's check is down with which build failed; a build still running doesn't clear it", async () => {
    const { ghAuth } = setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", H), commit("bbb1111", 2 * H)];
    fake.checks["ccc3333"] = [check("ccc3333", "completed", "failure")];
    let r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Cloudflare's build of star-map failed on ccc3333");
    assert.match(r.summary!, /^Cloudflare build failed/);
    // One click to why: the failed build's page on Cloudflare.
    assert.deepEqual(r.link, { url: `https://dash.cloudflare.com/${ACCOUNT}/workers/services/view/star-map/production/builds/ccc3333`, label: "Open the failed build on Cloudflare" });

    // A fix is building: the newest finished build still failed.
    clearHttpCache();
    fake.commits["apps/star-map"] = [commit("ddd4444", 60_000), ...fake.commits["apps/star-map"]];
    fake.checks["ddd4444"] = [check("ddd4444", "queued", null)];
    r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "down");

    clearHttpCache();
    fake.checks["ddd4444"] = [check("ddd4444", "completed", "success")];
    r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "up");
  });

  // acme/apps 3de65c7: built twice. The first build went live (its run
  // names a version); the second ended as a failure, deploying nothing, and
  // is the latest run GitHub shows by default. Each build also leaves its
  // start behind as a run that's never closed.
  test("a commit built twice, live from the first build, isn't a failed build", async () => {
    const { ghAuth } = setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", H), commit("bbb1111", 2 * H)];
    fake.checks["ccc3333"] = [
      check("ccc3333", "completed", "failure"),
      check("ccc3333", "in_progress", null),
      check("ccc3333", "completed", "success"),
      check("ccc3333", "in_progress", null),
    ];
    const r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "up");
    assert.ok(fake.calls.some((c) => c.includes("/check-runs?filter=all")), "every run is asked for, not just the latest");

    const d = await deployState(db, app);
    assert.equal(d?.state, "live");
    assert.equal(d?.live?.sha, "ccc3333");
  });

  test("a build's start left open doesn't hide that the build failed", async () => {
    const { ghAuth } = setUp();
    fake.commits["apps/star-map"] = [commit("ccc3333", H)];
    fake.checks["ccc3333"] = [check("ccc3333", "in_progress", null), check("ccc3333", "completed", "failure")];
    const r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Cloudflare's build of star-map failed on ccc3333");
  });

  test("a repo Cloudflare doesn't build costs one extra call and changes nothing", async () => {
    const { ghAuth } = setUp();
    fake.commits["apps/star-map"] = [commit("bbb1111", H)];
    const r = await github.check!(gh, ghAuth);
    assert.equal(r.state, "up");
    assert.equal(fake.calls.filter((c) => c.includes("/check-runs")).length, 1);
  });

  test("the watcher opens a 'ci' incident (not an outage) and says a Cloudflare build failed", async () => {
    setUp();
    const notices: Notice[] = [];
    const watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true });
    fake.commits["apps/star-map"] = [commit("ccc3333", H)];
    fake.checks["ccc3333"] = [check("ccc3333", "completed", "failure")];
    await watcher.checkConnection(app, gh);
    clearHttpCache();
    await watcher.checkConnection(app, gh);
    assert.equal(history.openIncidentFor(db, gh.id)?.kind, "ci");
    // The link is kept with the result, for the Checks list.
    assert.ok(history.latestCheck(db, gh.id)?.link?.url.endsWith("/builds/ccc3333"));
    assert.deepEqual(notices.map((n) => [n.title, n.body]), [["Star-Map: a Cloudflare build failed", "Cloudflare's build of star-map failed on ccc3333"]]);
  });
});
