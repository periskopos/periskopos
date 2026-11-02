import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { after, before, beforeEach, describe, test } from "node:test";
import type { App, Connection } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import { HttpError } from "../server/errors.ts";
import * as history from "../server/history.ts";
import { jsonProblem, site } from "../server/integrations/site.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { StatusService } from "../server/status.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";

// What a status check catches besides "no answer" and HTTP errors: a page
// that answers 200 without what it should have, a health endpoint saying
// no, and a site that's slow for a while. Against a local site whose
// answers the test controls.

let page = "<h1>Welcome</h1>";
let health: unknown = { ok: true, status: "healthy", checks: { db: true } };
let delayMs = 0;
let server: ReturnType<typeof createServer>;
let base = "";
before(async () => {
  server = createServer((req, res) => {
    setTimeout(() => {
      if (req.url === "/health") {
        res.setHeader("content-type", "application/json");
        res.end(typeof health === "string" ? health : JSON.stringify(health));
      } else {
        res.end(page);
      }
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const conn = (path: string, settings: Record<string, unknown>): Connection => ({ id: "c_1", appId: "a_1", type: "site", resource: `${base}${path}`, settings });
const badRequest = (fn: () => unknown, message: RegExp) => assert.throws(fn, (e: unknown) => e instanceof HttpError && e.status === 400 && message.test(e.message));

describe("expected content", () => {
  beforeEach(() => {
    page = "<h1>Welcome</h1>";
    health = { ok: true, status: "healthy", checks: { db: true } };
  });

  test("a page without the text is down, though it answered 200", async () => {
    assert.equal((await site.check!(conn("/", { expectText: "welcome" }))).state, "up", "any case");
    page = "<div id=root></div>";
    const r = await site.check!(conn("/", { expectText: "Welcome" }));
    assert.equal(r.state, "down");
    assert.equal(r.httpStatus, 200);
    assert.equal(r.detail, "The page doesn't contain “Welcome”");
  });

  test("a JSON health field: present and not false, or equal to a value", async () => {
    assert.equal((await site.check!(conn("/health", { expectJson: "ok" }))).state, "up");
    assert.equal((await site.check!(conn("/health", { expectJson: "checks.db" }))).state, "up");
    assert.equal((await site.check!(conn("/health", { expectJson: "status=healthy" }))).state, "up");
    health = { ok: false, status: "unhealthy", checks: { db: false } };
    assert.equal((await site.check!(conn("/health", { expectJson: "ok" }))).detail, "“ok” is false");
    assert.equal((await site.check!(conn("/health", { expectJson: "status=healthy" }))).detail, "“status” is unhealthy, not healthy");
    assert.equal((await site.check!(conn("/health", { expectJson: "checks.cache" }))).detail, "The answer has no “checks.cache”");
    health = "<html>Bad gateway</html>";
    assert.equal((await site.check!(conn("/health", { expectJson: "ok" }))).detail, "Didn't answer JSON");
  });

  test("values compare as text", () => {
    assert.equal(jsonProblem('{"up":1,"v":true}', "up=1"), undefined);
    assert.equal(jsonProblem('{"up":1,"v":true}', "v=true"), undefined);
    assert.equal(jsonProblem('{"a":null}', "a"), "“a” is null");
    assert.equal(jsonProblem("[1]", "ok"), "The answer has no “ok”");
  });

  test("settings are checked when saved; blank is off", () => {
    const parse = (settings: Record<string, unknown>) => site.parse({ resource: `${base}/`, settings }).settings;
    assert.equal(parse({ expectText: "", expectJson: "  ", slowMs: "" }), undefined);
    assert.deepEqual(parse({ expectText: " Sign in ", expectJson: "status=ok", slowMs: "1500" }), { expectText: "Sign in", expectJson: "status=ok", slowMs: 1500, slowChecks: 3 });
    assert.deepEqual(parse({ slowMs: 800, slowChecks: "5" }), { slowMs: 800, slowChecks: 5 });
    assert.deepEqual(parse({ slowChecks: 5 }), undefined, "no threshold, no alert");
    badRequest(() => parse({ expectJson: "status == ok" }), /JSON field must be/);
    badRequest(() => parse({ slowMs: 50 }), /from 100 to 9000/);
    badRequest(() => parse({ slowMs: "fast" }), /whole number/);
    badRequest(() => parse({ slowMs: 1000, slowChecks: 1 }), /Checks in a row/);
    badRequest(() => parse({ expectText: "x".repeat(201) }), /longer than 200/);
  });
});

describe("slow answers (an attention incident, not an outage)", () => {
  let db: DatabaseSync;
  let notices: Notice[];
  let watcher: Watcher;
  let app: App;

  beforeEach(() => {
    delayMs = 0;
    page = "<h1>Welcome</h1>";
    notices = [];
    db = openDb(":memory:");
    const userId = store.createUser(db, "Me").id;
    app = store.createApp(db, userId, { name: "Test App", url: `${base}/` });
    store.updateConnectionSettings(db, app, app.connections[0].id, { slowMs: 100, slowChecks: 3 });
    app = store.getApp(db, userId, app.slug)!;
    watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", status: new StatusService(0), isOnline: async () => true });
  });

  const check = () => watcher.checkConnection(app, app.connections[0]);

  test("slow for the checks in a row it takes opens one, and notifies once", async () => {
    delayMs = 150;
    const first = await check();
    assert.equal(first?.state, "up", "slow is still up");
    assert.match(first?.summary ?? "", /^Slow: \d+ ms, over 100 ms$/);
    await check();
    assert.equal(history.openIncidentFor(db, app.connections[0].id), undefined, "two aren't three");
    await check();
    const incident = history.openIncidentFor(db, app.connections[0].id);
    assert.equal(incident?.kind, "slow");
    assert.match(incident?.reason ?? "", /over 100 ms for 3 checks in a row/);
    await check();
    assert.deepEqual(notices.map((n) => n.title), ["Test App is slow"]);
  });

  test("the first fast answer closes it", async () => {
    delayMs = 150;
    for (let i = 0; i < 3; i++) await check();
    delayMs = 0;
    await check();
    assert.equal(history.openIncidentFor(db, app.connections[0].id), undefined);
    assert.deepEqual(notices.map((n) => n.title), ["Test App is slow", "Test App is fast again"]);
  });

  test("a fast one in between starts the count again", async () => {
    delayMs = 150;
    await check();
    await check();
    delayMs = 0;
    await check();
    delayMs = 150;
    await check();
    await check();
    assert.equal(history.openIncidentFor(db, app.connections[0].id), undefined);
    assert.equal(notices.length, 0);
  });

  test("an outage replaces it: one is open at a time, and the outage is the news", async () => {
    delayMs = 150;
    for (let i = 0; i < 3; i++) await check();
    page = "Oops";
    store.updateConnectionSettings(db, app, app.connections[0].id, { slowMs: 100, slowChecks: 3, expectText: "Welcome" });
    app = store.getApp(db, app.ownerId, app.slug)!;
    await check();
    assert.equal(history.openIncidentFor(db, app.connections[0].id)?.kind, "slow", "one failure is only a failure");
    await check();
    const open = history.openIncidents(db, [app.id]).get(app.id);
    assert.equal(open?.kind, "outage");
    assert.equal(open?.reason, "The page doesn't contain “Welcome”");
    const stillOpen = db.prepare("SELECT kind FROM incidents WHERE connection_id = ? AND ended_at IS NULL").all(app.connections[0].id);
    assert.deepEqual(stillOpen.map((r) => r.kind), ["outage"], "the slow one was closed");
    assert.deepEqual(notices.map((n) => n.title), ["Test App is slow", "Test App is down"]);
  });

  test("switched off while slow: it ends without a notification", async () => {
    delayMs = 150;
    for (let i = 0; i < 3; i++) await check();
    store.updateConnectionSettings(db, app, app.connections[0].id, {});
    app = store.getApp(db, app.ownerId, app.slug)!;
    await check();
    assert.equal(history.openIncidentFor(db, app.connections[0].id), undefined);
    assert.equal(notices.length, 1);
  });

  test("an extra URL is checked on its own and named in its notifications", async () => {
    const extra = store.addConnection(db, app, { type: "site", resource: `${base}/health`, settings: { label: "API health", expectJson: "ok" } });
    app = store.getApp(db, app.ownerId, app.slug)!;
    health = { ok: false };
    await watcher.checkConnection(app, extra);
    await watcher.checkConnection(app, extra);
    assert.equal(history.openIncidentFor(db, extra.id)?.reason, "“ok” is false");
    assert.equal(history.openIncidentFor(db, app.connections[0].id), undefined, "the app's own page is fine");
    assert.deepEqual(notices.map((n) => n.title), ["Test App · API health is down"]);
    health = { ok: true };
  });
});
