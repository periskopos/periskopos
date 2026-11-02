import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { CommitsDetails, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { gitlab, logTail, tokenExpiry } from "../server/integrations/gitlab.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// GitLab as a source: commits and pipelines on gitlab.com. Everything here
// is a fake; nothing reaches the network.

const realFetch = globalThis.fetch;
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

type Pipeline = { id: number; iid: number; name?: string | null; status: string; ref: string; sha: string; created_at: string; web_url: string };
let pipelines: Pipeline[];
let projectPages: number;
let tokenSelf: { status: number; body: unknown };
let refuse: { status: number; body: unknown } | undefined;
let compareCommits: unknown[];
const calls: string[] = [];

const pipe = (id: number, status: string, sha = "aaa111"): Pipeline => ({
  id,
  iid: id - 1000,
  status,
  ref: "main",
  sha,
  created_at: iso(HOUR),
  web_url: `https://gitlab.com/acme/star-map/-/pipelines/${id}`,
});

beforeEach(() => {
  clearHttpCache();
  pipelines = [pipe(1002, "success")];
  projectPages = 1;
  tokenSelf = { status: 200, body: { id: 1, name: "Periskopos", scopes: ["read_api"], active: true, revoked: false, expires_at: "2027-03-01" } };
  refuse = undefined;
  compareCommits = [];
  calls.length = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    assert.equal(init?.method ?? "GET", "GET", "only ever reads");
    assert.equal(url.host, "gitlab.com");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer glpat-test");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (refuse) return json(refuse.body, refuse.status);
    const p = url.pathname.replace(/^\/api\/v4/, "");
    if (p === "/user") return json({ id: 7, username: "star-map-dev", name: "Star-Map Dev" });
    if (p === "/personal_access_tokens/self") return json(tokenSelf.body, tokenSelf.status);
    if (p === "/projects") {
      const page = Number(url.searchParams.get("page"));
      const size = page < projectPages ? 100 : 2;
      return json(
        Array.from({ length: size }, (_, i) => ({
          id: page * 1000 + i,
          path_with_namespace: i === 0 ? "acme/web/star-map" : `acme/p${page}-${i}`,
          default_branch: i === 1 ? null : "trunk",
          visibility: "private",
          last_activity_at: iso(2 * HOUR),
        })),
      );
    }
    // The project by its numeric id (42) or by its encoded path.
    const m = p.match(/^\/projects\/(42|acme%2Fstar-map)(\/.*)$/);
    if (!m) return json({ message: "404 Project Not Found" }, 404);
    const rest = m[2]!;
    if (rest === "/repository/commits") {
      const path = url.searchParams.get("path");
      const all = [
        { id: "aaa111", title: "Fix the map", message: "Fix the map\n\nlong body", committed_date: iso(HOUR), web_url: "https://gitlab.com/acme/star-map/-/commit/aaa111" },
        { id: "bbb222", title: "Add stars", message: "Add stars", committed_date: iso(3 * HOUR), web_url: "https://gitlab.com/acme/star-map/-/commit/bbb222" },
      ];
      const list = path === "docs" ? all.slice(1) : all;
      return json(list.slice(0, Number(url.searchParams.get("per_page"))));
    }
    if (rest === "/pipelines") return json(pipelines);
    if (rest === "/repository/compare") return json({ commit: null, commits: compareCommits, diffs: [], compare_timeout: false, compare_same_ref: false });
    const jobs = rest.match(/^\/pipelines\/(\d+)\/jobs$/);
    if (jobs) {
      return json([
        { id: 501, name: "unit", stage: "test", status: "failed", allow_failure: false, failure_reason: "script_failure", web_url: "https://gitlab.com/acme/star-map/-/jobs/501" },
        { id: 502, name: "lint", stage: "test", status: "failed", allow_failure: true, failure_reason: "script_failure", web_url: "https://gitlab.com/acme/star-map/-/jobs/502" },
      ]);
    }
    if (rest === "/jobs/501/trace") {
      return new Response(
        "section_start:1700000000:step_script\r\x1b[0K\x1b[32;1mRunning tests\x1b[0;m\n1 failing\nAssertionError: stars != 3\nsection_end:1700000001:step_script\r\x1b[0K\nERROR: Job failed: exit code 1\n\n",
        { status: 200, headers: { "content-type": "text/plain" } },
      );
    }
    return json({ message: "404 Not Found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "gitlab", name: "My GitLab", canWrite: false }, token: async () => "glpat-test" } as ServiceAuth;
const conn = (settings: Record<string, unknown> = { projectId: 42, branch: "main", paths: [] }): Connection => ({
  id: "c",
  appId: "a",
  type: "gitlab",
  serviceId: "s",
  resource: "acme/star-map",
  settings,
});

describe("GitLab: connecting a project", () => {
  test("parse: group paths, branch, folders and the numeric id", () => {
    const p = gitlab.parse({ resource: "acme/web/star-map", settings: { projectId: "42", branch: "trunk", paths: " /apps/star-map/, docs ,," } });
    assert.deepEqual(p, { resource: "acme/web/star-map", settings: { projectId: 42, branch: "trunk", paths: ["apps/star-map", "docs"] } });
    assert.deepEqual(gitlab.parse({ resource: "acme/star-map", settings: {} }).settings, { branch: "main", paths: [] }, "typed by hand: the path is enough");
    assert.throws(() => gitlab.parse({ resource: "star-map", settings: {} }), /group\/name/);
    assert.throws(() => gitlab.parse({ resource: "acme/star map", settings: {} }));
    assert.throws(() => gitlab.parse({ resource: "", settings: {} }), /required/);
    assert.throws(() => gitlab.parse({ resource: "acme/x", settings: { branch: "a..b" } }), /branch/);
    assert.throws(() => gitlab.parse({ resource: "acme/x", settings: { paths: "../secrets" } }), /inside the project/);
    assert.throws(() => gitlab.parse({ resource: "acme/x", settings: { projectId: "-3" } }), /Project ID/);
  });

  test("testService says who it's connected as, and when the token expires", async () => {
    assert.deepEqual(await gitlab.testService!(auth), { message: "Connected as star-map-dev", expiresAt: "2027-03-01T00:00:00.000Z" });
    tokenSelf = { status: 200, body: { expires_at: null } };
    assert.deepEqual(await gitlab.testService!(auth), { message: "Connected as star-map-dev" }, "a token without expiry");
    tokenSelf = { status: 404, body: { message: "404 Not Found" } };
    assert.deepEqual(await gitlab.testService!(auth), { message: "Connected as star-map-dev" }, "not a personal access token: still connected");
    assert.equal(tokenExpiry("soon"), undefined);
  });

  test("a rejected key says so (401)", async () => {
    refuse = { status: 401, body: { message: "401 Unauthorized" } };
    await assert.rejects(gitlab.testService!(auth), /GitLab rejected the key \(401\)/);
  });

  test("listResources: member projects, newest activity first, paged, with id and default branch", async () => {
    projectPages = 2;
    const list = await gitlab.listResources!(auth);
    assert.equal(list.length, 102);
    assert.deepEqual(list[0], { id: "acme/web/star-map", label: "acme/web/star-map", detail: "private · active 2 h ago", settings: { projectId: 1000, branch: "trunk", paths: [] } });
    assert.equal(list[1]!.settings?.branch, "main", "an empty project has no default branch");
    const listCalls = calls.filter((c) => c.includes("/projects?"));
    assert.equal(listCalls.length, 2, "stops at the short page");
    assert.match(listCalls[0]!, /membership=true/);
    assert.match(listCalls[0]!, /per_page=100&page=1/);
    assert.equal(gitlab.resourceName!(list[0]!), "star-map");
  });
});

describe("GitLab: commits and pipelines", () => {
  test("check: success is up", async () => {
    const r = await gitlab.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^CI passing · latest change aaa111 1 h ago$/);
    assert.ok(calls.some((c) => c === "GET /api/v4/projects/42/pipelines?ref=main&per_page=30"), "by numeric id, on the branch");
  });

  test("check: the newest finished pipeline failed is down, with a link to it", async () => {
    pipelines = [pipe(1003, "failed"), pipe(1002, "success")];
    const r = await gitlab.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "CI failing on main: pipeline #3");
    assert.deepEqual(r.link, { url: "https://gitlab.com/acme/star-map/-/pipelines/1003", label: "Open the failed pipeline on GitLab" });
    assert.deepEqual(gitlab.notice!("down", "Star Map", r.detail!, 0), { title: "Star Map: CI is failing", body: "CI failing on main: pipeline #3" });
  });

  test("check: a running pipeline neither clears a failure nor hides one", async () => {
    pipelines = [pipe(1004, "running"), pipe(1003, "failed")];
    assert.equal((await gitlab.check!(conn(), auth)).state, "down");
    clearHttpCache();
    pipelines = [pipe(1004, "pending"), pipe(1003, "success")];
    const r = await gitlab.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^CI running/);
    clearHttpCache();
    pipelines = [pipe(1004, "running")];
    assert.equal((await gitlab.check!(conn(), auth)).state, "unknown", "nothing finished yet: no verdict");
    clearHttpCache();
    pipelines = [];
    assert.match((await gitlab.check!(conn(), auth)).summary!, /^No CI/);
  });

  test("check: a project it can't see is unknown, in words (404)", async () => {
    const r = await gitlab.check!({ ...conn({ branch: "main" }), resource: "acme/gone" }, auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, /GitLab doesn't know this resource \(404\)/);
    assert.ok(calls.some((c) => c.startsWith("GET /api/v4/projects/acme%2Fgone/")), "without an id, the encoded path");
    assert.equal((await gitlab.check!(conn(), undefined)).detail, "No GitLab service connected");
  });

  test("details: recent commits and pipelines as runs", async () => {
    pipelines = [pipe(1003, "failed", "aaa111"), { ...pipe(1002, "canceled", "bbb222"), name: "Nightly" }];
    const d = (await gitlab.details!(conn(), auth)) as CommitsDetails;
    assert.equal(d.shape, "commits");
    assert.equal(d.branch, "main");
    assert.deepEqual(d.link, { url: "https://gitlab.com/acme/star-map", label: "All on GitLab" });
    assert.deepEqual(d.commits.map((c) => [c.sha, c.message]), [["aaa111", "Fix the map"], ["bbb222", "Add stars"]]);
    assert.deepEqual(d.runs[0], { id: 1003, name: "Pipeline #3", state: "failing", conclusion: "failed", sha: "aaa111", at: pipelines[0]!.created_at, url: "https://gitlab.com/acme/star-map/-/pipelines/1003" });
    assert.equal(d.runs[1]!.name, "Nightly");
    assert.equal(d.runs[1]!.state, "other");
  });

  test("latestCommit, in the app's folders; commitUrl; contains via compare", async () => {
    assert.equal((await gitlab.latestCommit!(conn(), auth))?.sha, "aaa111");
    assert.equal((await gitlab.latestCommit!(conn({ projectId: 42, branch: "main", paths: ["docs"] }), auth))?.sha, "bbb222");
    assert.ok(calls.some((c) => c.includes("/repository/commits?ref_name=main&per_page=1&path=docs")));
    assert.equal(gitlab.commitUrl!(conn(), "aaa111"), "https://gitlab.com/acme/star-map/-/commit/aaa111");

    assert.equal(await gitlab.contains!(conn(), auth, "aaa111", "aaa111"), true);
    assert.equal(calls.filter((c) => c.includes("/compare")).length, 0, "the same commit needs no call");
    compareCommits = [];
    assert.equal(await gitlab.contains!(conn(), auth, "aaa111", "bbb222"), true);
    assert.ok(calls.some((c) => c.endsWith("/repository/compare?from=aaa111&to=bbb222")));
    clearHttpCache();
    compareCommits = [{ id: "bbb222" }];
    assert.equal(await gitlab.contains!(conn(), auth, "aaa111", "bbb222"), false, "base has a commit head doesn't");
  });

  test("failureLog: the failed jobs of the failed pipeline, each with the end of its log", async () => {
    pipelines = [pipe(1004, "running"), pipe(1003, "failed")];
    const f = await gitlab.failureLog!(conn(), auth);
    assert.equal(f.branch, "main");
    assert.deepEqual(f.builds, []);
    assert.equal(f.runs.length, 1);
    assert.equal(f.runs[0]!.workflow, "Pipeline #3");
    assert.equal(f.runs[0]!.url, "https://gitlab.com/acme/star-map/-/pipelines/1003");
    assert.equal(f.runs[0]!.jobs.length, 1, "a job allowed to fail didn't fail the pipeline");
    const job = f.runs[0]!.jobs[0]!;
    assert.equal(job.name, "test: unit");
    assert.equal(job.conclusion, "script_failure");
    assert.equal(job.log, "Running tests\n1 failing\nAssertionError: stars != 3\nERROR: Job failed: exit code 1");
    assert.ok(calls.some((c) => c.includes("/pipelines/1003/jobs?scope[]=failed") || c.includes("/pipelines/1003/jobs?scope%5B%5D=failed")));

    clearHttpCache();
    pipelines = [pipe(1005, "success")];
    assert.deepEqual((await gitlab.failureLog!(conn(), auth)).runs, [], "nothing failing: nothing to explain");
  });

  test("logTail keeps the end, up to the failure", () => {
    assert.equal(logTail("a\nb\nERROR: Job failed: exit code 2\nRunning after_script\ncleanup\n"), "a\nb\nERROR: Job failed: exit code 2");
    assert.equal(logTail("1\n2\n3\n4", 2), "3\n4");
  });

  test("notice when it's passing again", () => {
    assert.deepEqual(gitlab.notice!("up", "Star Map", "", 0), { title: "Star Map: CI is passing again", body: "The latest pipeline succeeded." });
  });
});
