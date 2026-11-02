import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import type { Service } from "../shared/types.ts";
import { ProviderError } from "../server/http.ts";
import { SERVICE_TYPES } from "../server/integrations/index.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";
import { testKey } from "../server/keys/keys.ts";

// Testing an account's key (FR-S2): what the test found, and whether the
// failure says anything about the key. A provider that's down or doesn't
// answer is transient, so the watcher keeps its last verdict; a refusal is
// a real "this key doesn't work".

process.env.PERISKOPOS_TEST_KEYS_RENDER = "rnd_test_secret";

const NOW = Date.parse("2026-10-27T09:00:00.000Z");
const realTest = SERVICE_TYPES.render.testService;
afterEach(() => {
  SERVICE_TYPES.render.testService = realTest;
});

const service = (over: Partial<Service> = {}): Service => ({
  id: "s1", ownerId: "u1", type: "render", name: "My Render", secretRef: "PERISKOPOS_TEST_KEYS_RENDER", canWrite: false, ...over,
});

function provider(answer: (auth: ServiceAuth) => Promise<{ message: string; expiresAt?: string }>) {
  SERVICE_TYPES.render.testService = answer;
}

describe("testing a key", () => {
  test("a working key is ok, with the provider's message and the time of the test", async () => {
    let token = "";
    provider(async (auth) => {
      token = await auth.token();
      return { message: "Signed in as me" };
    });
    const { result, transient } = await testKey(service(), NOW);
    assert.equal(token, "rnd_test_secret", "the test uses the account's own key");
    assert.deepEqual(result, { ok: true, message: "Signed in as me", at: "2026-10-27T09:00:00.000Z" });
    assert.equal(transient, false);
  });

  test("keeps the key's expiry when the provider says it", async () => {
    provider(async () => ({ message: "ok", expiresAt: "2026-11-10T00:00:00.000Z" }));
    const { result } = await testKey(service(), NOW);
    assert.equal(result.expiresAt, "2026-11-10T00:00:00.000Z");
  });

  test("a refused key is a real failure", async () => {
    for (const status of [401, 403]) {
      provider(async () => {
        throw new ProviderError(status, "Render refused the key");
      });
      const { result, transient } = await testKey(service(), NOW);
      assert.deepEqual(result, { ok: false, message: "Render refused the key", at: "2026-10-27T09:00:00.000Z" });
      assert.equal(transient, false, `status ${status} is about the key`);
    }
  });

  test("no answer, a rate limit, or the provider failing says nothing about the key", async () => {
    for (const status of [0, 429, 500, 503]) {
      provider(async () => {
        throw new ProviderError(status, "Render isn't answering");
      });
      const { result, transient } = await testKey(service(), NOW);
      assert.equal(result.ok, false);
      assert.equal(transient, true, `status ${status} is transient`);
    }
  });

  test("a key that isn't in the keys file is a real failure, naming where it goes", async () => {
    provider(async (auth) => ({ message: await auth.token() }));
    const { result, transient } = await testKey(service({ secretRef: "PERISKOPOS_TEST_KEYS_NOT_SET" }), NOW);
    assert.equal(result.ok, false);
    assert.match(result.message, /^Add PERISKOPOS_TEST_KEYS_NOT_SET=… to /);
    assert.equal(transient, false);
  });

  test("an account with no key at all is a real failure", async () => {
    provider(async (auth) => ({ message: await auth.token() }));
    const { result, transient } = await testKey(service({ secretRef: undefined }), NOW);
    assert.deepEqual(result, { ok: false, message: "My Render has no key configured", at: "2026-10-27T09:00:00.000Z" });
    assert.equal(transient, false);
  });

  test("the result never carries the key", async () => {
    provider(async () => {
      throw new ProviderError(401, "Render refused the key", "rnd_test_secret is not valid");
    });
    const { result } = await testKey(service(), NOW);
    assert.ok(!JSON.stringify(result).includes("rnd_test_secret"));
  });
});
