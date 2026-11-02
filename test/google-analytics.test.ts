import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkEvery } from "../shared/catalog.ts";
import type { App, Connection } from "../shared/types.ts";
import {
  DROP_MIN_VISITORS,
  clearAnalyticsCache,
  googleAnalytics as ga,
  rangesOf,
  readKey,
  siteOf,
  trafficDrop,
} from "../server/integrations/google-analytics.ts";
import { keyFromPaste, signedAssertion } from "../server/integrations/google-auth.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Google is faked throughout: nothing here reaches the network. The fake
// checks every token request's signature with the key's public half, and
// that nothing but the token request and runReport is ever POSTed.

const EMAIL = "periskopos@my-project.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyFile = JSON.stringify({ type: "service_account", project_id: "my-project", private_key_id: "k1", private_key: PEM, client_email: EMAIL });
const SAVED = keyFromPaste(keyFile);
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";
const realFetch = globalThis.fetch;

type Call = { method: string; host: string; path: string; body?: Record<string, unknown> };
let calls: Call[];
let summaries: unknown[];
let streams: Record<string, unknown[]>;
let ranges: Record<string, [number, number]>;
let reportError: { status: number; message: string } | undefined;
let tokenAnswer: { status: number; body: unknown } | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearAnalyticsCache();
  calls = [];
  summaries = [
    {
      account: "accounts/1",
      displayName: "Star Labs",
      propertySummaries: [
        { property: "properties/111111", displayName: "Star-Map", propertyType: "PROPERTY_TYPE_ORDINARY" },
        { property: "properties/222222", displayName: "Moon Base", propertyType: "PROPERTY_TYPE_ORDINARY" },
        { property: "properties/333333", displayName: "All sites", propertyType: "PROPERTY_TYPE_ROLLUP" },
      ],
    },
  ];
  streams = {
    "111111": [
      { type: "WEB_DATA_STREAM", displayName: "Web", webStreamData: { defaultUri: "https://www.example.org", measurementId: "G-AAA" } },
      { type: "IOS_APP_DATA_STREAM", displayName: "iOS" },
    ],
    "222222": [{ type: "WEB_DATA_STREAM", displayName: "Web", webStreamData: { defaultUri: "example.net" } }],
  };
  // Steady: 200 visitors a week, 800 in 28 days.
  ranges = { week: [200, 260], previousWeek: [200, 250], month: [800, 1000] };
  reportError = undefined;
  tokenAnswer = undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.host === "oauth2.googleapis.com") {
      calls.push({ method, host: url.host, path: "/token" });
      const form = new URLSearchParams(String(init?.body));
      const [h, c, s] = form.get("assertion")!.split(".");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, "base64url")), "signed with the service account's key");
      assert.equal((JSON.parse(Buffer.from(c!, "base64url").toString()) as { scope: string }).scope, SCOPE, "read-only, always");
      if (tokenAnswer) return json(tokenAnswer.body, tokenAnswer.status);
      return json({ access_token: "ya29.fake", expires_in: 3599 });
    }
    assert.equal(headers.authorization, "Bearer ya29.fake");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, host: url.host, path: url.pathname, ...(body ? { body } : {}) });
    if (url.host === "analyticsadmin.googleapis.com") {
      assert.equal(method, "GET", "the Admin API is only read");
      if (url.pathname === "/v1beta/accountSummaries") return json({ accountSummaries: summaries });
      const m = url.pathname.match(/^\/v1beta\/properties\/(\d+)\/dataStreams$/);
      if (m) return json({ dataStreams: streams[m[1]!] ?? [] });
    }
    if (url.host === "analyticsdata.googleapis.com") {
      assert.equal(method, "POST");
      assert.match(url.pathname, /^\/v1beta\/properties\/\d+:runReport$/, "a report is the only thing POSTed");
      if (reportError) return json({ error: { code: reportError.status, message: reportError.message } }, reportError.status);
      const rows = Object.entries(ranges)
        .filter(([, [users]]) => users > 0)
        .map(([name, [users, sessions]]) => ({ dimensionValues: [{ value: name }], metricValues: [{ value: String(users) }, { value: String(sessions) }] }));
      return json({ dimensionHeaders: [{ name: "dateRange" }], metricHeaders: [{ name: "activeUsers" }, { name: "sessions" }], rows });
    }
    return json({ error: { code: 404, message: "nope" } }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const auth = { service: { id: "s", ownerId: "u", type: "google-analytics", name: "GA", canWrite: false }, token: async () => SAVED } as ServiceAuth;
const conn = (id = "111111"): Connection => ({ id: "c", appId: "a", type: "google-analytics", serviceId: "s", resource: id });
const app = (url: string) => ({ url }) as App;

describe("the service account key", () => {
  test("the same JSON key as Search Console, read and signed for Analytics, read-only", () => {
    assert.match(SAVED, /^gsa\.[A-Za-z0-9_-]+$/);
    assert.deepEqual(readKey(SAVED), { client_email: EMAIL, private_key: PEM, private_key_id: "k1" });
    assert.equal(ga.keyFromPaste, keyFromPaste, "pasted like Search Console's");
    assert.throws(() => readKey("sk-123"), /saved Google Analytics key isn't a service account key/);
    const now = Date.UTC(2026, 9, 18, 12);
    const [, c] = signedAssertion(readKey(SAVED), SCOPE, now).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(c!, "base64url").toString()), { iss: EMAIL, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now / 1000, exp: now / 1000 + 3600 });
  });

  test("a key Google rejects says so, in words", async () => {
    tokenAnswer = { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } };
    await assert.rejects(ga.testService!(auth), /Google rejected the service account key \(Invalid JWT Signature\.\)/);
  });

  test("one token serves many calls", async () => {
    await ga.testService!(auth);
    await ga.check!(conn(), auth);
    assert.equal(calls.filter((c) => c.path === "/token").length, 1);
  });
});

