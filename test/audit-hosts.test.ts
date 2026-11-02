import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, AuditResult, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { netlify } from "../server/integrations/netlify.ts";
import { renderIntegration } from "../server/integrations/render.ts";
import { vercel } from "../server/integrations/vercel.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Configuration checks for Vercel, Netlify and Render. Everything here is a
// fake; nothing reaches the network, and nothing but GET is ever sent.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
type Seen = { method: string; url: URL };
let seen: Seen[];
let answer: (s: Seen) => Response;
beforeEach(() => {
  clearHttpCache();
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { method: init?.method ?? "GET", url: new URL(String(input instanceof Request ? input.url : input)) };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
});
afterEach(() => {
  assert.ok(seen.every((s) => s.method === "GET"), "only GET");
  globalThis.fetch = realFetch;
});

const authOf = (type: string) => ({ service: { id: "s", ownerId: "u", type, name: type, canWrite: false }, token: async () => "test-token" }) as ServiceAuth;
const connOf = (type: string, resource: string, settings: Record<string, unknown> = {}): Connection => ({ id: "c", appId: "a", type, serviceId: "s", resource, settings });
const app = (live = true): App => ({ id: "a", slug: "shop", ownerId: "u", name: "Shop", url: "https://shop.example", live, checkIntervalMin: 5, connections: [] });
const keys = (r: AuditResult) => r.findings.map((f) => `${f.key}/${f.severity}`).sort();

// ── Vercel ──────────────────────────────────────────────────────────────

describe("Vercel audit", () => {
  const conn = connOf("vercel", "prj_abc123", { name: "shop", scope: "me", teamId: "team_xyz" });
  const auth = authOf("vercel");
  const linked = { type: "github", org: "me", repo: "shop", productionBranch: "main" };

  test("open previews and fork protection off are found, with links to the settings", async () => {
    answer = () => json({ id: "prj_abc123", ssoProtection: null, passwordProtection: null, trustedIps: null, gitForkProtection: false, link: linked });
    const r = await vercel.audit!(conn, auth, app());
    assert.deepEqual(keys(r), ["git-fork-protection-off/medium", "previews-public/medium"]);
    assert.equal(seen[0]!.url.pathname, "/v9/projects/prj_abc123");
    assert.equal(seen[0]!.url.searchParams.get("teamId"), "team_xyz");
    const previews = r.findings.find((f) => f.key === "previews-public")!;
    assert.equal(previews.fix.link?.url, "https://vercel.com/me/shop/settings/deployment-protection");
    assert.equal(r.findings.find((f) => f.key === "git-fork-protection-off")!.fix.link?.url, "https://vercel.com/me/shop/settings/git");
  });

  test("a project without Git is found, and fork protection isn't judged without Git", async () => {
    answer = () => json({ id: "prj_abc123", ssoProtection: { deploymentType: "preview" }, passwordProtection: null, gitForkProtection: false });
    assert.deepEqual(keys(await vercel.audit!(conn, auth, app())), ["not-linked-to-git/low"]);
  });

  test("any protection covers previews: password or trusted IPs", async () => {
    answer = () => json({ id: "prj_abc123", ssoProtection: null, passwordProtection: { deploymentType: "all" }, gitForkProtection: true, link: linked });
    assert.deepEqual(keys(await vercel.audit!(conn, auth, app())), []);
    clearHttpCache();
    answer = () => json({ id: "prj_abc123", trustedIps: { deploymentType: "preview" }, gitForkProtection: true, link: linked });
    assert.deepEqual(keys(await vercel.audit!(conn, auth, app())), []);
  });

  test("a clean project finds nothing", async () => {
    answer = () => json({ id: "prj_abc123", ssoProtection: { deploymentType: "all_except_custom_domains" }, passwordProtection: null, gitForkProtection: true, link: linked });
    const r = await vercel.audit!(conn, auth, app());
    assert.deepEqual(r, { findings: [] });
  });

  test("a key that can't read settings is a note; an unreachable API throws", async () => {
    answer = () => json({ error: { message: "forbidden" } }, 403);
    const r = await vercel.audit!(conn, auth, app());
    assert.deepEqual(r.findings, []);
    assert.match(r.notes![0]!, /can't read this project's settings/);
    clearHttpCache();
    answer = () => json({}, 500);
    await assert.rejects(vercel.audit!(conn, auth, app()), /HTTP 500/);
  });

  test("keys are the same from one run to the next", async () => {
    answer = () => json({ id: "prj_abc123", gitForkProtection: false, link: linked });
    const a = keys(await vercel.audit!(conn, auth, app()));
    clearHttpCache();
    assert.deepEqual(keys(await vercel.audit!(conn, auth, app())), a);
  });
});

// ── Netlify ─────────────────────────────────────────────────────────────

