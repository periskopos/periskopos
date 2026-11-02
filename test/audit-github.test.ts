import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { github } from "../server/integrations/github.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// GitHub is faked: nothing here reaches the network, and every call must be
// a GET.

const REPO = "owner/star-map";
const realFetch = globalThis.fetch;
const auth = { service: {}, token: async () => "ghp_test" } as unknown as ServiceAuth;
const conn: Connection = { id: "c1", appId: "a1", type: "github", serviceId: "s1", resource: REPO, settings: { branch: "main", paths: [] } };
const app = {} as App;

type Reply = { status: number; body?: unknown } | "unreachable";
let replies: Record<string, Reply>;
let calls: { method: string; path: string }[];

const json = (body: unknown, status = 200): Reply => ({ status, body });
const notFound = (message = "Not Found"): Reply => ({ status: 404, body: { message } });
const forbidden = (message = "Resource not accessible by personal access token"): Reply => ({ status: 403, body: { message } });

// Everything locked down: a ruleset and classic protection on main, secret
// scanning and push protection on, Dependabot on, workflows read-only.
function hardened(): Record<string, Reply> {
  return {
    [`/repos/${REPO}`]: json({ private: false, security_and_analysis: { secret_scanning: { status: "enabled" }, secret_scanning_push_protection: { status: "enabled" } } }),
    [`/repos/${REPO}/rules/branches/main`]: json([{ type: "pull_request" }, { type: "non_fast_forward" }, { type: "required_status_checks" }, { type: "deletion" }]),
    [`/repos/${REPO}/branches/main/protection`]: json({ allow_force_pushes: { enabled: false }, required_pull_request_reviews: {}, required_status_checks: { contexts: ["ci"] } }),
    [`/repos/${REPO}/vulnerability-alerts`]: { status: 204 },
    [`/repos/${REPO}/automated-security-fixes`]: json({ enabled: true, paused: false }),
    [`/repos/${REPO}/actions/permissions/workflow`]: json({ default_workflow_permissions: "read", can_approve_pull_request_reviews: false }),
  };
}

beforeEach(() => {
  clearHttpCache();
  calls = [];
  replies = hardened();
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ method: init?.method ?? "GET", path: url.pathname });
    const reply = replies[url.pathname];
    if (reply === "unreachable") throw new TypeError("fetch failed");
    if (!reply) return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
    if (reply.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  assert.ok(calls.every((c) => c.method === "GET"), "only GETs");
});

const run = () => github.audit!(conn, auth, app);
const keys = (r: { findings: { key: string }[] }) => r.findings.map((f) => f.key).sort();

