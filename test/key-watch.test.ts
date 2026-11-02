import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Service } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import { clearHttpCache } from "../server/http.ts";
import { cloudflareIntegration } from "../server/integrations/cloudflare.ts";
import { github, tokenExpiry } from "../server/integrations/github.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { authFor } from "../server/keys/secrets.ts";
import { updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { KEY_EVERY_MS, KEY_RETRY_MS, TICK_MS, Watcher } from "../server/watcher.ts";

// Account keys are watched, not only tested by hand: the watcher tests each
// one daily, stores what it found as Test does, says when a key stops or
// starts working, and warns 14 days before one expires.

// Keys come from the environment here instead of .env.local.
const KEY = "ghp_watched_secret";
process.env.PERISKOPOS_TEST_KEYWATCH_GH = KEY;
process.env.PERISKOPOS_TEST_KEYWATCH_CF = "cf_watched_secret";

const DAY = 86_400_000;
const realFetch = globalThis.fetch;

// A fake GitHub and Cloudflare: whether GitHub accepts the key, whether it
// answers at all, the expiry header it sends, and what Cloudflare's
// tokens/verify says (nothing: it refuses, as for an account-owned token).
let fake: { accept: boolean; down: boolean; expiry?: string; calls: number; cfVerify?: unknown; whileAsked?: () => void };

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

beforeEach(() => {
  clearHttpCache();
  fake = { accept: true, down: false, calls: 0 };
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.host === "api.github.com" && url.pathname === "/user") {
      fake.calls++;
      fake.whileAsked?.();
      if (fake.down) throw new TypeError("fetch failed");
      if (!fake.accept) return json({ message: "Bad credentials" }, 401);
      return json({ login: "me" }, 200, fake.expiry ? { "github-authentication-token-expiration": fake.expiry } : {});
    }
    if (url.host === "api.cloudflare.com") {
      if (url.pathname === "/client/v4/accounts") return json({ success: true, result: [{ id: "a".repeat(32), name: "Me" }] });
      if (url.pathname === "/client/v4/user/tokens/verify") {
        return fake.cfVerify === undefined ? json({ success: false, errors: [{ message: "Invalid API Token" }] }, 401) : json({ success: true, result: fake.cfVerify });
      }
    }
    return json({ message: "Not Found" }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("expiry from the provider", () => {
  test("GitHub's expiry header, in the forms GitHub sends it", () => {
    assert.equal(tokenExpiry("2026-11-01 12:00:00 UTC"), "2026-11-01T12:00:00.000Z");
    assert.equal(tokenExpiry("2026-11-01 12:00:00 -0800"), "2026-11-01T20:00:00.000Z");
    assert.equal(tokenExpiry("2026-11-01 12:00:00 +05:30"), "2026-11-01T06:30:00.000Z");
    assert.equal(tokenExpiry(null), undefined);
    assert.equal(tokenExpiry("never"), undefined);
  });

  test("testing a GitHub key records its expiry, when GitHub says", async () => {
    const service: Service = { id: "s", ownerId: "u", type: "github", name: "GH", secretRef: "PERISKOPOS_TEST_KEYWATCH_GH", canWrite: false };
    assert.deepEqual(await github.testService!(authFor(service)), { message: "Connected as me" });
    fake.expiry = "2026-11-01 12:00:00 UTC";
    assert.deepEqual(await github.testService!(authFor(service)), { message: "Connected as me", expiresAt: "2026-11-01T12:00:00.000Z" });
  });

  test("testing a Cloudflare key records its expiry from tokens/verify; a token that can't be verified there still works", async () => {
    const service: Service = { id: "s", ownerId: "u", type: "cloudflare", name: "CF", secretRef: "PERISKOPOS_TEST_KEYWATCH_CF", canWrite: false };
    assert.deepEqual(await cloudflareIntegration.testService!(authFor(service)), { message: "Connected to Me" });
    fake.cfVerify = { id: "t", status: "active", expires_on: "2026-12-31T00:00:00Z" };
    assert.deepEqual(await cloudflareIntegration.testService!(authFor(service)), { message: "Connected to Me", expiresAt: "2026-12-31T00:00:00.000Z" });
    fake.cfVerify = { id: "t", status: "active" };
    assert.deepEqual(await cloudflareIntegration.testService!(authFor(service)), { message: "Connected to Me" });
  });
});

describe("the watcher's daily key test", () => {
  let db: DatabaseSync;
  let notices: Notice[];
  let watcher: Watcher;
  let userId: string;
  let service: Service;
  const t0 = Date.parse("2026-10-18T09:00:00Z");
  const lastTest = () => store.getService(db, userId, service.id)!.lastTest;

  beforeEach(() => {
    notices = [];
    db = openDb(":memory:");
    userId = store.createUser(db, "Me").id;
    service = store.createService(db, userId, { type: "github", name: "My GitHub", secretRef: "PERISKOPOS_TEST_KEYWATCH_GH", canWrite: false });
    watcher = new Watcher({ db, notifier: { notify: async (n) => void notices.push(n) }, baseUrl: "http://localhost:4100", isOnline: async () => true });
  });

  test("tests every key once a day and stores what it found, as Test does", async () => {
    await watcher.checkKeys(userId, t0);
    assert.equal(fake.calls, 1);
    assert.deepEqual(lastTest(), { ok: true, message: "Connected as me", at: new Date(t0).toISOString() });
    await watcher.checkKeys(userId, t0 + 6 * 3_600_000);
    assert.equal(fake.calls, 1, "not again the same day");
    await watcher.checkKeys(userId, t0 + KEY_EVERY_MS + TICK_MS);
    assert.equal(fake.calls, 2, "again the next day");
    assert.equal(notices.length, 0, "a working key is no news");
  });

  test("a key changed or removed while it was being tested: that verdict is dropped", async () => {
    store.setServiceLastTest(db, service, { ok: true, message: "Connected as me", at: new Date(t0 - KEY_EVERY_MS).toISOString() });
    const before = lastTest();
    // GitHub refuses the old key just as a new one is pasted.
    fake.accept = false;
    fake.whileAsked = () => void (process.env.PERISKOPOS_TEST_KEYWATCH_GH = "ghp_pasted_meanwhile");
    try {
      await watcher.checkKeys(userId, t0);
    } finally {
      process.env.PERISKOPOS_TEST_KEYWATCH_GH = KEY;
      fake.whileAsked = undefined;
    }
    assert.equal(fake.calls, 1);
    assert.deepEqual(lastTest(), before, "not stored: it was about the old key");
    assert.equal(notices.length, 0, "and no \"key stopped working\"");

    // The account removed while its key was tested.
    fake.whileAsked = () => store.deleteService(db, service);
    await watcher.checkKeys(userId, t0 + KEY_RETRY_MS);
    assert.equal(fake.calls, 2);
    assert.equal(store.getService(db, userId, service.id), undefined);
    assert.equal(notices.length, 0);
  });

  test("a key pressed Test on today isn't tested again until tomorrow", async () => {
    store.setServiceLastTest(db, service, { ok: true, message: "Connected as me", at: new Date(t0).toISOString() });
    await watcher.checkKeys(userId, t0 + 3_600_000);
    assert.equal(fake.calls, 0);
  });

  test("a key that worked and stops working is news, once; working again is news too", async () => {
    await watcher.checkKeys(userId, t0);
    fake.accept = false;
    await watcher.checkKeys(userId, t0 + DAY);
    assert.equal(lastTest()?.ok, false);
    assert.match(lastTest()!.message, /rejected the key \(401\)/);
    assert.deepEqual(notices.map((n) => n.title), ["My GitHub: key stopped working"]);
    assert.match(notices[0]!.body, /rejected the key \(401\)/);
    assert.equal(notices[0]!.url, "http://localhost:4100/#/services");

    await watcher.checkKeys(userId, t0 + 2 * DAY);
    assert.equal(notices.length, 1, "no repeat while it stays broken");

    fake.accept = true;
    await watcher.checkKeys(userId, t0 + 3 * DAY);
    assert.deepEqual(notices.map((n) => n.title), ["My GitHub: key stopped working", "My GitHub: key works again"]);
    for (const n of notices) assert.ok(!JSON.stringify(n).includes(KEY), "the key never appears in a notification");
    assert.ok(!JSON.stringify(lastTest()).includes(KEY));
  });

  test("a key never seen working that fails isn't announced: the Accounts page says so", async () => {
    fake.accept = false;
    await watcher.checkKeys(userId, t0);
    assert.equal(lastTest()?.ok, false);
    assert.equal(notices.length, 0);
  });

  test("no answer from the provider says nothing about the key: the verdict stays, and it's asked again in an hour", async () => {
    await watcher.checkKeys(userId, t0);
    fake.down = true;
    await watcher.checkKeys(userId, t0 + DAY);
    assert.equal(lastTest()?.ok, true, "the last verdict stands");
    assert.equal(lastTest()?.at, new Date(t0).toISOString());
    assert.equal(notices.length, 0);
    await watcher.checkKeys(userId, t0 + DAY + 10 * 60_000);
    assert.equal(fake.calls, 2, "not asked again within the hour");
    fake.down = false;
    await watcher.checkKeys(userId, t0 + DAY + KEY_RETRY_MS);
    assert.equal(fake.calls, 3);
    assert.equal(lastTest()?.at, new Date(t0 + DAY + KEY_RETRY_MS).toISOString());
  });

  test("warns once, 14 days before the key expires; when it then expires, says so", async () => {
    fake.expiry = "2026-11-10 09:00:00 UTC"; // 23 days after t0
    await watcher.checkKeys(userId, t0);
    assert.equal(lastTest()?.expiresAt, "2026-11-10T09:00:00.000Z");
    assert.equal(notices.length, 0, "still more than 14 days");

    for (let day = 1; day <= 8; day++) await watcher.checkKeys(userId, t0 + day * DAY);
    assert.equal(notices.length, 0, "15 days left");
    await watcher.checkKeys(userId, t0 + 9 * DAY);
    assert.deepEqual(notices.map((n) => n.title), ["My GitHub: key expires in 14 days"]);
    assert.match(notices[0]!.body, /^On 2026-11-10\. Make a new one/);
    for (let day = 10; day <= 22; day++) await watcher.checkKeys(userId, t0 + day * DAY);
    assert.equal(notices.length, 1, "warned once, not daily");

    fake.accept = false; // expired: GitHub refuses it
    await watcher.checkKeys(userId, t0 + 23 * DAY + 3_600_000);
    assert.equal(notices.at(-1)?.title, "My GitHub: key stopped working");
    assert.match(notices.at(-1)!.body, /^It expired on 2026-11-10/);
  });

  test("a new key with a new expiry date warns again", async () => {
    fake.expiry = "2026-10-25 09:00:00 UTC";
    await watcher.checkKeys(userId, t0);
    assert.equal(notices.length, 1);
    fake.expiry = "2026-10-28 09:00:00 UTC"; // replaced by another short-lived key
    await watcher.checkKeys(userId, t0 + DAY);
    assert.equal(notices.length, 2);
    assert.equal(notices[1]!.title, "My GitHub: key expires in 9 days");
  });

  test("an account without a key is left alone, and notifications switched off stay off", async () => {
    store.createService(db, userId, { type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_KEYWATCH_NO_SUCH_KEY", canWrite: false });
    updateSettings(db, userId, { notificationsEnabled: false });
    await watcher.checkKeys(userId, t0);
    fake.accept = false;
    await watcher.checkKeys(userId, t0 + DAY);
    assert.equal(notices.length, 0);
    assert.equal(store.listServices(db, userId).find((s) => s.name === "My Render")!.lastTest, undefined);
  });

  test("the tick runs it", async () => {
    await watcher.tick(t0);
    assert.equal(fake.calls, 1);
    assert.equal(lastTest()?.ok, true);
  });
});
