import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { fly, toDeploys as flyDeploys } from "../server/integrations/fly.ts";
import { netlify, toDeploy as netlifyDeploy } from "../server/integrations/netlify.ts";
import { railway, toDeploys as railwayDeploys } from "../server/integrations/railway.ts";
import { sentry, takingOff, toIssue, NEW_MIN_EVENTS } from "../server/integrations/sentry.ts";
import { vercel, toDeploys as vercelDeploys } from "../server/integrations/vercel.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";
import { obviousMatch } from "../server/suggestions.ts";

// Vercel, Netlify, Fly.io and Railway as hosts, and Sentry for errors.
// Everything here is a fake; nothing reaches the network.

const ago = (min: number) => Date.now() - min * 60_000;
const iso = (min: number) => new Date(ago(min)).toISOString();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
type Seen = { method: string; url: URL; body?: unknown; auth?: string | null };
let seen: Seen[];
let answer: (s: Seen) => Response;
beforeEach(() => {
  clearHttpCache();
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = {
      method: init?.method ?? "GET",
      url: new URL(String(input instanceof Request ? input.url : input)),
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
      auth: new Headers(init?.headers).get("authorization"),
    };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const authOf = (type: string, token = "test-token") => ({ service: { id: "s", ownerId: "u", type, name: type, canWrite: true }, token: async () => token }) as ServiceAuth;
const connOf = (type: string, resource: string, settings: Record<string, unknown> = {}): Connection => ({ id: "c", appId: "a", type, serviceId: "s", resource, settings });
const app = (url: string, name = "Shop"): App => ({ id: "a", slug: name.toLowerCase(), ownerId: "u", name, url, live: true, checkIntervalMin: 5, connections: [] });

// ── Vercel ──────────────────────────────────────────────────────────────

describe("Vercel", () => {
  const vd = (uid: string, readyState: string, min: number, sha?: string, extra: Record<string, unknown> = {}) => ({
    uid,
    readyState,
    created: ago(min),
    ready: ago(min - 2),
    inspectorUrl: `https://vercel.com/me/shop/${uid}`,
    meta: (sha ? { githubCommitSha: sha, githubCommitMessage: `Change ${uid}\n\nbody` } : {}) as Record<string, string>,
    ...extra,
  });
  const conn = connOf("vercel", "prj_abc123", { name: "shop", scope: "me", teamId: "team_xyz" });
  const auth = authOf("vercel");

  test("the newest READY deploy is live; older ones were replaced, staged ones never served", () => {
    const list = vercelDeploys([vd("d4", "BUILDING", 1, "dddd444"), vd("d3", "READY", 5, "cccc333", { readySubstate: "STAGED" }), vd("d2", "READY", 30, "bbbb222"), vd("d1", "READY", 90, "aaaa111"), vd("d0", "ERROR", 120)]);
    assert.deepEqual(list.map((d) => [d.status, d.phase]), [["building", "in-progress"], ["staged", "other"], ["live", "live"], ["superseded", "other"], ["error", "failed"]]);
    assert.deepEqual(list[2]!.commit, { sha: "bbbb222", message: "Change d2", at: list[2]!.startedAt });
    assert.equal(list[0]!.finishedAt, undefined);
  });

  test("check reads the project's production deploys, on behalf of its team", async () => {
    answer = () => json({ deployments: [vd("d2", "ERROR", 3, "bbbb222"), vd("d1", "READY", 60, "aaaa111")] });
    const r = await vercel.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^Deploy failed \(error\): bbbb222/);
    const q = seen[0]!.url;
    assert.equal(q.pathname, "/v7/deployments");
    assert.deepEqual([q.searchParams.get("projectId"), q.searchParams.get("target"), q.searchParams.get("teamId")], ["prj_abc123", "production", "team_xyz"]);
  });

  test("Redeploy rebuilds the live deploy, never on top of a running one", async () => {
    answer = (s) => (s.method === "POST" ? json({ id: "dpl_new", readyState: "QUEUED" }) : json({ deployments: [vd("d2", "BUILDING", 1), vd("d1", "READY", 60, "aaaa111")] }));
    assert.equal((await vercel.run!(conn, auth, "redeploy")).ok, false);
    assert.equal(seen.filter((s) => s.method === "POST").length, 0);
    // No cache clearing here: Redeploy looks at the deploys fresh itself.
    answer = (s) => (s.method === "POST" ? json({ id: "dpl_new", readyState: "QUEUED" }) : json({ deployments: [vd("d1", "READY", 60, "aaaa111")] }));
    const ok = await vercel.run!(conn, auth, "redeploy");
    assert.equal(ok.ok, true);
    const post = seen.find((s) => s.method === "POST")!;
    assert.equal(post.url.pathname, "/v13/deployments");
    assert.deepEqual(post.body, { name: "shop", deploymentId: "d1", target: "production" });
  });

  test("projects from the account and its teams, matched by the address they serve", async () => {
    answer = (s) => {
      if (s.url.pathname === "/v2/user") return json({ user: { username: "me" } });
      if (s.url.pathname === "/v2/teams") return json({ teams: [{ id: "team_xyz", slug: "acme" }] });
      return s.url.searchParams.get("teamId")
        ? json({ projects: [{ id: "prj_team1", name: "blog", targets: { production: { alias: ["blog.acme.com"] } } }] })
        : json({ projects: [{ id: "prj_abc123", name: "shop", targets: { production: { alias: ["shop.example.com", "shop-me.vercel.app"] } } }] });
    };
    const list = await vercel.listResources!(auth);
    assert.deepEqual(list.map((r) => [r.id, r.detail]), [["prj_abc123", "shop.example.com · shop-me.vercel.app · me"], ["prj_team1", "blog.acme.com · acme"]]);
    assert.deepEqual(list[1]!.settings, { name: "blog", scope: "acme", teamId: "team_xyz" });
    assert.equal(obviousMatch(app("https://blog.acme.com/", "Notes"), "vercel", list)?.id, "prj_team1");
  });

  test("parse keeps only what it should", () => {
    assert.deepEqual(vercel.parse({ resource: "prj_abc123", settings: { name: "shop", scope: "me", teamId: "team_xyz", evil: "x" } }), { resource: "prj_abc123", settings: { name: "shop", scope: "me", teamId: "team_xyz" } });
    assert.throws(() => vercel.parse({ resource: "shop", settings: {} }), /Pick the project/);
  });
});

// ── Netlify ─────────────────────────────────────────────────────────────

describe("Netlify", () => {
  const SITE = "3970e0fe-8564-4903-9a55-c5f8de49fb8b";
  const admin = "https://app.netlify.com/sites/shop";
  const nd = (id: string, state: string, min: number, extra: Record<string, unknown> = {}) => ({ id, state, commit_ref: `${id}aaaa111`, title: `Change ${id}`, created_at: iso(min), published_at: null, updated_at: iso(min - 2), ...extra });
  const conn = connOf("netlify", SITE, { name: "shop", adminUrl: admin });

  test("the published deploy is live; a canceled build isn't a failure", () => {
    assert.deepEqual([netlifyDeploy(nd("d1", "ready", 10), "d1", admin).phase, netlifyDeploy(nd("d0", "ready", 60), "d1", admin).status], ["live", "superseded"]);
    assert.equal(netlifyDeploy(nd("d2", "error", 5, { error_message: "Build script returned non-zero exit code: 2" }), "d1", admin).phase, "failed");
    assert.deepEqual(Object.values(netlifyDeploy(nd("d3", "error", 5, { error_message: "Canceled build due to no content change" }), "d1", admin)).slice(1, 3), ["canceled", "other"]);
    assert.equal(netlifyDeploy(nd("d4", "building", 1), "d1", admin).phase, "in-progress");
    assert.equal(netlifyDeploy(nd("d1", "ready", 10), "d1", admin).url, `${admin}/deploys/d1`);
  });

  test("check: the published deploy decides, a running build isn't news", async () => {
    answer = (s) => (s.url.pathname.endsWith("/deploys") ? json([nd("d2", "building", 1), nd("d1", "ready", 30)]) : json({ id: SITE, published_deploy: { id: "d1" } }));
    assert.equal((await netlify.check!(conn, authOf("netlify"))).state, "up");
    assert.equal(seen.find((s) => s.url.pathname.endsWith("/deploys"))!.url.searchParams.get("production"), "true");
  });

  test("Redeploy starts a build", async () => {
    answer = (s) => (s.method === "POST" ? json({ id: "b1", deploy_id: "d9" }) : s.url.pathname.endsWith("/deploys") ? json([nd("d1", "ready", 30)]) : json({ published_deploy: { id: "d1" } }));
    const r = await netlify.run!(conn, authOf("netlify"), "redeploy");
    assert.deepEqual([r.ok, seen.find((s) => s.method === "POST")!.url.pathname], [true, `/api/v1/sites/${SITE}/builds`]);
  });
});

// ── Railway ─────────────────────────────────────────────────────────────

describe("Railway", () => {
  const P = "11111111-1111-1111-1111-111111111111";
  const E = "22222222-2222-2222-2222-222222222222";
  const S = "33333333-3333-3333-3333-333333333333";
  const rd = (id: string, status: string, min: number, sha?: string) => ({ id, status, createdAt: iso(min), meta: sha ? { commitHash: sha, commitMessage: `Change ${id}` } : null });
  const conn = connOf("railway", S, { projectId: P, environmentId: E, name: "api" });

  test("newest SUCCESS (or SLEEPING) is live; crashed counts as failed", () => {
    const list = railwayDeploys([rd("d4", "BUILDING", 1), rd("d3", "SUCCESS", 10, "cccc333"), rd("d2", "REMOVED", 60, "bbbb222"), rd("d1", "CRASHED", 90)], undefined);
    assert.deepEqual(list.map((d) => [d.status, d.phase]), [["building", "in-progress"], ["live", "live"], ["superseded", "other"], ["crashed", "failed"]]);
    assert.equal(railwayDeploys([rd("d5", "SLEEPING", 5)], undefined)[0]!.phase, "live");
  });

  test("check asks GraphQL for the service's deploys in its environment; GraphQL errors are failures", async () => {
    answer = () => json({ data: { deployments: { edges: [{ node: rd("d2", "FAILED", 2, "bbbb222") }, { node: rd("d1", "SUCCESS", 60, "aaaa111") }] } } });
    const r = await railway.check!(conn, authOf("railway"));
    assert.equal(r.state, "down");
    assert.deepEqual((seen[0]!.body as { variables: unknown }).variables, { input: { projectId: P, serviceId: S, environmentId: E }, first: 20 });
    clearHttpCache();
    answer = () => json({ errors: [{ message: "Not Authorized" }] });
    const bad = await railway.check!(conn, authOf("railway"));
    assert.deepEqual([bad.state, bad.detail], ["unknown", "Railway: Not Authorized"]);
  });

  test("services listed in each project's production environment", async () => {
    answer = () =>
      json({
        data: {
          projects: {
            edges: [
              { node: { id: P, name: "shop", environments: { edges: [{ node: { id: "x", name: "staging" } }, { node: { id: E, name: "production" } }] }, services: { edges: [{ node: { id: S, name: "api" } }] } } },
              { node: { id: "p2", name: "lab", environments: { edges: [{ node: { id: "a", name: "dev" } }, { node: { id: "b", name: "qa" } }] }, services: { edges: [{ node: { id: "s2", name: "x" } }] } } },
            ],
          },
        },
      });
    const list = await railway.listResources!(authOf("railway"));
    assert.deepEqual(list, [{ id: S, label: "api", detail: "shop · production", settings: { name: "api", projectId: P, environmentId: E } }]);
    assert.throws(() => railway.parse({ resource: S, settings: { name: "api" } }), /project and environment/);
  });

  test("Redeploy the live deploy, by its id", async () => {
    answer = (s) =>
      (s.body as { query: string }).query.startsWith("mutation")
        ? json({ data: { deploymentRedeploy: { id: "d9", status: "QUEUED" } } })
        : json({ data: { deployments: { edges: [{ node: rd("d1", "SUCCESS", 60, "aaaa111") }] } } });
    const r = await railway.run!(conn, authOf("railway"), "redeploy");
    assert.equal(r.ok, true);
    assert.deepEqual((seen.at(-1)!.body as { variables: unknown }).variables, { id: "d1" });
  });
});

// ── Fly.io ──────────────────────────────────────────────────────────────

describe("Fly.io", () => {
  const m = (id: string, state: string, version: string, min: number, checks: { name: string; status: string }[] = []) => ({ id, name: `m-${id}`, state, created_at: iso(min + 100), updated_at: iso(min), config: { metadata: { fly_release_version: version } }, checks });
  const conn = connOf("fly", "shop", { name: "shop" });

  test("a release per version its Machines run, newest first; stopped Machines are fine", () => {
    const list = flyDeploys([m("a", "started", "12", 5), m("b", "stopped", "12", 4), m("c", "started", "11", 90), m("d", "destroyed", "10", 200)], "shop");
    assert.deepEqual(list.map((d) => [d.id, d.status, d.phase]), [["v12", "live", "live"], ["v11", "superseded", "other"]]);
    assert.equal(flyDeploys([m("a", "failed", "13", 1), m("b", "started", "13", 1)], "shop")[0]!.status, "1 of 2 machines failed");
    assert.equal(flyDeploys([m("a", "starting", "13", 1)], "shop")[0]!.phase, "in-progress");
  });

  test("check: a failing health check on a running Machine needs attention", async () => {
    answer = () => json([m("a", "started", "12", 5, [{ name: "servicecheck-00-http-8080", status: "critical" }]), m("b", "started", "12", 5, [{ name: "servicecheck-00-http-8080", status: "passing" }])]);
    const r = await fly.check!(conn, authOf("fly", "FlyV1 fm2_secret"));
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Health check failing: servicecheck-00-http-8080 on m-a");
    assert.equal(seen[0]!.auth, "FlyV1 fm2_secret", "a FlyV1 token goes as its own scheme");
    assert.equal(seen[0]!.url.href, "https://api.machines.dev/v1/apps/shop/machines");
  });

  test("an older token goes as Bearer; apps matched by their fly.dev address", async () => {
    answer = () => json({ total_apps: 2, apps: [{ name: "shop", machine_count: 2 }, { name: "blog", machine_count: 1 }] });
    assert.equal((await fly.testService!(authOf("fly", "fo1_old"))).message, "Connected: 2 apps in your personal organization");
    assert.equal(seen[0]!.auth, "Bearer fo1_old");
    const list = await fly.listResources!(authOf("fly", "fo1_old"));
    assert.equal(obviousMatch(app("https://blog.fly.dev/", "Notes"), "fly", list)?.id, "blog");
    assert.throws(() => fly.parse({ resource: "My App!", settings: {} }), /lowercase/);
  });
});

// ── Sentry ──────────────────────────────────────────────────────────────

describe("Sentry", () => {
  const si = (id: string, count: number, firstMin: number, extra: Record<string, unknown> = {}) => ({ id, shortId: `SHOP-${id}`, title: `TypeError ${id}`, culprit: "app/cart.ts", level: "error", count: String(count), userCount: 3, firstSeen: iso(firstMin), lastSeen: iso(1), permalink: `https://acme.sentry.io/issues/${id}/`, ...extra });
  const conn = connOf("sentry", "acme/shop", { name: "shop", regionUrl: "https://de.sentry.io" });

  test("an error takes off when it's new in the last day and has enough events", () => {
    const list = [si("1", NEW_MIN_EVENTS, 60), si("2", NEW_MIN_EVENTS - 1, 60), si("3", 500, 3 * 24 * 60)].map(toIssue);
    assert.deepEqual(takingOff(list).map((i) => i.id), ["1"]);
    assert.equal(list[0]!.count, NEW_MIN_EVENTS, "Sentry sends counts as text");
  });

  test("check: needs attention with the error and a link to it, in the org's own region", async () => {
    answer = () => json([si("1", 42, 30)]);
    const r = await sentry.check!(conn, authOf("sentry"));
    assert.equal(r.state, "down");
    assert.equal(r.detail, "A new error in the last 24 h: TypeError 1 (42 events, 3 users)");
    assert.deepEqual(r.link, { url: "https://acme.sentry.io/issues/1/", label: "Open SHOP-1 in Sentry" });
    assert.equal(seen[0]!.url.origin + seen[0]!.url.pathname, "https://de.sentry.io/api/0/projects/acme/shop/issues/");
    assert.equal(seen[0]!.url.searchParams.get("query"), "is:unresolved firstSeen:-24h");
    clearHttpCache();
    answer = () => json([]);
    assert.equal((await sentry.check!(conn, authOf("sentry"))).state, "up");
  });

  test("details: unresolved issues, and how many are new", async () => {
    answer = () => json([si("1", 42, 30), si("2", 900, 5 * 24 * 60)]);
    const d = await sentry.details!(conn, authOf("sentry"));
    assert.ok(d.shape === "errors");
    assert.deepEqual([d.issues.length, d.newIn24h, d.link.label], [2, 1, "All in Sentry"]);
  });

  test("projects across organizations, each read in its region; parse refuses a stray region", async () => {
    answer = (s) =>
      s.url.pathname === "/api/0/organizations/"
        ? json([{ slug: "acme", name: "Acme", links: { regionUrl: "https://de.sentry.io" } }])
        : json([{ slug: "shop", name: "shop", platform: "javascript-nextjs" }]);
    const list = await sentry.listResources!(authOf("sentry"));
    assert.deepEqual(list, [{ id: "acme/shop", label: "shop", detail: "Acme · javascript-nextjs", settings: { name: "shop", regionUrl: "https://de.sentry.io" } }]);
    assert.equal(seen[1]!.url.origin, "https://de.sentry.io");
    assert.deepEqual(sentry.parse({ resource: "acme/shop", settings: { regionUrl: "https://evil.example" } }).settings, {});
  });
});