describe("google analytics account", () => {
  test("testing the key says whose it is and what it sees", async () => {
    assert.deepEqual(await ga.testService!(auth), { message: `Connected as ${EMAIL}: 2 properties visible` });
    summaries = [];
    clearAnalyticsCache();
    assert.match((await ga.testService!(auth)).message, /no Analytics property has added it yet/);
  });

  test("lists ordinary properties with their web addresses; roll-ups are left out", async () => {
    assert.deepEqual(await ga.listResources!(auth), [
      { id: "111111", label: "Star-Map", detail: "example.org · Star Labs", settings: { name: "Star-Map", sites: ["example.org"] } },
      { id: "222222", label: "Moon Base", detail: "example.net · Star Labs", settings: { name: "Moon Base", sites: ["example.net"] } },
    ]);
    assert.ok(calls.every((c) => c.method === "GET" || c.path === "/token"), "listing only reads");
  });

  test("no property shared yet: the list says whose email to add as Viewer", async () => {
    summaries = [];
    await assert.rejects(ga.listResources!(auth), new RegExp(`add ${EMAIL.replace(/\./g, "\\.")} as a Viewer`));
  });

  test("the app's property: its own address first, else the nearest domain around it", async () => {
    const list = await ga.listResources!(auth);
    assert.equal(ga.matchApp!(app("https://example.org"), list)?.id, "111111", "www. or not, the same site");
    assert.equal(ga.matchApp!(app("https://app.example.net/x"), list)?.id, "222222");
    assert.equal(ga.matchApp!(app("https://elsewhere.example.com"), list), undefined);
    assert.deepEqual(ga.suggestedSettings!(app("https://example.org"), list[0]!), { name: "Star-Map" }, "addresses aren't kept");
    assert.equal(siteOf("https://www.Example.org/path"), "example.org");
    assert.equal(siteOf("example.org"), "example.org");
  });

  test("parse takes a property number, nothing else", () => {
    assert.deepEqual(ga.parse({ resource: "properties/111111", settings: { name: "Star-Map", sites: ["x"] } }), { resource: "111111", settings: { name: "Star-Map" } });
    assert.deepEqual(ga.parse({ resource: "111111", settings: {} }), { resource: "111111" });
    assert.throws(() => ga.parse({ resource: "G-ABC123", settings: {} }), /its number/);
    assert.throws(() => ga.parse({ resource: "UA-1234-1", settings: {} }));
  });

  test("checked every 6 hours, and a drop needs attention, it isn't an outage", () => {
    assert.equal(checkEvery("google-analytics", 5), "every 6 h");
    assert.equal(ga.incidentKind, "traffic");
    assert.equal(ga.confirmFailures, 1);
  });
});

