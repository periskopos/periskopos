import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { alertsFor, clearMongoCache, describeAlert, describeCluster, keyFromPaste, mongodb } from "../server/integrations/mongodb.ts";
import type { Alert, Cluster } from "../server/integrations/mongodb.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// MongoDB Atlas: is the cluster serving, and has Atlas an alert open on it?
// Everything here is a fake; nothing reaches the network.

const realFetch = globalThis.fetch;
const G1 = "aaaaaaaaaaaaaaaaaaaaaaaa";
const G2 = "bbbbbbbbbbbbbbbbbbbbbbbb";
const ID = "mdb_sa_id_0123456789abcdef01234567";
const SECRET = "mdb_sa_sk_secretsecretsecret";

let clusters: Record<string, Cluster[]>;
let flex: Record<string, Cluster[]>;
let alerts: Alert[];
let tokenAnswer: { status: number; body: unknown };
let refuse: { status: number; body: unknown } | undefined;
const calls: string[] = [];
let tokenCalls = 0;

beforeEach(() => {
  clearHttpCache();
  clearMongoCache();
  clusters = {
    [G1]: [{ name: "Cluster0", groupId: G1, stateName: "IDLE", paused: false, mongoDBVersion: "8.0.4" }],
    [G2]: [{ name: "Analytics", groupId: G2, stateName: "IDLE", paused: true }],
  };
  flex = { [G1]: [{ name: "Tiny", groupId: G1, stateName: "IDLE" }], [G2]: [] };
  alerts = [];
  tokenAnswer = { status: 200, body: { access_token: "atlas_access", token_type: "Bearer", expires_in: 3600 } };
  refuse = undefined;
  calls.length = 0;
  tokenCalls = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.pathname === "/api/oauth/token") {
      assert.equal(init?.method, "POST");
      assert.equal(headers.authorization, `Basic ${Buffer.from(`${ID}:${SECRET}`).toString("base64")}`);
      assert.equal(init?.body, "grant_type=client_credentials");
      tokenCalls++;
      return json(tokenAnswer.body, tokenAnswer.status);
    }
    assert.equal(init?.method ?? "GET", "GET", "only ever reads, besides the token");
    assert.equal(headers.authorization, "Bearer atlas_access");
    calls.push(`${url.pathname}${url.search} ${headers.accept}`);
    if (refuse) return json(refuse.body, refuse.status);
    const p = url.pathname.replace(/^\/api\/atlas\/v2/, "");
    if (p === "/groups") return json({ results: [{ id: G1, name: "star-map" }, { id: G2, name: "moon-base" }], totalCount: 2 });
    let m = p.match(/^\/groups\/(\w+)\/clusters$/);
    if (m) return json({ results: clusters[m[1]!] ?? [] });
    m = p.match(/^\/groups\/(\w+)\/flexClusters$/);
    if (m) return json({ results: flex[m[1]!] ?? [] });
    m = p.match(/^\/groups\/(\w+)\/(clusters|flexClusters)\/(.+)$/);
    if (m) {
      const c = (m[2] === "clusters" ? clusters : flex)[m[1]!]?.find((x) => x.name === decodeURIComponent(m![3]!));
      return c ? json(c) : json({ detail: "No cluster named X exists in group Y.", error: 404, errorCode: "CLUSTER_NOT_FOUND", reason: "Not Found" }, 404);
    }
    m = p.match(/^\/groups\/(\w+)\/alerts$/);
    if (m) {
      assert.equal(url.searchParams.get("status"), "OPEN");
      return json({ results: alerts.filter((a) => a.status === "OPEN") });
    }
    return json({ error: 404, reason: "Not Found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "mongodb", name: "My Atlas", canWrite: false }, token: async () => `${ID}:${SECRET}` } as ServiceAuth;
const conn = (groupId: string, clusterName: string, extra = {}): Connection => ({
  id: "c",
  appId: "a",
  type: "mongodb",
  serviceId: "s",
  resource: `x/${clusterName}`,
  settings: { groupId, clusterName, ...extra },
});
const alert = (a: Partial<Alert>): Alert => ({ id: "al1", eventTypeName: "NO_PRIMARY", status: "OPEN", created: "2026-10-29T09:00:00Z", ...a });

describe("MongoDB Atlas: the key", () => {
  test("keyFromPaste takes CLIENT_ID:CLIENT_SECRET, and says what's wrong otherwise", () => {
    assert.equal(keyFromPaste(`  ${ID}:${SECRET}\n`), `${ID}:${SECRET}`);
    assert.equal(keyFromPaste(`${ID}\n${SECRET}`), `${ID}:${SECRET}`, "two lines work too");
    assert.throws(() => keyFromPaste(""), /Paste the client ID and secret first/);
    assert.throws(() => keyFromPaste(SECRET), /only the client secret/);
    assert.throws(() => keyFromPaste(`${SECRET}:${ID}`), /secret comes second/);
    assert.throws(() => keyFromPaste("a:b:c"), /CLIENT_ID:CLIENT_SECRET/);
    assert.throws(() => keyFromPaste(`${ID}:short`), /client secret doesn't look right/);
  });

  test("one token serves every call until shortly before it expires", async () => {
    await mongodb.testService!(auth);
    clearHttpCache();
    await mongodb.check!(conn(G1, "Cluster0"), auth);
    assert.equal(tokenCalls, 1);
  });

  test("a token that's about to expire is asked for again", async () => {
    tokenAnswer = { status: 200, body: { access_token: "atlas_access", expires_in: 200 } }; // under the 5-minute margin: kept 60 s
    await mongodb.testService!(auth);
    clearHttpCache();
    await mongodb.testService!(auth);
    assert.equal(tokenCalls, 1, "still kept within its minute");
    const realNow = Date.now;
    Date.now = () => realNow() + 2 * 60_000;
    try {
      clearHttpCache();
      await mongodb.testService!(auth);
    } finally {
      Date.now = realNow;
    }
    assert.equal(tokenCalls, 2);
  });

  test("rejected credentials say to make a new secret, and aren't kept", async () => {
    tokenAnswer = { status: 401, body: { error: "invalid_client", error_description: "Invalid credentials provided." } };
    await assert.rejects(mongodb.testService!(auth), /rejected the service account's client ID or secret.*Change key/);
    await assert.rejects(mongodb.testService!(auth));
    assert.equal(tokenCalls, 2, "a failure is never cached");
  });

  test("an address not on the access list, or a missing role, says which", async () => {
    refuse = { status: 403, body: { detail: "IP address 1.2.3.4 is not allowed to access this resource.", error: 403, errorCode: "IP_ADDRESS_NOT_ON_ACCESS_LIST", reason: "Forbidden" } };
    await assert.rejects(mongodb.testService!(auth), /Add this computer's IP address/);
    refuse = { status: 403, body: { error: 403, errorCode: "USER_UNAUTHORIZED", reason: "Forbidden" } };
    await assert.rejects(mongodb.testService!(auth), /Organization Read Only/);
    refuse = { status: 401, body: { error: 401, reason: "Unauthorized" } };
    await assert.rejects(mongodb.listResources!(auth), /didn't accept the access token/);
  });

  test("a token Atlas stops accepting is dropped, so the next call signs in again", async () => {
    await mongodb.testService!(auth);
    assert.equal(tokenCalls, 1);
    refuse = { status: 401, body: { error: 401, reason: "Unauthorized" } };
    clearHttpCache();
    await assert.rejects(mongodb.testService!(auth), /didn't accept the access token/);
    refuse = undefined;
    clearHttpCache();
    await mongodb.testService!(auth);
    assert.equal(tokenCalls, 2);
  });
});

describe("MongoDB Atlas: connecting it", () => {
  test("Test counts projects and clusters; the list covers every project, Flex included", async () => {
    assert.equal((await mongodb.testService!(auth)).message, "Connected: 2 projects, 3 clusters");
    const list = await mongodb.listResources!(auth);
    assert.deepEqual(list.map((r) => [r.id, r.label, r.detail, r.settings]), [
      ["star-map/Cluster0", "Cluster0", "star-map · Running", { groupId: G1, clusterName: "Cluster0" }],
      ["star-map/Tiny", "Tiny", "star-map · Flex · Running", { groupId: G1, clusterName: "Tiny", flex: true }],
      ["moon-base/Analytics", "Analytics", "moon-base · Cluster is paused", { groupId: G2, clusterName: "Analytics" }],
    ]);
    assert.ok(calls.some((c) => c.startsWith(`/api/atlas/v2/groups/${G1}/clusters?`) && c.endsWith("application/vnd.atlas.2024-08-05+json")));
    assert.ok(calls.some((c) => c.startsWith("/api/atlas/v2/groups?") && c.endsWith("application/vnd.atlas.2023-01-01+json")));
  });

  test("a Flex cluster that also shows as a regular one is listed once; a project without Flex still lists", async () => {
    clusters[G1]!.push({ name: "Tiny", groupId: G1, stateName: "IDLE" }); // mid-migration: in both lists
    const realFake = globalThis.fetch; // the second project has no Flex endpoint: 404
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes(`/groups/${G2}/flexClusters`) ? new Response(JSON.stringify({ error: 404 }), { status: 404 }) : realFake(input, init)) as typeof fetch;
    const list = await mongodb.listResources!(auth);
    assert.deepEqual(list.map((r) => r.id), ["star-map/Cluster0", "star-map/Tiny", "moon-base/Analytics"]);
    assert.deepEqual(list[1]!.settings, { groupId: G1, clusterName: "Tiny" }, "the regular one wins");
  });

  test("parse: a cluster picked from the list, with its project", () => {
    assert.deepEqual(mongodb.parse({ resource: "star-map/Cluster0", settings: { groupId: G1, clusterName: "Cluster0" } }), {
      resource: "star-map/Cluster0",
      settings: { groupId: G1, clusterName: "Cluster0" },
    });
    assert.throws(() => mongodb.parse({ resource: "star-map/Cluster0", settings: { clusterName: "Cluster0" } }), /Pick the cluster from the list/);
    assert.throws(() => mongodb.parse({ resource: "x", settings: { groupId: G1, clusterName: "bad name" } }), /cluster name looks like/);
  });
});

describe("MongoDB Atlas: a cluster's health", () => {
  test("idle with no alerts is up", async () => {
    const r = await mongodb.check!(conn(G1, "Cluster0"), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "Running · MongoDB 8.0.4");
  });

  test("a Flex cluster is read from its own endpoint", async () => {
    const r = await mongodb.check!(conn(G1, "Tiny", { flex: true }), auth);
    assert.equal(r.state, "up");
    assert.ok(calls.some((c) => c.includes("/flexClusters/Tiny") && c.endsWith("2024-11-13+json")));
  });

  test("paused is down, in words, with a link to the cluster", async () => {
    const r = await mongodb.check!(conn(G2, "Analytics"), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Analytics: Cluster is paused: nothing can connect to it until it's resumed");
    assert.deepEqual(r.link, { url: `https://cloud.mongodb.com/v2/${G2}#/clusters/detail/Analytics`, label: "Open the cluster in Atlas" });
  });

  test("an open alert on the cluster is down, in plain words; others' and acknowledged ones aren't", async () => {
    alerts = [
      alert({ clusterName: "Cluster0", replicaSetName: "atlas-abc-shard-0" }),
      alert({ id: "al2", clusterName: "Other", eventTypeName: "HOST_DOWN" }),
      alert({ id: "al3", clusterName: "Cluster0", eventTypeName: "TOO_MANY_ELECTIONS", acknowledgedUntil: "2999-01-01T00:00:00Z" }),
    ];
    const r = await mongodb.check!(conn(G1, "Cluster0"), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Cluster0: No primary: writes are failing");
    assert.equal(r.summary, "1 open alert · No primary: writes are failing");
    assert.deepEqual(r.link, { url: `https://cloud.mongodb.com/v2/${G1}#/alerts`, label: "Open the alerts in Atlas" });
  });

  test("a cluster that's gone is down; a failure to ask is unknown", async () => {
    assert.equal((await mongodb.check!(conn(G1, "Gone"), auth)).state, "down");
    refuse = { status: 500, body: { error: 500, reason: "Server Error" } };
    assert.equal((await mongodb.check!(conn(G1, "Cluster0"), auth)).state, "unknown");
  });

  test("states and alerts in words", () => {
    assert.equal(describeCluster({ stateName: "IDLE" }).state, "up");
    assert.deepEqual(describeCluster({ stateName: "UPDATING" }), { state: "up", text: "Running, with a change being applied" });
    assert.equal(describeCluster({ stateName: "REPAIRING" }).state, "up", "Atlas keeps a primary while repairing");
    assert.equal(describeCluster({ stateName: "CREATING" }).state, "unknown");
    assert.equal(describeCluster({ stateName: "DELETING" }).state, "down");
    assert.equal(describeAlert(alert({ eventTypeName: "OUTSIDE_METRIC_THRESHOLD", metricName: "DISK_PARTITION_SPACE_USED_DATA", currentValue: { number: 91.234, units: "RAW" }, hostnameAndPort: "cluster0-shard-00-01.abcde.mongodb.net:27017" })),
      "Disk partition space used data is past its alert threshold (91.23 raw) on cluster0-shard-00-01");
    assert.equal(describeAlert(alert({ eventTypeName: "SOMETHING_NEW" })), "Something new");
    const byHost = alert({ id: "h1", hostnameAndPort: "cluster0-shard-00-00.abcde.mongodb.net:27017" });
    assert.deepEqual(
      alertsFor([byHost, alert({ hostnameAndPort: "cluster01-shard-00-00.x.mongodb.net:27017" }), alert({ clusterName: "Other", hostnameAndPort: "cluster0-shard-00-00.x.mongodb.net:27017" })], "Cluster0"),
      [byHost],
      "a host named like the cluster counts only when the alert names no other cluster",
    );
    const lapsed = alert({ clusterName: "Cluster0", acknowledgedUntil: "2026-01-01T00:00:00Z" });
    assert.deepEqual(alertsFor([lapsed], "Cluster0", Date.parse("2026-06-01T00:00:00Z")), [lapsed], "an acknowledgement that ran out counts again");
  });
});
