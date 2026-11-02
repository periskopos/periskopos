import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { appDetail } from "../mcp/shape.ts";
import { checkEvery } from "../shared/catalog.ts";
import type { App, ServiceView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import {
  DROP_MIN_CLICKS,
  clearSearchCache,
  keyFromPaste,
  readKey,
  searchConsole as gsc,
  searchDetails,
  searchDrop,
  shapeDays,
  signedAssertion,
  totalsOf,
} from "../server/integrations/search-console.ts";
import { authFor } from "../server/keys/secrets.ts";
import * as store from "../server/store.ts";
import { tempDir } from "./tmp.ts";

// Google is faked throughout: nothing here reaches the network. The fake
// checks every token request's signature with the key's public half, so
// what's signed is what Google would see.

const EMAIL = "periskopos@my-project.iam.gserviceaccount.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const keyFile = JSON.stringify(
  {
    type: "service_account",
    project_id: "my-project",
    private_key_id: "k1",
    private_key: PEM,
    client_email: EMAIL,
    client_id: "123",
    token_uri: "https://oauth2.googleapis.com/token",
  },
  null,
  2,
);
process.env.PERISKOPOS_TEST_GSC_KEY = keyFromPaste(keyFile);

const SITE = "sc-domain:example.org";
const DAY = 86_400_000;
const TOKEN = "t".repeat(43);
const realFetch = globalThis.fetch;
const dayAt = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);