describe("Netlify audit", () => {
  const id = "3970e0fe-8564-4903-9a55-c5f8de49fb8b";
  const conn = connOf("netlify", id, { name: "shop" });
  const auth = authOf("netlify");
  const site = (extra: Record<string, unknown>) => ({ id, name: "shop", url: "http://shop.example", ssl: true, force_ssl: false, build_settings: { repo_url: "https://github.com/me/shop", stop_builds: false }, ...extra });

  test("a custom domain without a certificate is high", async () => {
    answer = () => json(site({ custom_domain: "Shop.Example", ssl: false }));
    const r = await netlify.audit!(conn, auth, app());
    assert.deepEqual(keys(r), ["no-certificate:shop.example/high"]);
    assert.equal(seen[0]!.url.pathname, `/api/v1/sites/${id}`);
    assert.equal(r.findings[0]!.fix.link?.url, "https://app.netlify.com/projects/shop/domain-management#https");
    assert.match(r.findings[0]!.title, /Shop\.Example/);
  });

  test("stopped builds and a site without Git are low", async () => {
    answer = () => json(site({ build_settings: { repo_url: "https://github.com/me/shop", stop_builds: true } }));
    assert.deepEqual(keys(await netlify.audit!(conn, auth, app())), ["builds-stopped/low"]);
    clearHttpCache();
    answer = () => json(site({ build_settings: { stop_builds: true } }));
    assert.deepEqual(keys(await netlify.audit!(conn, auth, app())), ["not-linked-to-git/low"], "without Git, stopped builds aren't said as well");
  });

  test("a clean site finds nothing (force_ssl isn't judged)", async () => {
    answer = () => json(site({ custom_domain: "shop.example", ssl: true, force_ssl: false }));
    assert.deepEqual(await netlify.audit!(conn, auth, app()), { findings: [] });
    clearHttpCache();
    answer = () => json(site({ ssl: false })); // no custom domain: Netlify's own address has its certificate
    assert.deepEqual(await netlify.audit!(conn, auth, app()), { findings: [] });
  });

  test("a key that can't read the site is a note", async () => {
    answer = () => json({ message: "forbidden" }, 403);
    const r = await netlify.audit!(conn, auth, app());
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes?.length, 1);
  });
});

// ── Render ──────────────────────────────────────────────────────────────

describe("Render audit", () => {
  const conn = connOf("render", "srv-abc123", { name: "shop" });
  const auth = authOf("render");
  const service = (extra: Record<string, unknown> = {}, details: Record<string, unknown> = {}) => ({
    id: "srv-abc123",
    name: "shop",
    type: "web_service",
    dashboardUrl: "https://dashboard.render.com/web/srv-abc123",
    autoDeploy: "yes",
    autoDeployTrigger: "commit",
    serviceDetails: { url: "https://shop.onrender.com", plan: "starter", healthCheckPath: "/healthz", ...details },
    ...extra,
  });

  test("auto-deploy off, no health check path and a free instance are found", async () => {
    answer = () => json(service({ autoDeploy: "no", autoDeployTrigger: "off" }, { plan: "free", healthCheckPath: "" }));
    const r = await renderIntegration.audit!(conn, auth, app());
    assert.deepEqual(keys(r), ["auto-deploy-off/low", "free-instance/low", "health-check-path-missing/medium"]);
    assert.equal(seen[0]!.url.pathname, "/v1/services/srv-abc123");
    assert.ok(r.findings.every((f) => f.fix.link?.url === "https://dashboard.render.com/web/srv-abc123/settings"));
  });

  test("a dashboard address that isn't Render's is never linked", async () => {
    answer = () => json(service({ dashboardUrl: "https://evil.example/web/srv-abc123" }, { healthCheckPath: "" }));
    const r = await renderIntegration.audit!(conn, auth, app());
    assert.deepEqual(keys(r), ["health-check-path-missing/medium"]);
    assert.equal(r.findings[0]!.fix.link, undefined);
  });

  test("the old autoDeploy field is read when there's no trigger", async () => {
    answer = () => json(service({ autoDeploy: "no", autoDeployTrigger: undefined }));
    assert.deepEqual(keys(await renderIntegration.audit!(conn, auth, app())), ["auto-deploy-off/low"]);
  });

  test("a free instance is fine for an app not live yet; non-web services need no health check", async () => {
    answer = () => json(service({}, { plan: "free" }));
    assert.deepEqual(keys(await renderIntegration.audit!(conn, auth, app(false))), []);
    clearHttpCache();
    answer = () => json(service({ type: "background_worker" }, { healthCheckPath: undefined, plan: "free" }));
    assert.deepEqual(keys(await renderIntegration.audit!(conn, auth, app())), []);
  });

  test("a clean service finds nothing", async () => {
    answer = () => json(service({ autoDeployTrigger: "checksPass" }));
    assert.deepEqual(await renderIntegration.audit!(conn, auth, app()), { findings: [] });
  });

  test("a key that can't read the service is a note; an unreachable API throws", async () => {
    answer = () => json({ message: "forbidden" }, 403);
    const r = await renderIntegration.audit!(conn, auth, app());
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes?.length, 1);
    clearHttpCache();
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as typeof fetch;
    await assert.rejects(renderIntegration.audit!(conn, auth, app()), /Can't reach Render/);
  });
});