describe("GitHub configuration checks", () => {
  test("a fully hardened repository has no findings and no notes", async () => {
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, []);
  });

  test("an unprotected branch: high on a public repo, medium on a private one", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([]);
    replies[`/repos/${REPO}/branches/main/protection`] = notFound("Branch not protected");
    let r = await run();
    assert.deepEqual(keys(r), ["branch-protection:main"]);
    const f = r.findings[0]!;
    assert.equal(f.severity, "high");
    assert.equal(f.fix.link?.url, `https://github.com/${REPO}/settings/rules`);
    assert.match(f.fix.steps, /Block force pushes/);

    clearHttpCache();
    replies[`/repos/${REPO}`] = json({ private: true });
    r = await run();
    assert.deepEqual(keys(r), ["branch-protection:main"]);
    assert.equal(r.findings[0]!.severity, "medium");
  });

  test("a ruleset alone counts as protection, read without admin", async () => {
    replies[`/repos/${REPO}/branches/main/protection`] = forbidden();
    replies[`/repos/${REPO}/vulnerability-alerts`] = forbidden();
    replies[`/repos/${REPO}/automated-security-fixes`] = forbidden();
    replies[`/repos/${REPO}/actions/permissions/workflow`] = forbidden();
    replies[`/repos/${REPO}`] = json({ private: false });
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.equal(r.notes?.length, 1);
    assert.match(r.notes![0]!, /^Add Administration: Read to the GitHub token to check secret scanning, Dependabot alerts, Dependabot security updates and workflow permissions$/);
  });

  test("no ruleset and no admin: a note, never a guess", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([]);
    replies[`/repos/${REPO}/branches/main/protection`] = forbidden();
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.match(r.notes!.join("\n"), /Add Administration: Read to the GitHub token to check branch protection on main/);
  });

  test("a private repo on GitHub Free: a note that it can't be protected", async () => {
    const upgrade = "Upgrade to GitHub Pro or make this repository public to enable this feature.";
    replies[`/repos/${REPO}`] = json({ private: true });
    replies[`/repos/${REPO}/rules/branches/main`] = forbidden(upgrade); // rulesets are refused on the plan too
    replies[`/repos/${REPO}/branches/main/protection`] = forbidden(upgrade);
    const r = await run();
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ["GitHub Free doesn't protect branches of private repositories, so main can't be protected on this plan"], "said once, not as a refusal as well");
  });

  test("weak classic protection: force pushes, no pull request, no status checks", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([]);
    replies[`/repos/${REPO}/branches/main/protection`] = json({ allow_force_pushes: { enabled: true } });
    const r = await run();
    assert.deepEqual(keys(r), ["force-push:main", "pr-required:main", "status-checks:main"]);
    assert.ok(r.findings.every((f) => f.severity === "low"));
    assert.ok(r.findings.every((f) => f.fix.link?.url === `https://github.com/${REPO}/settings/branches`));
  });

  test("a ruleset without force-push blocking, and no classic rule", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([{ type: "deletion" }, { type: "pull_request" }, { type: "required_status_checks" }]);
    replies[`/repos/${REPO}/branches/main/protection`] = notFound("Branch not protected");
    const r = await run();
    assert.deepEqual(keys(r), ["force-push:main"]);
    assert.equal(r.findings[0]!.fix.link?.url, `https://github.com/${REPO}/settings/rules`);
  });

  test("a ruleset that only names branches isn't protection", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([{ type: "creation" }]);
    replies[`/repos/${REPO}/branches/main/protection`] = notFound("Branch not protected");
    assert.deepEqual(keys(await run()), ["branch-protection:main"]);
  });

  test("a ruleset without force-push blocking, and a classic rule it can't read: no guess about force pushes", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([{ type: "deletion" }, { type: "pull_request" }, { type: "required_status_checks" }]);
    replies[`/repos/${REPO}/branches/main/protection`] = forbidden();
    assert.deepEqual((await run()).findings, [], "the classic rule may block them");
  });

  test("secret scanning and push protection off on a public repo", async () => {
    replies[`/repos/${REPO}`] = json({ private: false, security_and_analysis: { secret_scanning: { status: "disabled" }, secret_scanning_push_protection: { status: "disabled" } } });
    const r = await run();
    assert.deepEqual(keys(r), ["push-protection", "secret-scanning"]);
    assert.ok(r.findings.every((f) => f.severity === "medium" && f.fix.link?.url === `https://github.com/${REPO}/settings/security_analysis`));
  });

  test("secret scanning isn't asked of a private repo", async () => {
    replies[`/repos/${REPO}`] = json({ private: true, security_and_analysis: { secret_scanning: { status: "disabled" } } });
    assert.deepEqual((await run()).findings, []);
  });

  test("Dependabot alerts off (404) is medium, and covers security updates", async () => {
    replies[`/repos/${REPO}/vulnerability-alerts`] = notFound();
    replies[`/repos/${REPO}/automated-security-fixes`] = notFound();
    const r = await run();
    assert.deepEqual(keys(r), ["dependabot-alerts"]);
    assert.equal(r.findings[0]!.severity, "medium");
  });

  test("Dependabot security updates off is low", async () => {
    replies[`/repos/${REPO}/automated-security-fixes`] = json({ enabled: false, paused: false });
    const r = await run();
    assert.deepEqual(keys(r), ["dependabot-security-updates"]);
    assert.equal(r.findings[0]!.severity, "low");
  });

  test("write-by-default workflow token is medium", async () => {
    replies[`/repos/${REPO}/actions/permissions/workflow`] = json({ default_workflow_permissions: "write", can_approve_pull_request_reviews: false });
    const r = await run();
    assert.deepEqual(keys(r), ["workflow-token-write"]);
    assert.equal(r.findings[0]!.severity, "medium");
    assert.equal(r.findings[0]!.fix.link?.url, `https://github.com/${REPO}/settings/actions`);
  });

  test("keys are stable across runs", async () => {
    replies[`/repos/${REPO}/rules/branches/main`] = json([]);
    replies[`/repos/${REPO}/branches/main/protection`] = json({ allow_force_pushes: { enabled: true } });
    replies[`/repos/${REPO}/actions/permissions/workflow`] = json({ default_workflow_permissions: "write" });
    const first = keys(await run());
    clearHttpCache();
    assert.deepEqual(keys(await run()), first);
  });

  test("an unreachable GitHub throws, so earlier findings are kept", async () => {
    for (const k of Object.keys(replies)) replies[k] = "unreachable";
    await assert.rejects(run(), /Can't reach GitHub/);
  });

  test("a branch with a slash is encoded in the path", async () => {
    const c = { ...conn, settings: { branch: "release/v1", paths: [] } };
    await github.audit!(c, auth, app);
    assert.ok(calls.some((x) => x.path === `/repos/${REPO}/branches/release%2Fv1/protection`));
  });
});