type Call = { method: string; path: string; body?: Record<string, unknown> };
let calls: Call[];
let sites: { siteUrl: string; permissionLevel: string }[];
let clicksByDaysAgo: (daysAgo: number) => number;
let refuseQueries: boolean;
let tokenAnswer: { status: number; body: unknown } | undefined;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearSearchCache();
  calls = [];
  sites = [
    { siteUrl: SITE, permissionLevel: "siteRestrictedUser" },
    { siteUrl: "https://blog.example.org/", permissionLevel: "siteFullUser" },
    { siteUrl: "https://someone-else.com/", permissionLevel: "siteUnverifiedUser" },
  ];
  // Steady: 20 clicks a day, final data up to 3 days ago.
  clicksByDaysAgo = () => 20;
  refuseQueries = false;
  tokenAnswer = undefined;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (url.host === "oauth2.googleapis.com") {
      const form = new URLSearchParams(String(init?.body));
      calls.push({ method, path: "/token" });
      assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [h, c, s] = form.get("assertion")!.split(".");
      assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, "base64url")), "signed with the service account's key");
      const claims = JSON.parse(Buffer.from(c!, "base64url").toString()) as Record<string, unknown>;
      assert.equal(claims.scope, "https://www.googleapis.com/auth/webmasters.readonly", "read-only, always");
      if (tokenAnswer) return json(tokenAnswer.body, tokenAnswer.status);
      return json({ access_token: "ya29.fake", expires_in: 3599, token_type: "Bearer" });
    }
    assert.equal(url.host, "www.googleapis.com");
    assert.equal(headers.authorization, "Bearer ya29.fake");
    const p = url.pathname.replace("/webmasters/v3", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path: p, ...(body ? { body } : {}) });
    if (p === "/sites" && method === "GET") return json({ siteEntry: sites });
    if (p === `/sites/${encodeURIComponent(SITE)}/searchAnalytics/query` && method === "POST") {
      if (refuseQueries) return json({ error: { code: 403, message: "User does not have sufficient permission for site 'sc-domain:example.org'." } }, 403);
      const dims = body!.dimensions as string[];
      if (dims[0] === "date") {
        const rows = [];
        for (let ago = 40; ago >= 3; ago--) {
          const clicks = clicksByDaysAgo(ago);
          rows.push({ keys: [dayAt(ago)], clicks, impressions: clicks * 10, ctr: 0.1, position: 8 });
        }
        return json({ rows });
      }
      if (dims[0] === "query") {
        return json({ rows: [{ keys: ["star map"], clicks: 90, impressions: 300, ctr: 0.3, position: 1.24 }, { keys: ["exoplanet viewer"], clicks: 10, impressions: 900, ctr: 0.01, position: 7.9 }] });
      }
    }
    return json({ error: { code: 404, message: "nope" } }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

function setUp() {
  const db = openDb(":memory:");
  const user = store.createUser(db, "Me");
  const service = store.createService(db, user.id, { type: "search-console", name: "My Search Console", secretRef: "PERISKOPOS_TEST_GSC_KEY", canWrite: false });
  const app = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org" });
  const conn = store.addConnection(db, app, { type: "search-console", serviceId: service.id, ...gsc.parse({ resource: SITE, settings: {} }) });
  return { db, user, service, conn, auth: authFor(service) };
}

describe("the service account key", () => {
  test("the pasted JSON file is saved as one line, keeping only what signing needs", () => {
    const saved = keyFromPaste(keyFile);
    assert.match(saved, /^gsa\.[A-Za-z0-9_-]+$/, "no spaces, quotes or line breaks for the keys file");
    assert.deepEqual(readKey(saved), { client_email: EMAIL, private_key: PEM, private_key_id: "k1" });
    // A password box drops the line breaks when it's pasted into: still the same key.
    assert.deepEqual(readKey(keyFromPaste(keyFile.replace(/\n/g, ""))), readKey(saved));
    assert.deepEqual(readKey(keyFile), readKey(saved), "the JSON itself, written into the keys file by hand");
  });

  test("anything else is refused, saying what's wrong", () => {
    assert.throws(() => keyFromPaste(""), /Paste the key first/);
    assert.throws(() => keyFromPaste("ya29.something"), /whole JSON key file/);
    assert.throws(() => keyFromPaste(JSON.stringify({ type: "authorized_user", client_id: "x" })), /isn't a service account key/);
    assert.throws(() => keyFromPaste(JSON.stringify({ type: "service_account", client_email: EMAIL, private_key: "-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----\n" })), /can't be read/);
    assert.throws(() => readKey("rnd_123"), /isn't a service account key/);
  });

  test("the token request is signed for Search Console, read-only, for an hour", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const [h, c, s] = signedAssertion(readKey(keyFromPaste(keyFile)), now).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(h!, "base64url").toString()), { alg: "RS256", typ: "JWT", kid: "k1" });
    assert.deepEqual(JSON.parse(Buffer.from(c!, "base64url").toString()), {
      iss: EMAIL,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now / 1000,
      exp: now / 1000 + 3600,
    });
    assert.ok(verify("RSA-SHA256", Buffer.from(`${h}.${c}`), publicKey, Buffer.from(s!, "base64url")));
  });

  test("pasting it on the Accounts page: one line in the keys file, never in an answer", async () => {
    const keysFile = path.join(tempDir("periskopos-keys-"), ".env.local");
    process.env.PERISKOPOS_ENV_FILE = keysFile;
    try {
      const db = openDb(":memory:");
      store.createUser(db, "Me");
      const dist = tempDir("periskopos-web-");
      writeFileSync(path.join(dist, "index.html"), "");
      const gc = createApp({ db, token: TOKEN, port: 4100, distDir: dist });
      const post = (p: string, body: unknown) =>
        gc.request(`http://localhost:4100/api${p}`, { method: "POST", headers: { "x-periskopos-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
      const res = await post("/services", { type: "search-console", name: "Search", key: keyFile });
      assert.equal(res.status, 201);
      const text = await res.text();
      assert.ok(!text.includes("PRIVATE KEY") && !text.includes("gsa."), "the answer never carries the key");
      const service = (JSON.parse(text) as { service: ServiceView }).service;
      assert.equal(service.secretRef, "GOOGLE_SEARCH_CONSOLE_KEY");
      const lines = readFileSync(keysFile, "utf8").trim().split("\n");
      assert.equal(lines.length, 1);
      assert.match(lines[0]!, /^GOOGLE_SEARCH_CONSOLE_KEY=gsa\.[A-Za-z0-9_-]+$/);

      const wrong = await post("/services", { type: "search-console", name: "Search 2", key: "not json" });
      assert.equal(wrong.status, 400);
      assert.match(await wrong.text(), /whole JSON key file/);
      const changed = await post(`/services/${service.id}/key`, { key: "{}" });
      assert.equal(changed.status, 400, "Change key checks the file the same way");
    } finally {
      delete process.env.PERISKOPOS_ENV_FILE;
    }
  });
});

describe("search console account", () => {
  test("testing the key says whose it is and what it sees; one token serves many calls", async () => {
    const { auth, conn } = setUp();
    assert.deepEqual(await gsc.testService!(auth), { message: `Connected as ${EMAIL}: 2 properties visible` });
    // Other calls than the first (its answer is kept), on the same token.
    await gsc.check!(conn, auth);
    assert.ok(calls.some((c) => c.path.endsWith("/searchAnalytics/query")));
    assert.equal(calls.filter((c) => c.path === "/token").length, 1);
    clearSearchCache(); // answers forgotten, the token too: asked once more
    await gsc.testService!(auth);
    assert.equal(calls.filter((c) => c.path === "/token").length, 2);
  });

  test("a key Google rejects says so, in words", async () => {
    const { auth } = setUp();
    tokenAnswer = { status: 400, body: { error: "invalid_grant", error_description: "Invalid JWT Signature." } };
    await assert.rejects(gsc.testService!(auth), /Google rejected the service account key \(Invalid JWT Signature\.\)/);
  });

  test("a key no property has added yet still works, and the list says what to do", async () => {
    const { auth } = setUp();
    sites = [];
    assert.match((await gsc.testService!(auth)).message, /no property has added it as a user yet/);
    await assert.rejects(gsc.listResources!(auth), new RegExp(`Add user, and add ${EMAIL.replace(/\./g, "\\.")}`));
  });

  test("lists the properties it can read, by the name people know them by", async () => {
    const { auth } = setUp();
    assert.deepEqual(await gsc.listResources!(auth), [
      { id: SITE, label: "example.org", detail: "Domain property · restricted access" },
      { id: "https://blog.example.org/", label: "blog.example.org", detail: "URL-prefix property · full access" },
    ]);
  });

  test("parse takes a domain or URL-prefix property, nothing else", () => {
    assert.deepEqual(gsc.parse({ resource: "sc-domain:Example.org", settings: {} }), { resource: SITE });
    assert.deepEqual(gsc.parse({ resource: "https://example.org/", settings: {} }), { resource: "https://example.org/" });
    assert.throws(() => gsc.parse({ resource: "example.org", settings: {} }), /sc-domain:example\.com or https:\/\/example\.com\//);
    assert.throws(() => gsc.parse({ resource: "https://example.org/page", settings: {} }));
    assert.throws(() => gsc.parse({ resource: "ftp://example.org/", settings: {} }));
  });

  test("the app's property: its own address first, else the narrowest domain it's on", () => {
    const app = (url: string) => ({ url }) as App;
    const r = (id: string) => ({ id, label: id });
    const list = [r("sc-domain:example.org"), r("sc-domain:blog.example.org"), r("https://www.example.org/")];
    assert.equal(gsc.matchApp!(app("https://www.example.org/"), list)?.id, "https://www.example.org/");
    assert.equal(gsc.matchApp!(app("https://a.blog.example.org"), list)?.id, "sc-domain:blog.example.org");
    assert.equal(gsc.matchApp!(app("https://example.org"), list)?.id, "sc-domain:example.org");
    assert.equal(gsc.matchApp!(app("https://elsewhere.example.com"), list), undefined);
    assert.equal(gsc.suggestOnlyMatched, true);
  });

  test("checked every 6 hours, and a drop needs attention, it isn't an outage", () => {
    assert.equal(checkEvery("search-console", 5), "every 6 h");
    assert.equal(gsc.incidentKind, "search");
    assert.equal(gsc.confirmFailures, 1);
  });
});

describe("week over week", () => {
  const t = (clicks: number) => totalsOf([{ date: "2026-10-01", clicks, impressions: clicks * 10, position: 5 }]);

  test("at least half the clicks gone, from a week with enough of them", () => {
    assert.deepEqual(searchDrop(t(50), t(100)), { clicks: 50, before: 100, dropPct: 50 }, "exactly half is a drop");
    assert.equal(searchDrop(t(51), t(100)), undefined, "49% fewer isn't");
    assert.equal(searchDrop(t(0), t(DROP_MIN_CLICKS - 1)), undefined, "a tiny site falling to nothing is noise");
    assert.deepEqual(searchDrop(t(0), t(DROP_MIN_CLICKS)), { clicks: 0, before: 50, dropPct: 100 });
    assert.equal(searchDrop(t(500), t(100)), undefined, "a rise is no news");
  });

  test("days: 28 up to the newest with data; days long past with no rows had nothing", () => {
    const now = Date.UTC(2026, 9, 18, 12);
    const row = (date: string, clicks: number) => ({ keys: [date], clicks, impressions: 100, position: 4 });
    // Data through Oct 15 (3 days late): the newest day it has.
    let d = shapeDays([row("2026-10-15", 5), row("2026-09-20", 7)], now);
    assert.equal(d.through, "2026-10-15");
    assert.equal(d.days.length, 28);
    assert.equal(d.days[0]!.date, "2026-09-18");
    assert.deepEqual(d.days.at(-1), { date: "2026-10-15", clicks: 5, impressions: 100, position: 4 });
    assert.deepEqual(d.days[1], { date: "2026-09-19", clicks: 0, impressions: 0 }, "a day without rows is zero");
    // The newest rows are from weeks ago: the site vanished from search,
    // so the days since count as zero, up to when data should be in.
    d = shapeDays([row("2026-09-25", 30)], now);
    assert.equal(d.through, "2026-10-14");
    assert.equal(d.days.at(-1)!.clicks, 0);
    assert.deepEqual(shapeDays([], now), { days: [] });
  });

  test("totals: click rate, and position weighted by how often it was shown", () => {
    assert.deepEqual(
      totalsOf([
        { date: "a", clicks: 10, impressions: 100, position: 2 },
        { date: "b", clicks: 0, impressions: 300, position: 10 },
        { date: "c", clicks: 0, impressions: 0 },
      ]),
      { clicks: 10, impressions: 400, ctrPct: 2.5, position: 8 },
    );
    assert.deepEqual(totalsOf([]), { clicks: 0, impressions: 0 });
  });
});

describe("search console check and details", () => {
  test("steady clicks: up, with the week's clicks and change in the summary", async () => {
    const { conn, auth } = setUp();
    const r = await gsc.check!(conn, auth);
    assert.equal(r.state, "up");
    assert.match(r.summary!, /^140 clicks in the 7 days to \w{3} \d+ · ±0% on the week before · avg position 8$/);
  });

  test("clicks halved week over week: needs attention, with the reason and where to look", async () => {
    const { conn, auth } = setUp();
    clicksByDaysAgo = (ago) => (ago <= 9 ? 5 : 20); // the last 7 days of data: 5 a day
    const r = await gsc.check!(conn, auth);
    assert.equal(r.state, "down");
    assert.match(r.detail!, /^Search clicks fell 75% week over week: 35 clicks in the 7 days to \w{3} \d+, 140 the week before$/);
    assert.equal(r.link?.label, "Open Search Console");
    assert.match(r.link!.url, /resource_id=sc-domain%3Aexample\.org/);
    assert.equal(gsc.notice!("down", "Star-Map", r.detail!, 0).title, "Star-Map: search clicks fell sharply");
  });

  test("a small site losing most of its few clicks doesn't flap", async () => {
    const { conn, auth } = setUp();
    clicksByDaysAgo = (ago) => (ago <= 9 ? 0 : 3); // 21 clicks the week before
    assert.equal((await gsc.check!(conn, auth)).state, "up");
  });

  test("access refused: unknown, naming the email to add", async () => {
    const { conn, auth } = setUp();
    refuseQueries = true;
    const r = await gsc.check!(conn, auth);
    assert.equal(r.state, "unknown");
    assert.match(r.detail!, new RegExp(`Add ${EMAIL.replace(/\./g, "\\.")} as a user on this property`));
  });

  test("details: 7 and 28 days, the week before, top queries, all from one cached read", async () => {
    const { conn, auth } = setUp();
    const d = await searchDetails(conn, auth);
    assert.equal(d.shape, "search");
    assert.equal(d.site, "example.org");
    assert.equal(d.through, dayAt(3));
    assert.equal(d.days.length, 28);
    assert.deepEqual(d.totals.week, { clicks: 140, impressions: 1400, ctrPct: 10, position: 8 });
    assert.equal(d.totals.month.clicks, 560);
    assert.equal(d.drop, undefined);
    assert.deepEqual(d.topQueries.week[0], { query: "star map", clicks: 90, impressions: 300, position: 1.2 });
    const queryCalls = calls.filter((c) => c.body?.dimensions && (c.body.dimensions as string[])[0] === "query");
    assert.deepEqual(
      queryCalls.map((c) => [c.body!.startDate, c.body!.endDate]).sort(),
      [
        [dayAt(9), dayAt(3)],
        [dayAt(30), dayAt(3)],
      ].sort(),
      "the windows end on the newest day with data",
    );
    const before = calls.length;
    await searchDetails(conn, auth);
    await gsc.check!(conn, auth);
    assert.equal(calls.length, before, "the page's refresh and the check reuse the answers");
  });
});

describe("what the AI assistant is told", () => {
  test("get_app carries the search numbers and a drop, never the key", async () => {
    const { db, user, conn, auth } = setUp();
    clicksByDaysAgo = (ago) => (ago <= 9 ? 5 : 20);
    const app = store.listApps(db, user.id)[0]!;
    const out = appDetail({ app, status: undefined, history: undefined, details: [await searchDetails(conn, auth)], providers: [], activity: [], services: [] });
    const search = (out as { search?: Record<string, unknown> }).search!;
    assert.equal(search.site, "example.org");
    assert.equal(search.through, dayAt(3));
    assert.deepEqual(search.last7Days, { clicks: 35, impressions: 350, clickRate: "10%", averagePosition: 8 });
    assert.equal((search.weekBefore as { clicks: number }).clicks, 140);
    assert.equal((search.topQueries7Days as { query: string }[])[0]!.query, "star map");
    assert.equal(search.problem, "Clicks fell 75% week over week (35 against 140)");
    const text = JSON.stringify(out);
    assert.ok(!text.includes("PRIVATE KEY") && !text.includes("gsa.") && !text.includes(EMAIL));
  });
});