describe("week over week", () => {
  const v = (visitors: number) => ({ visitors, sessions: visitors });

  test("at least half the visitors gone, from a week with enough of them", () => {
    assert.deepEqual(trafficDrop(v(50), v(100)), { visitors: 50, before: 100, dropPct: 50 }, "exactly half is a drop");
    assert.equal(trafficDrop(v(51), v(100)), undefined, "49% fewer isn't");
    assert.equal(trafficDrop(v(0), v(DROP_MIN_VISITORS - 1)), undefined, "a tiny site falling to nothing is noise");
    assert.deepEqual(trafficDrop(v(0), v(DROP_MIN_VISITORS)), { visitors: 0, before: 50, dropPct: 100 });
    assert.equal(trafficDrop(v(500), v(100)), undefined, "a rise is no news");
  });

  test("a range with no visitors has no row: it counts as none", () => {
    assert.deepEqual(rangesOf({ rows: [{ dimensionValues: [{ value: "month" }], metricValues: [{ value: "12" }, { value: "15" }] }] }), {
      week: { visitors: 0, sessions: 0 },
      previousWeek: { visitors: 0, sessions: 0 },
      month: { visitors: 12, sessions: 15 },
    });
    assert.deepEqual(rangesOf({}).week, { visitors: 0, sessions: 0 });
  });
});

describe("google analytics check", () => {
  test("steady visitors: up, with 7 and 28 days in the summary, from one report", async () => {
    ranges = { week: [1234, 1500], previousWeek: [1100, 1400], month: [4980, 6000] };
    const r = await ga.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.equal(r.summary, "1,234 visitors in 7 days · 4,980 in 28 · +12% on the week before");
    const reports = calls.filter((c) => c.path.endsWith(":runReport"));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.path, "/v1beta/properties/111111:runReport");
    assert.deepEqual(
      (reports[0]!.body!.dateRanges as { startDate: string; endDate: string }[]).map((d) => [d.startDate, d.endDate]),
      [
        ["7daysAgo", "yesterday"],
        ["14daysAgo", "8daysAgo"],
        ["28daysAgo", "yesterday"],
      ],
    );
    await ga.check!(conn(), auth);
    assert.equal(calls.filter((c) => c.path.endsWith(":runReport")).length, 1, "the answer is reused for a while");
  });

  test("visitors halved week over week: needs attention, with the numbers and where to look", async () => {
    ranges = { week: [380, 400], previousWeek: [1000, 1100], month: [2800, 3000] };
    const r = await ga.check!(conn(), auth);
    assert.equal(r.state, "down");
    assert.equal(r.detail, "Visitors fell 62% week over week: 380 visitors in the last 7 days, 1,000 the week before");
    assert.deepEqual(r.link, { url: "https://analytics.google.com/analytics/web/#/p111111/reports/intelligenthome", label: "Open Google Analytics" });
    assert.equal(ga.notice!("down", "Star-Map", r.detail!, 0).title, "Star-Map: visitors fell sharply");
  });

  test("a small site losing most of its few visitors doesn't flap", async () => {
    ranges = { week: [2, 2], previousWeek: [30, 30], month: [100, 100] };
    assert.equal((await ga.check!(conn(), auth)).state, "up");
  });

  test("no visitors at all: up, asking whether the tag is on the site", async () => {
    ranges = { week: [0, 0], previousWeek: [0, 0], month: [0, 0] };
    const r = await ga.check!(conn(), auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /No visitors in the last 28 days: is the Google tag on the site\?/);
  });

  test("property not shared with the service account: unknown, naming the email to add as Viewer", async () => {
    reportError = { status: 403, message: "User does not have sufficient permissions for this property." };
    const r = await ga.check!(conn(), auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, new RegExp(`add ${EMAIL.replace(/\./g, "\\.")} as a Viewer`));
  });

  test("the Data API not turned on: says to turn it on", async () => {
    reportError = { status: 403, message: "Google Analytics Data API has not been used in project 123 before or it is disabled." };
    assert.match((await ga.check!(conn(), auth)).detail!, /Data API and Admin API need turning on/);
  });

  test("no account: unknown, said plainly", async () => {
    assert.equal((await ga.check!(conn())).detail, "No Google Analytics account connected");
  });
});
