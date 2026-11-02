import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text, unnamed } from "./dom-helpers.ts";
import type { App, Incident, NotificationsView, ServiceView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { keyProblem, notificationsView } from "../server/alerts/notifications.ts";
import * as store from "../server/store.ts";
import { buildNotificationsButton, summaryOf } from "../web/src/notificationsButton.ts";
import { tempDir } from "./tmp.ts";

// The title bar's notifications: what needs looking at now (apps with an
// open problem, accounts whose key is failing or expiring) and what
// recovered in the last day; and the bell that shows them.

const NOW = Date.parse("2026-10-18T20:00:00Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const app = (id: string, name: string): App => ({ id, slug: name.toLowerCase(), ownerId: "u", name, url: `https://${name.toLowerCase()}.com/`, live: true, checkIntervalMin: 5, connections: [] });
const incident = (appId: string, kind: Incident["kind"], reason: string, startedMinAgo: number, endedMinAgo?: number): Incident => ({
  id: `i-${appId}-${startedMinAgo}`,
  appId,
  kind,
  reason,
  startedAt: at(startedMinAgo),
  ...(endedMinAgo !== undefined ? { endedAt: at(endedMinAgo) } : {}),
});
const account = (over: Partial<ServiceView>): ServiceView => ({ id: "s1", ownerId: "u", type: "github", name: "My GitHub", canWrite: false, keyState: "set", apps: [], ...over });

describe("what needs looking at", () => {
  const exo = app("a1", "Star-Map");
  const endo = app("a2", "Moon-Base");
  const shop = app("a3", "Shop");

  test("down first, then the longest-standing; each opens its app", () => {
    const open = new Map([
      [exo.id, incident(exo.id, "expiry", "Certificate expires in 9 days", 30)],
      [endo.id, incident(endo.id, "ci", "CI failing on main", 90)],
      [shop.id, incident(shop.id, "outage", "No answer", 5)],
    ]);
    const view = notificationsView([exo, endo, shop], open, [], [], NOW);
    assert.deepEqual(view.now.map((n) => [n.state, n.title, n.text, n.href]), [
      ["down", "Shop", "No answer", "#/apps/shop"],
      ["attention", "Moon-Base", "CI failing on main", "#/apps/moon-base"],
      ["attention", "Star-Map", "Certificate expires in 9 days", "#/apps/star-map"],
    ]);
    assert.equal(view.now[1]!.since, at(90));
  });

  test("an account whose key is missing, failing or about to expire", () => {
    assert.equal(keyProblem(account({ keyState: "missing" }), NOW), "No GitHub key in the keys file");
    assert.equal(keyProblem(account({ lastTest: { ok: false, message: "GitHub rejected the key (401)", at: at(10) } }), NOW), "The GitHub key isn't working: GitHub rejected the key (401)");
    assert.equal(keyProblem(account({ lastTest: { ok: true, message: "ok", at: at(10), expiresAt: at(-3 * 24 * 60) } }), NOW), "The GitHub key expires in 3 days");
    assert.equal(keyProblem(account({ lastTest: { ok: true, message: "ok", at: at(10), expiresAt: at(-60 * 24 * 60) } }), NOW), undefined, "two months away: nothing yet");
    assert.equal(keyProblem(account({ lastTest: { ok: true, message: "ok", at: at(10), expiresAt: at(60) } }), NOW), "The GitHub key has expired");
    const view = notificationsView([], new Map(), [], [account({ keyState: "missing" })], NOW);
    assert.deepEqual(view.now.map((n) => [n.state, n.title, n.href]), [["attention", "My GitHub", "#/services"]]);
  });

  test("what recovered lately, with when and for how long", () => {
    const view = notificationsView([exo], new Map(), [incident(exo.id, "ci", "Cloudflare's build of star-map failed on 3de65c7", 600, 120)], [], NOW);
    assert.deepEqual(view.earlier, [{ title: "Star-Map", text: "Cloudflare's build of star-map failed on 3de65c7", href: "#/apps/star-map", startedAt: at(600), endedAt: at(120) }]);
  });

  test("the summary line", () => {
    assert.equal(summaryOf([]), "All normal");
    const n = (state: "down" | "attention") => ({ state, title: "x", text: "y", href: "#/" });
    assert.equal(summaryOf([n("attention")]), "1 needs attention");
    assert.equal(summaryOf([n("down"), n("attention"), n("attention")]), "1 down · 2 need attention");
  });
});

describe("GET /api/notifications", () => {
  test("open problems and the last day's recoveries, from what's recorded", async () => {
    const TOKEN = "t".repeat(43);
    const distDir = tempDir("periskopos-web-");
    writeFileSync(path.join(distDir, "index.html"), '<meta name="periskopos" content="app" />');
    const db = openDb(":memory:");
    const gc = createApp({ db, token: TOKEN, port: 4100, distDir });
    const user = store.createUser(db, "Me");
    const exo = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org/" });
    const site = exo.connections.find((c) => c.type === "site")!;
    const now = Date.now();
    const open = history.openIncident(db, { appId: exo.id, connectionId: site.id, kind: "outage", startedAt: new Date(now - 5 * 60_000).toISOString(), reason: "No answer" });
    const old = history.openIncident(db, { appId: exo.id, connectionId: site.id, kind: "outage", startedAt: new Date(now - 3 * 60 * 60_000).toISOString(), reason: "HTTP 502" });
    history.closeIncident(db, old.id, new Date(now - 2 * 60 * 60_000).toISOString());
    const week = history.openIncident(db, { appId: exo.id, connectionId: site.id, kind: "outage", startedAt: new Date(now - 8 * 24 * 60 * 60_000).toISOString(), reason: "Long ago" });
    history.closeIncident(db, week.id, new Date(now - 7 * 24 * 60 * 60_000).toISOString());

    const res = await gc.request("http://localhost:4100/api/notifications", { headers: { "x-periskopos-token": TOKEN } });
    assert.equal(res.status, 200);
    const view = (await res.json()) as NotificationsView;
    assert.deepEqual(view.now.map((n) => [n.state, n.title, n.text]), [["down", "Star-Map", "No answer"]]);
    assert.deepEqual(view.earlier.map((e) => e.text), ["HTTP 502"], "a week ago isn't 'the last day'");
    assert.equal(view.now[0]!.since, open.startedAt);
  });
});

describe("the bell", () => {
  test("no count when all is well; the count in the worst state's colour when not", () => {
    const bell = buildNotificationsButton();
    document.body.replaceChildren(bell.root);
    const badge = bell.root.querySelector<HTMLElement>(".notify-badge")!;
    const button = bell.root.querySelector<HTMLButtonElement>(".notify-btn")!;
    assert.equal(badge.hidden, true);
    assert.equal(button.getAttribute("aria-label"), "Notifications: All normal");

    bell.show({ now: [{ state: "attention", title: "Moon-Base", text: "CI failing on main", href: "#/apps/moon-base", since: new Date(Date.now() - 82 * 60_000).toISOString() }], earlier: [] });
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, "1");
    assert.ok(!badge.classList.contains("notify-badge--down"));
    assert.equal(button.getAttribute("aria-label"), "Notifications: 1 needs attention");

    bell.show({ now: [{ state: "down", title: "Shop", text: "No answer", href: "#/apps/shop" }, { state: "attention", title: "Moon-Base", text: "CI failing on main", href: "#/apps/moon-base" }], earlier: [] });
    assert.equal(badge.textContent, "2");
    assert.ok(badge.classList.contains("notify-badge--down"), "anything down: red");
  });

  test("the panel: each problem and recovery opens its page; every control named", () => {
    const bell = buildNotificationsButton();
    document.body.replaceChildren(bell.root);
    bell.show({
      now: [{ state: "attention", title: "Moon-Base", text: "CI failing on main", href: "#/apps/moon-base", since: new Date(Date.now() - 82 * 60_000).toISOString() }],
      earlier: [{ title: "Star-Map", text: "Cloudflare's build of star-map failed on 3de65c7", href: "#/apps/star-map", startedAt: new Date(Date.now() - 600 * 60_000).toISOString(), endedAt: new Date(Date.now() - 120 * 60_000).toISOString() }],
    });
    const button = bell.root.querySelector<HTMLButtonElement>(".notify-btn")!;
    const panel = bell.root.querySelector<HTMLElement>(".notify-panel")!;
    button.click();
    assert.equal(panel.hidden, false);
    assert.match(text(panel), /1 needs attention/);
    assert.match(text(panel), /Moon-Base CI failing on main for 1 h 22 min/);
    assert.match(text(panel), /Recovered in the last day ?Star-Map .* recovered 2 h ago after 8 h/);
    assert.deepEqual([...panel.querySelectorAll("a")].map((a) => a.getAttribute("href")), ["#/apps/moon-base", "#/apps/star-map", "#/"]);
    assert.deepEqual(unnamed(bell.root), []);
    // Following a line closes the panel.
    panel.querySelector<HTMLAnchorElement>("a")!.click();
    assert.equal(panel.hidden, true);
  });

  test("when the server can't be reached it says so, not 'All normal'", () => {
    const bell = buildNotificationsButton();
    bell.fail("Server not reachable");
    assert.equal(bell.root.querySelector(".notify-badge")?.textContent, "!");
    assert.equal(bell.root.querySelector(".notify-btn")?.getAttribute("aria-label"), "Notifications: Server not reachable");
  });
});
