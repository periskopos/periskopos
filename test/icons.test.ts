import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import type { DatabaseSync } from "node:sqlite";
import type { App } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { AppIcons, ICON_EVERY_MS, fetchIcon, iconCandidates, sniff } from "../server/icons.ts";
import type { Icon } from "../server/icons.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const ICO = new Uint8Array([0x00, 0x00, 0x01, 0x00, 1, 0]);
const bytes = (s: string) => new TextEncoder().encode(s);

describe("sniff", () => {
  test("knows an image by its bytes, whatever it's called", () => {
    assert.equal(sniff(PNG), "image/png");
    assert.equal(sniff(ICO), "image/x-icon");
    assert.equal(sniff(bytes('  <svg xmlns="http://www.w3.org/2000/svg"></svg>')), "image/svg+xml");
    assert.equal(sniff(bytes('<?xml version="1.0"?><svg></svg>')), "image/svg+xml");
  });

  test("an HTML page answering /favicon.ico isn't an icon", () => {
    assert.equal(sniff(bytes("<!doctype html><html><body>app</body></html>")), undefined);
    assert.equal(sniff(new Uint8Array()), undefined);
  });
});

describe("iconCandidates", () => {
  test("SVG first, then a card-sized icon, then others, Apple's, and /favicon.ico last", () => {
    const html = `
      <link rel="apple-touch-icon" href="/apple.png">
      <link rel="icon" href="/tiny.png" sizes="16x16">
      <link rel="icon" sizes="192x192" href="/big.png">
      <link rel="icon" sizes="32x32" href="/32.png">
      <LINK REL="shortcut icon" href='https://cdn.example/x.svg'>
      <link rel="stylesheet" href="/style.css">`;
    assert.deepEqual(iconCandidates(html, "https://app.example/dash/"), [
      "https://cdn.example/x.svg",
      "https://app.example/32.png",
      "https://app.example/big.png",
      "https://app.example/tiny.png",
      "https://app.example/apple.png",
      "https://app.example/favicon.ico",
    ]);
  });

  test("resolves against the page, ignores what isn't http(s)", () => {
    const html = `<link rel="icon" href="img/i.png"><link rel="icon" href="data:image/png;base64,AAAA"><link rel="icon" href="javascript:alert(1)">`;
    assert.deepEqual(iconCandidates(html, "https://app.example/a/b"), ["https://app.example/a/img/i.png", "https://app.example/favicon.ico"]);
  });

  test("no page at all still tries /favicon.ico", () => {
    assert.deepEqual(iconCandidates("", "https://app.example/x"), ["https://app.example/favicon.ico"]);
  });
});

describe("fetchIcon", () => {
  let site: ReturnType<typeof createServer>;
  let url = "";
  before(async () => {
    site = createServer((req, res) => {
      if (req.url === "/named/") return void res.end('<html><head><link rel="icon" href="/brand.png"></head></html>');
      if (req.url === "/brand.png") return void res.end(PNG);
      if (req.url === "/broken/") return void res.end('<link rel="icon" href="/missing.png">');
      // A single-page app: every path is its HTML page.
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><html></html>");
    });
    await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  after(() => site.close());

  test("takes the icon the page names", async () => {
    const icon = await fetchIcon(`${url}/named/`);
    assert.equal(icon?.type, "image/png");
    assert.deepEqual([...(icon?.data ?? [])], [...PNG]);
  });

  test("a site whose every path is its page has no icon", async () => {
    assert.equal(await fetchIcon(`${url}/broken/`), undefined);
  });
});

const TOKEN = "t".repeat(43);
const PORT = 4100;
const BASE = `http://localhost:${PORT}`;
const distDir = tempDir("periskopos-web-");
writeFileSync(path.join(distDir, "index.html"), '<meta name="periskopos" content="app" />');

describe("an app's icon", () => {
  let db: DatabaseSync;
  let gc: ReturnType<typeof createApp>;
  let icons: AppIcons;
  let answer: Icon | undefined;
  let asked: string[];
  let gate: Promise<void> | undefined; // holds the site's answer back while set

  beforeEach(async () => {
    db = openDb(":memory:");
    answer = { type: "image/png", data: PNG };
    asked = [];
    gate = undefined;
    icons = new AppIcons({
      db,
      fetchIcon: async (u) => {
        asked.push(u);
        await gate;
        return answer;
      },
    });
    const watcher = new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true });
    gc = createApp({ db, token: TOKEN, port: PORT, distDir, watcher, icons });
    await call("POST", "/api/setup", { name: "Me" });
  });

  function call(method: string, urlPath: string, body?: unknown) {
    return gc.request(`${BASE}${urlPath}`, {
      method,
      headers: { "x-periskopos-token": TOKEN, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
  const getApp = async (slug: string) => ((await (await call("GET", `/api/apps/${slug}`)).json()) as { app: App }).app;
  const settle = () => icons.sweep();

  test("is fetched when the app is added, and served from Periskopos", async () => {
    await call("POST", "/api/apps", { name: "Shop", url: "https://shop.example/" });
    await settle();
    assert.deepEqual(asked, ["https://shop.example/"]);

    const app = await getApp("shop");
    assert.match(app.icon ?? "", /^\/api\/apps\/shop\/icon\?v=\d+$/);
    const res = await call("GET", app.icon!);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.match(res.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...PNG]);
  });

  test("none found: no icon, and the page shows the app's letter", async () => {
    answer = undefined;
    await call("POST", "/api/apps", { name: "Shop", url: "https://shop.example/" });
    await settle();
    assert.equal((await getApp("shop")).icon, undefined);
    assert.equal((await call("GET", "/api/apps/shop/icon")).status, 404);
  });

  test("a new URL drops the old site's icon until the new one's is fetched", async () => {
    await call("POST", "/api/apps", { name: "Shop", url: "https://shop.example/" });
    await settle();
    answer = undefined;
    let answerNow = () => {};
    gate = new Promise((resolve) => (answerNow = resolve));
    await call("PATCH", "/api/apps/shop", { url: "https://new.example/" });
    // While the new site is still being asked, the old icon isn't shown.
    assert.equal((await getApp("shop")).icon, undefined);
    assert.equal((await call("GET", "/api/apps/shop/icon")).status, 404);
    // The new site has none: the old site's icon doesn't come back.
    answerNow();
    await settle();
    assert.deepEqual(asked, ["https://shop.example/", "https://new.example/"]);
    assert.equal((await getApp("shop")).icon, undefined);
    assert.equal((await call("GET", "/api/apps/shop/icon")).status, 404);
  });

  test("the site down for a day keeps the icon it had", async () => {
    await call("POST", "/api/apps", { name: "Shop", url: "https://shop.example/" });
    await settle();
    answer = undefined;
    await icons.sweep(Date.now() + ICON_EVERY_MS + 1);
    assert.equal(asked.length, 2);
    assert.ok((await getApp("shop")).icon);
  });

  test("asked again only once it's due, and never for an app not live yet", async () => {
    await call("POST", "/api/apps", { name: "Shop", url: "https://shop.example/" });
    await call("POST", "/api/apps", { name: "Soon", url: "https://soon.example/", live: false });
    await settle();
    await icons.sweep(Date.now() + 60_000);
    assert.deepEqual(asked, ["https://shop.example/"]);
    const user = store.getLocalUser(db)!;
    assert.equal(store.getAppIcon(db, store.getApp(db, user.id, "soon")!.id), undefined);
  });
});
