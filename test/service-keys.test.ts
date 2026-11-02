import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { ServiceView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import { freeKeyName } from "../server/keys/secrets.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// Connecting a service by pasting its key on screen (Services → Connect a
// service): the key goes into the keys file, and nowhere else.

const TOKEN = "t".repeat(43);
const BASE = "http://localhost:4100";
let gc: ReturnType<typeof createApp>;
let keysFile: string;

beforeEach(() => {
  keysFile = path.join(tempDir("periskopos-keys-"), "nested", ".env.local");
  process.env.PERISKOPOS_ENV_FILE = keysFile;
  const db = openDb(":memory:");
  store.createUser(db, "Me");
  const dist = tempDir("periskopos-web-");
  writeFileSync(path.join(dist, "index.html"), "");
  gc = createApp({ db, token: TOKEN, port: 4100, distDir: dist, watcher: new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true }) });
});
afterEach(() => {
  delete process.env.PERISKOPOS_ENV_FILE;
});

async function api(method: string, p: string, body?: unknown) {
  const res = await gc.request(`${BASE}/api${p}`, { method, headers: { "x-periskopos-token": TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, text: await res.text(), cache: res.headers.get("cache-control") };
}

describe("pasting a key", () => {
  test("is saved in the keys file under its own name, and never comes back", async () => {
    const res = await api("POST", "/services", { type: "render", name: "My Render", key: "  rnd_secret123  " });
    assert.equal(res.status, 201);
    assert.ok(!res.text.includes("rnd_secret123"), "the answer never carries the key");
    assert.equal(res.cache, "no-store");
    const service = (JSON.parse(res.text) as { service: ServiceView }).service;
    assert.equal(service.secretRef, "RENDER_API_KEY");
    assert.equal(service.keyState, "set");
    assert.match(readFileSync(keysFile, "utf8"), /^RENDER_API_KEY=rnd_secret123$/m);
    const list = await api("GET", "/services");
    assert.ok(!list.text.includes("rnd_secret123"));
  });

  test("a second account of the same kind never replaces the first one's key", async () => {
    await api("POST", "/services", { type: "render", name: "Work", key: "rnd_one" });
    const second = await api("POST", "/services", { type: "render", name: "Personal", key: "rnd_two" });
    assert.equal((JSON.parse(second.text) as { service: ServiceView }).service.secretRef, "RENDER_API_KEY_2");
    const file = readFileSync(keysFile, "utf8");
    assert.match(file, /^RENDER_API_KEY=rnd_one$/m);
    assert.match(file, /^RENDER_API_KEY_2=rnd_two$/m);
    assert.equal(freeKeyName("render", ["RENDER_API_KEY", "RENDER_API_KEY_2"]), "RENDER_API_KEY_3");
  });

  test("something that isn't a key is refused, and nothing is created", async () => {
    for (const key of ["two words", "line\nbreak", "x".repeat(1001), 42]) {
      const res = await api("POST", "/services", { type: "render", name: "R", key });
      assert.equal(res.status, 400, String(key).slice(0, 20));
    }
    assert.match((await api("POST", "/services", { type: "render", name: "R" })).text, /Paste the key/);
    assert.equal(JSON.parse((await api("GET", "/services")).text).services.length, 0);
  });

  test("a key already in the file can still be named instead (Advanced)", async () => {
    const res = await api("POST", "/services", { type: "supabase", name: "S", secretRef: "MY_SUPABASE" });
    assert.equal(res.status, 201);
    assert.equal((JSON.parse(res.text) as { service: ServiceView }).service.keyState, "missing");
  });

  test("Add key / Change key saves a new key; for GitHub on the gh login, a pasted token takes over", async () => {
    const created = JSON.parse((await api("POST", "/services", { type: "github", name: "GH" })).text) as { service: ServiceView };
    assert.equal(created.service.keyState, "gh");
    const changed = await api("POST", `/services/${created.service.id}/key`, { key: "github_pat_abc" });
    assert.equal(changed.status, 200);
    assert.ok(!changed.text.includes("github_pat_abc"));
    const service = (JSON.parse(changed.text) as { service: ServiceView }).service;
    assert.equal(service.secretRef, "GITHUB_TOKEN");
    assert.equal(service.keyState, "set");
    assert.match(readFileSync(keysFile, "utf8"), /^GITHUB_TOKEN=github_pat_abc$/m);
    assert.equal((await api("POST", `/services/${created.service.id}/key`, { key: "" })).status, 400);
  });

  test("Test is remembered: the list says whether the key works, and a new key forgets the old verdict", async () => {
    const realFetch = globalThis.fetch;
    let accept = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.host === "api.render.com") {
        return accept
          ? new Response(JSON.stringify([{ owner: { name: "Me", email: "me@example.com" } }]), { status: 200, headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ message: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 404 });
    }) as typeof fetch;
    try {
      const { service } = JSON.parse((await api("POST", "/services", { type: "render", name: "R", key: "rnd_bad" })).text) as { service: ServiceView };
      assert.equal(service.lastTest, undefined, "not tested yet");

      await api("POST", `/services/${service.id}/test`);
      const failed = (JSON.parse((await api("GET", "/services")).text) as { services: ServiceView[] }).services[0]!;
      assert.equal(failed.lastTest?.ok, false);
      assert.match(failed.lastTest?.message ?? "", /rejected the key \(401\)/);

      await api("POST", `/services/${service.id}/key`, { key: "rnd_good" });
      assert.equal((JSON.parse((await api("GET", "/services")).text) as { services: ServiceView[] }).services[0]!.lastTest, undefined, "a new key forgets the old verdict");

      accept = true;
      await api("POST", `/services/${service.id}/test`);
      assert.equal((JSON.parse((await api("GET", "/services")).text) as { services: ServiceView[] }).services[0]!.lastTest?.ok, true);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("removing", () => {
  test("an account takes its key out of the keys file, and leaves the others", async () => {
    const one = JSON.parse((await api("POST", "/services", { type: "render", name: "Work", key: "rnd_one" })).text) as { service: ServiceView };
    await api("POST", "/services", { type: "render", name: "Personal", key: "rnd_two" });
    writeFileSync(keysFile, `# mine\n${readFileSync(keysFile, "utf8")}OTHER=kept\n`);
    assert.equal((await api("DELETE", `/services/${one.service.id}`)).status, 204);
    const file = readFileSync(keysFile, "utf8");
    assert.doesNotMatch(file, /^RENDER_API_KEY=/m);
    assert.match(file, /^RENDER_API_KEY_2=rnd_two$/m);
    assert.match(file, /^# mine$/m);
    assert.match(file, /^OTHER=kept$/m);
  });

  test("a key another account still reads stays in the keys file", async () => {
    const one = JSON.parse((await api("POST", "/services", { type: "render", name: "Work", key: "rnd_one" })).text) as { service: ServiceView };
    await api("POST", "/services", { type: "render", name: "Same key", secretRef: "RENDER_API_KEY" });
    assert.equal((await api("DELETE", `/services/${one.service.id}`)).status, 204);
    assert.match(readFileSync(keysFile, "utf8"), /^RENDER_API_KEY=rnd_one$/m);
  });

  test("an app takes its protocol secret with it: a new app of the same name starts without one", async () => {
    await api("POST", "/apps", { name: "Shop", url: "https://shop.test/" });
    mkdirSync(path.dirname(keysFile), { recursive: true });
    writeFileSync(keysFile, "PERISKOPOS_PROTOCOL_SHOP=old-secret\nOTHER=kept\n");
    assert.equal((await api("DELETE", "/apps/shop")).status, 204);
    const file = readFileSync(keysFile, "utf8");
    assert.doesNotMatch(file, /PERISKOPOS_PROTOCOL_SHOP/);
    assert.match(file, /^OTHER=kept$/m);
  });
});
