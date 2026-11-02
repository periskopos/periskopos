import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { digitalocean, phaseOf, toDeploy } from "../server/integrations/digitalocean.ts";
import { deployHealth, wasReplaced } from "../server/integrations/render.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";
import { parseSummary, partsInUse, affects } from "../server/providers.ts";
import { obviousMatch } from "../server/suggestions.ts";

// DigitalOcean App Platform as a host. Everything here is a fake; nothing
// reaches the network.

const APP_ID = "4f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf";
const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const dep = (id: string, phase: string, minAgo: number, sha?: string, cause = "commit pushed to github.com/acme/shop") => ({
  id,
  phase,
  cause,
  created_at: iso(minAgo),
  updated_at: iso(minAgo - 3),
  services: sha ? [{ name: "web", source_commit_hash: sha }] : [],
});

const realFetch = globalThis.fetch;
let deployments: ReturnType<typeof dep>[];
const posted: { path: string; body: unknown }[] = [];
beforeEach(() => {
  clearHttpCache();
  posted.length = 0;
  deployments = [dep("d3", "ACTIVE", 10, "ccc3333aaaa"), dep("d2", "SUPERSEDED", 120, "bbb2222aaaa"), dep("d1", "SUPERSEDED", 600, "aaa1111aaaa")];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if ((init?.method ?? "GET") === "POST") {
      posted.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      return json({ deployment: { id: "d4", phase: "PENDING_BUILD" } });
    }
    if (url.pathname === "/v2/account") return json({ account: { email: "me@example.com", team: { name: "acme" } } });
    if (url.pathname === "/v2/apps") {
      return json({ apps: [{ id: APP_ID, spec: { name: "shop" }, live_domain: "shop.example.com", region: { slug: "fra", label: "Frankfurt" } }, { id: "0f6c71e2-1e90-4762-9fee-6cc4a0a9f2cf", spec: { name: "blog" }, live_url: "https://blog-x7k2.ondigitalocean.app", region: { slug: "ams" } }] });
    }
    if (url.pathname === `/v2/apps/${APP_ID}/deployments`) return json({ deployments });
    return json({ id: "not_found", message: "The resource you were accessing could not be found." }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "digitalocean", name: "My DigitalOcean", canWrite: true }, token: async () => "dop_v1_test" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "digitalocean", serviceId: "s", resource: APP_ID, settings: { name: "shop" } };
const app = (url: string, name = "Shop"): App => ({ id: "a", slug: name.toLowerCase(), ownerId: "u", name, url, live: true, checkIntervalMin: 5, connections: [] });

describe("DigitalOcean: an app's deploys", () => {
  test("phases, the commit each built, and a link to it", () => {
    assert.deepEqual(["ACTIVE", "BUILDING", "PENDING_DEPLOY", "ERROR", "SUPERSEDED", "CANCELED"].map(phaseOf), ["live", "in-progress", "in-progress", "failed", "other", "other"]);
    const d = toDeploy(dep("d9", "ACTIVE", 5, "abc1234def", "commit abc1234 pushed to github.com/acme/shop"), conn);
    assert.deepEqual(d.commit, { sha: "abc1234def", message: "commit abc1234 pushed to github.com/acme/shop", at: d.startedAt });
    assert.equal(d.url, `https://cloud.digitalocean.com/apps/${APP_ID}/deployments/d9`);
    assert.equal(toDeploy(dep("d8", "BUILDING", 1), conn).finishedAt, undefined, "a deploy still going hasn't finished");
  });

  test("check: up while the newest is live; a failed one is down; a running one isn't news", async () => {
    assert.equal((await digitalocean.check!(conn, auth)).state, "up");
    clearHttpCache();
    deployments = [dep("d4", "ERROR", 2, "ddd4444aaaa"), ...deployments];
    const failed = await digitalocean.check!(conn, auth);
    assert.equal(failed.state, "down");
    assert.match(failed.detail!, /^Deploy failed \(error\): ddd4444/);
    clearHttpCache();
    deployments = [dep("d5", "BUILDING", 1, "eee5555aaaa"), ...deployments.slice(1)];
    assert.equal((await digitalocean.check!(conn, auth)).state, "up", "the newest finished one (live) decides");
  });

  test("details link to the app's dashboard: All in DigitalOcean", async () => {
    const d = await digitalocean.details!(conn, auth);
    assert.ok(d.shape === "deploys");
    assert.deepEqual(d.link, { url: `https://cloud.digitalocean.com/apps/${APP_ID}`, label: "All in DigitalOcean" });
    assert.equal(d.deploys.length, 3);
  });

  test("Redeploy: never on top of a running deploy; otherwise one POST", async () => {
    deployments = [dep("d5", "BUILDING", 1, "eee5555aaaa"), ...deployments];
    const busy = await digitalocean.run!(conn, auth, "redeploy");
    assert.equal(busy.ok, false);
    assert.equal(posted.length, 0);
    // No cache clearing here: Redeploy looks at the deploys fresh itself.
    deployments = deployments.slice(1);
    const ok = await digitalocean.run!(conn, auth, "redeploy");
    assert.equal(ok.ok, true);
    assert.deepEqual(posted, [{ path: `/v2/apps/${APP_ID}/deployments`, body: { force_build: false } }]);
  });
});

describe("DigitalOcean: connecting it", () => {
  test("the account, its apps with their address, and the app an address belongs to", async () => {
    assert.equal((await digitalocean.testService!(auth)).message, "Connected to acme");
    const list = await digitalocean.listResources!(auth);
    assert.deepEqual(list.map((r) => [r.label, r.detail]), [["shop", "shop.example.com · Frankfurt"], ["blog", "blog-x7k2.ondigitalocean.app · ams"]]);
    assert.equal(obviousMatch(app("https://shop.example.com/"), "digitalocean", list)?.id, APP_ID, "the app serving the address");
    assert.equal(obviousMatch(app("https://myblog.example/", "Blog"), "digitalocean", list)?.label, "blog", "or named like it");
  });

  test("parse: an app picked from the list", () => {
    assert.deepEqual(digitalocean.parse({ resource: APP_ID, settings: { name: "shop" } }), { resource: APP_ID, settings: { name: "shop" } });
    assert.throws(() => digitalocean.parse({ resource: "shop", settings: {} }), /Pick the app from the list/);
  });
});

describe("shared with the other hosts", () => {
  test("a replaced deploy counts as finished, whatever the host calls it", () => {
    const at = new Date().toISOString();
    const replaced = (status: string) => ({ id: status, status, phase: "other" as const, startedAt: iso(30), finishedAt: iso(25) });
    assert.ok(wasReplaced(replaced("deactivated")) && wasReplaced(replaced("superseded")));
    assert.ok(!wasReplaced(replaced("canceled")));
    // Only a replaced deploy behind a running one: deploys work, it's up.
    const running = { id: "r", status: "building", phase: "in-progress" as const, startedAt: iso(1) };
    assert.equal(deployHealth([running, replaced("superseded")], at).state, "up");
  });

  test("a status page that names parts by region: the product is the part's group", () => {
    const fetched = parseSummary({
      status: { indicator: "minor", description: "Partial outage" },
      components: [
        { id: "g1", name: "App Platform", group: true },
        { id: "c1", name: "Frankfurt", group_id: "g1" },
        { id: "g2", name: "Spaces", group: true },
        { id: "c2", name: "Frankfurt", group_id: "g2" },
      ],
      incidents: [
        { name: "Spaces errors in FRA1", impact: "minor", components: [{ id: "c2", name: "Frankfurt" }] },
        { name: "Deploys failing", impact: "major", components: [{ id: "c1", name: "Frankfurt" }] },
      ],
    });
    assert.deepEqual(fetched.incidents.map((i) => i.parts), [["Frankfurt", "Spaces"], ["Frankfurt", "App Platform"]]);
    const inUse = partsInUse("digitalocean", []);
    assert.deepEqual(fetched.incidents.map((i) => affects(i.parts, inUse)), [false, true], "Spaces isn't my App Platform app");
  });
});
