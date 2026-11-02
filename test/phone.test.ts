import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Settings } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import type { Notice } from "../server/alerts/notify.ts";
import { sendToPhone, withPhone } from "../server/alerts/phone.ts";
import { DEFAULT_SETTINGS, updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// Phone alerts (the landscape notes §5.1): the services are faked; nothing
// is really sent.

const TOKEN = "t".repeat(43);
const BASE = "http://localhost:4100";
const realFetch = globalThis.fetch;
let sent: { url: string; body: Record<string, unknown>; auth?: string }[];
let answer: { status: number; body: unknown };
let keysFile: string;

beforeEach(() => {
  sent = [];
  answer = { status: 200, body: { ok: true } };
  keysFile = path.join(tempDir("periskopos-phone-"), ".env.local");
  process.env.PERISKOPOS_ENV_FILE = keysFile;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {}, ...(headers.authorization ? { auth: headers.authorization } : {}) });
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PERISKOPOS_ENV_FILE;
});

const settings = (patch: Partial<Settings>): Settings => ({ ...DEFAULT_SETTINGS, ...patch });
const notice = { title: "Star-Map is down", body: "HTTP 503 · since 10:04" };

describe("sending", () => {
  test("ntfy: JSON to the server with the topic, any characters in the title", async () => {
    writeFileSync(keysFile, "PERISKOPOS_NTFY_TOPIC=periskopos-secret-topic-123\n");
    await sendToPhone(settings({ phoneChannel: "ntfy" }), { title: "Star-Map → down…", body: "x" });
    assert.equal(sent[0]!.url, "https://ntfy.sh");
    assert.deepEqual(sent[0]!.body, { topic: "periskopos-secret-topic-123", title: "Star-Map → down…", message: "x", tags: ["satellite"] });
    assert.equal(sent[0]!.auth, undefined);
  });

  test("Telegram: the bot writes title and body to my chat", async () => {
    writeFileSync(keysFile, "PERISKOPOS_TELEGRAM_BOT_TOKEN=123:abc\n");
    await sendToPhone(settings({ phoneChannel: "telegram", telegramChatId: "42" }), notice);
    assert.equal(sent[0]!.url, "https://api.telegram.org/bot123:abc/sendMessage");
    assert.deepEqual(sent[0]!.body, { chat_id: "42", text: "Star-Map is down\nHTTP 503 · since 10:04" });
  });

  test("email through Resend, with the key as a bearer token", async () => {
    writeFileSync(keysFile, "PERISKOPOS_RESEND_API_KEY=re_key\n");
    await sendToPhone(settings({ phoneChannel: "email", emailFrom: "Periskopos <alerts@example.org>", emailTo: "me@example.com" }), notice);
    assert.equal(sent[0]!.url, "https://api.resend.com/emails");
    assert.equal(sent[0]!.auth, "Bearer re_key");
    assert.deepEqual(sent[0]!.body, { from: "Periskopos <alerts@example.org>", to: ["me@example.com"], subject: "Star-Map is down", text: "HTTP 503 · since 10:04" });
  });

  test("what's missing, or what the service said, in plain words", async () => {
    await assert.rejects(sendToPhone(settings({ phoneChannel: "ntfy" }), notice), /Choose an ntfy topic/);
    await assert.rejects(sendToPhone(settings({ phoneChannel: "telegram" }), notice), /bot's token/);
    writeFileSync(keysFile, "PERISKOPOS_TELEGRAM_BOT_TOKEN=123:abc\n");
    await assert.rejects(sendToPhone(settings({ phoneChannel: "telegram" }), notice), /Find your chat/);
    writeFileSync(keysFile, "PERISKOPOS_RESEND_API_KEY=re_key\n");
    answer = { status: 403, body: { message: "The example.org domain is not verified" } };
    await assert.rejects(sendToPhone(settings({ phoneChannel: "email", emailFrom: "a@example.org", emailTo: "me@x.com" }), notice), /Resend answered HTTP 403: The example.org domain is not verified/);
  });

  test("the desktop notification always goes; the phone only when on, and its failure never breaks it", { timeout: 5_000 }, async () => {
    const db = openDb(":memory:");
    const user = store.createUser(db, "Me");
    const shown: Notice[] = [];
    const notifier = withPhone({ notify: async (n) => void shown.push(n) }, db);
    await notifier.notify({ ...notice, url: "http://localhost:4100/#/" });
    assert.equal(shown.length, 1);
    assert.equal(sent.length, 0, "off: nothing leaves the PC");

    writeFileSync(keysFile, "PERISKOPOS_NTFY_TOPIC=periskopos-secret-topic-123\n");
    updateSettings(db, user.id, { phoneChannel: "ntfy" });
    answer = { status: 500, body: {} };
    await notifier.notify({ ...notice, url: "http://localhost:4100/#/" });
    // The phone is sent to in the background: wait for its attempt, not a guessed time.
    for (let i = 0; i < 1000 && sent.length === 0; i++) await new Promise((r) => setImmediate(r));
    assert.equal(shown.length, 2, "shown on the desktop although the phone failed");
    assert.equal(sent.length, 1);
    assert.ok(!("url" in sent[0]!.body), "the local address isn't sent");

    // A phone service that never answers doesn't hold the desktop one up.
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;
    await notifier.notify({ ...notice, url: "http://localhost:4100/#/" });
    assert.equal(shown.length, 3);
  });
});

describe("the Settings API", () => {
  let gc: ReturnType<typeof createApp>;
  beforeEach(() => {
    const db = openDb(":memory:");
    store.createUser(db, "Me");
    const dist = tempDir("periskopos-web-");
    writeFileSync(path.join(dist, "index.html"), "");
    gc = createApp({ db, token: TOKEN, port: 4100, distDir: dist, notifier: silentNotifier, watcher: new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true }) });
  });
  const api = async (method: string, p: string, body?: unknown) => {
    const res = await gc.request(`${BASE}/api${p}`, { method, headers: { "x-periskopos-token": TOKEN, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, text: await res.text() };
  };

  test("a pasted key goes to the keys file and never comes back", async () => {
    const r = await api("POST", "/settings/phone/secret", { name: "ntfyTopic", value: "periskopos-very-secret-topic" });
    assert.equal(r.status, 200);
    assert.ok(!r.text.includes("periskopos-very-secret-topic"));
    assert.match(readFileSync(keysFile, "utf8"), /^PERISKOPOS_NTFY_TOPIC=periskopos-very-secret-topic$/m);
    const s = await api("GET", "/settings");
    assert.ok(!s.text.includes("periskopos-very-secret-topic"));
    assert.equal((JSON.parse(s.text) as { phoneSecrets: { ntfyTopic: boolean } }).phoneSecrets.ntfyTopic, true);
  });

  test("bad input is refused", async () => {
    assert.equal((await api("POST", "/settings/phone/secret", { name: "ntfyTopic", value: "short" })).status, 400, "a guessable topic");
    assert.equal((await api("POST", "/settings/phone/secret", { name: "toString", value: "x".repeat(20) })).status, 400);
    assert.equal((await api("PATCH", "/settings", { phoneChannel: "sms" })).status, 400);
    assert.equal((await api("PATCH", "/settings", { telegramChatId: "me" })).status, 400);
    assert.equal((await api("PATCH", "/settings", { emailTo: "not an address" })).status, 400);
    assert.equal((await api("PATCH", "/settings", { emailFrom: "Periskopos <alerts@example.org>", emailTo: "me@example.com", phoneChannel: "email" })).status, 200);
  });

  test("Send a test reports what happened", async () => {
    await api("PATCH", "/settings", { phoneChannel: "ntfy" });
    assert.match((await api("POST", "/settings/phone/test")).text, /"ok":false.*Choose an ntfy topic/);
    await api("POST", "/settings/phone/secret", { name: "ntfyTopic", value: "periskopos-very-secret-topic" });
    assert.match((await api("POST", "/settings/phone/test")).text, /"ok":true/);
    assert.equal(sent.at(-1)!.body.topic, "periskopos-very-secret-topic");
  });

  test("Find my chat saves the newest chat that wrote to the bot", async () => {
    await api("POST", "/settings/phone/secret", { name: "telegramToken", value: "123:abcdefgh" });
    answer = { status: 200, body: { result: [{ message: { chat: { id: 1, first_name: "Old" } } }, { message: { chat: { id: 987654, first_name: "Daniel" } } }] } };
    const r = JSON.parse((await api("POST", "/settings/phone/telegram-chat")).text) as { ok: boolean; message: string; settings: Settings };
    assert.equal(r.ok, true);
    assert.match(r.message, /Daniel/);
    assert.equal(r.settings.telegramChatId, "987654");
    answer = { status: 200, body: { result: [] } };
    assert.match((await api("POST", "/settings/phone/telegram-chat")).text, /Nobody has written to your bot yet/);
  });
});
