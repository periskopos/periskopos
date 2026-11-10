import { parseDeepLink } from "../desktop/deep-link.ts";
import { clockPref, saveClockPref } from "../web/src/prefs.ts";
import { clock } from "../web/src/format.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { sectionOf, settle, text, unnamed, until } from "./dom-helpers.ts";
import { diagnostics, recordWorldPerf } from "../server/diagnostics.ts";
import { BUG_FORM_URL, reportIssue } from "../web/src/reportButton.ts";
import { pictureSize, watchWorldPerf, worldPerfSoFar } from "../web/src/views/world/perf.ts";
import { h, mount } from "../web/src/dom.ts";
import { ACCOUNTS } from "../shared/catalog.ts";
import type { BackupStatus, User } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { Backups } from "../server/backup.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import { getSettings, updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import type { Fetched } from "../server/providers.ts";
import { statusView } from "../web/src/views/status.ts";
import { ask } from "../web/src/approvals.ts";
import { addAppView } from "../web/src/views/addApp.ts";
import { firstRunView } from "../web/src/views/firstRun.ts";
import { fleetView } from "../web/src/views/fleet.ts";
import { connectServiceView, servicesView } from "../web/src/views/services.ts";
import { asLoginItemState } from "../web/src/desktop.ts";
import { backupsSection } from "../web/src/views/backups.ts";
import { SETTINGS_TABS, settingsTabOf, settingsView } from "../web/src/views/settings.ts";
import type { SettingsTab } from "../web/src/views/settings.ts";
import { tempDir } from "./tmp.ts";

// The pages other than an app's, drawn into a DOM against a real Ground
// Control server (in memory, seeded so nothing reaches the network): what
// they show, and that every control on them has a name.

// Whether an element is there, as a plain yes or no for assert: a failing
// assert prints what it was given in full, and a node reaches the whole
// document, so printing it never ends and the test hangs instead of failing.
const isThere = (el: Element | null | undefined) => el != null;

const TOKEN = "t".repeat(43);
const distDir = tempDir("periskopos-web-");
writeFileSync(path.join(distDir, "index.html"), '<meta name="periskopos" content="app" />');

const db = openDb(":memory:");
let providerAnswer: Fetched = { indicator: "none", description: "All Systems Operational", incidents: [] };
const watcher = new Watcher({
  db,
  notifier: silentNotifier,
  baseUrl: "http://localhost:4100",
  isOnline: async () => true,
  fetchProvider: async () => providerAnswer,
});
const backups = new Backups({ db, dir: path.join(tempDir("periskopos-backups-"), "backups") });
const gc = createApp({ db, token: TOKEN, agentToken: "periskopos-agent-pages-test", port: 4100, distDir, watcher, backups });

let user: User;
const realFetch = globalThis.fetch;
before(() => {
  user = store.createUser(db, "Me");
  const exo = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org/" });
  store.createApp(db, user.id, { name: "Moon-Base", url: "https://example.net/", live: false });
  const github = store.createService(db, user.id, { type: "github", name: "My GitHub", canWrite: false });
  store.createService(db, user.id, { type: "cloudflare", name: "My Cloudflare", secretRef: "PERISKOPOS_TEST_PAGES_NO_SUCH_KEY", canWrite: false });
  store.addConnection(db, exo, { type: "github", serviceId: github.id, resource: "acme/apps", settings: { branch: "main", paths: [] } });
  // Every connection checked already, so the status asks no one.
  const checked = store.getApp(db, user.id, "star-map")!;
  for (const c of checked.connections) {
    history.recordCheck(db, checked.id, c.id, c.type === "github" ? { state: "up", at: new Date().toISOString(), summary: "CI passing" } : { state: "up", at: new Date().toISOString(), ms: 120, httpStatus: 200 });
  }
  // The page's requests go to that server, and nowhere else.
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith("/api/")) throw new Error(`The page asked for ${url}, outside Periskopos`);
    return gc.request(`http://localhost:4100${url}`, { ...init, headers: { ...(init?.headers as Record<string, string>), "x-periskopos-token": TOKEN } });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
});

const page = () => {
  const root = document.createElement("div");
  document.body.replaceChildren(root);
  return root;
};

describe("a redraw", () => {
  test("keeps focus, open disclosures and unsaved text; never a password; a submitted form starts clean", () => {
    const root = page();
    const draw = (stored: string) =>
      mount(
        root,
        h("form", null, h("input", { name: "from", value: stored }), h("input", { name: "key", type: "password" }), h("button", { type: "submit" }, "Save")),
        h("details", null, h("summary", null, "Show the numbers"), "…"),
        h("a", { href: "#/apps/x" }, "X"),
      );
    draw("old@example.com");
    const from = () => root.querySelector<HTMLInputElement>("input[name=from]")!;
    const key = () => root.querySelector<HTMLInputElement>("input[name=key]")!;
    from().value = "typed@example.com";
    from().dispatchEvent(new Event("input", { bubbles: true }));
    key().value = "secret";
    key().dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector("details")!.open = true;
    root.querySelector<HTMLElement>("a")!.focus();

    draw("old@example.com");
    assert.equal(from().value, "typed@example.com");
    assert.equal(key().value, "");
    assert.equal(root.querySelector("details")!.open, true);
    assert.ok(document.activeElement === root.querySelector("a"), "the link keeps the focus");

    // Submitted: the next draw shows what's stored.
    root.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    draw("saved@example.com");
    assert.equal(from().value, "saved@example.com");
  });
});

describe("the Apps board", () => {
  // Waits until every app's state has come back (the header stops saying
  // it's checking), rather than for a fixed time a busy machine can overrun.
  const checked = (root: Element) => until(() => {
    const title = text(root.querySelector(".page-header h1"));
    return title !== "" && !/Checking your apps/.test(title);
  });

  test("lists every app with its state, live ones first", async () => {
    const root = page();
    const stop = fleetView(root, user);
    await checked(root);
    stop();
    const body = text(root);
    assert.match(body, /Star-Map/);
    assert.match(body, /Moon-Base/);
    assert.match(body, /Not live yet/);
    assert.ok(body.indexOf("Star-Map") < body.indexOf("Moon-Base"), "a live app before one not launched");
    assert.deepEqual(unnamed(root), []);
  });

  test("needs attention: an account's key and a provider's trouble, each linked to where it's fixed", async () => {
    providerAnswer = {
      indicator: "minor",
      description: "Partial outage",
      incidents: [{ name: "Actions delayed", impact: "minor", parts: ["Actions"] }],
      components: [{ name: "Actions", state: "degraded" }],
    };
    db.exec("DELETE FROM provider_status");
    try {
      const root = page();
      const stop = fleetView(root, user);
      await until(() => /Actions delayed/.test(text(sectionOf(root, "Needs attention"))) && /No Cloudflare key/.test(text(sectionOf(root, "Needs attention"))));
      stop();
      const strip = sectionOf(root, "Needs attention");
      assert.ok(strip, "the strip is drawn");
      assert.match(text(strip), /My Cloudflare\s*No Cloudflare key in the keys file/);
      assert.match(text(strip), /GitHub\s*Actions delayed · affects Star-Map/);
      assert.ok(strip.querySelector('a[href="#/services"]') && strip.querySelector('a[href="#/status"]'));
      assert.doesNotMatch(text(root.querySelector(".page-header")), /accounts and providers fine/, "no all-clear while something's listed");
      assert.deepEqual(unnamed(root), []);
    } finally {
      providerAnswer = { indicator: "none", description: "All Systems Operational", incidents: [] };
      db.exec("DELETE FROM provider_status");
    }
  });

  // Every row has as many cells as the header has columns.
  const aligned = (root: Element) => {
    const columns = root.querySelectorAll(".board thead th").length;
    return [...root.querySelectorAll(".board tbody tr")].every((tr) => tr.querySelectorAll("td").length === columns);
  };
  const headings = (root: Element) => [...root.querySelectorAll(".board thead th")].map((th) => text(th));

  test("a column no app has anything for isn't drawn", async () => {
    const root = page();
    const stop = fleetView(root, user);
    await checked(root);
    stop();
    // No host connected and no app reporting numbers.
    assert.deepEqual(headings(root), ["App", "State", "Response", "Uptime 30 days", "Checked"]);
    assert.ok(aligned(root));
  });

  test("one app with a deploy or numbers brings the column back, for every row", async () => {
    // The status as it would be with a host connected and the app reporting numbers.
    const serve = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const res = await serve(input, init);
      if (!String(input).startsWith("/api/status")) return res;
      const body = (await res.json()) as { statuses: { slug: string; deploy?: unknown; metrics?: unknown }[] };
      for (const s of body.statuses) {
        if (s.slug === "star-map") {
          s.deploy = { state: "live", live: { sha: "3de65c7aaaa", message: "Release 0.11.0", at: new Date().toISOString() } };
          s.metrics = [{ id: "users", label: "Users", value: 42 }];
        }
      }
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    try {
      const root = page();
      const stop = fleetView(root, user);
      await checked(root);
      stop();
      assert.deepEqual(headings(root), ["App", "State", "Response", "Uptime 30 days", "Last push", "Numbers", "Checked"]);
      assert.ok(aligned(root), "the app without them still has the cells, as —");
      assert.match(text(root.querySelector(".board tbody")), /Live.*3de65c7/);
    } finally {
      globalThis.fetch = serve;
    }
  });
});

describe("Accounts", () => {
  test("each account with its key's state and its provider's status", async () => {
    const root = page();
    servicesView(root, user);
    await until(() => root.querySelectorAll(".account-card").length >= 2);
    const body = text(root);
    assert.match(body, /My GitHub/);
    assert.match(body, /My Cloudflare/);
    // A card each: the key's verdict in the header, then a labelled row per fact.
    const card = (name: string) => [...root.querySelectorAll(".account-card")].find((c) => text(c.querySelector(".account-name")) === name)!;
    const rows = (c: Element) => Object.fromEntries([...c.querySelectorAll(".fact")].map((f) => [text(f.querySelector("dt")), text(f.querySelector("dd"))]));
    const gh = card("My GitHub");
    assert.equal(text(gh.querySelector(".health-pill")), "Not tested");
    assert.deepEqual(Object.keys(rows(gh)), ["Key", "Status", "Used by"]);
    assert.match(rows(gh).Status!, /All Systems Operational/);
    assert.match(rows(gh)["Used by"]!, /Star-Map/);
    const cf = card("My Cloudflare");
    assert.equal(text(cf.querySelector(".health-pill")), "No key");
    assert.deepEqual(Object.keys(rows(cf)), ["Key", "Access", "Plan", "Status", "Used by"]);
    assert.match(rows(cf).Access!, /Read only\s*Allow actions/, "the switch sits on its own row");
    assert.match(rows(cf).Plan!, /Free plan\s*Mark as Workers Paid/);
    assert.deepEqual([...cf.querySelectorAll(".account-foot button")].map(text), ["Test", "Add key", "Remove"]);
    // What each is for, next to its provider; Cloudflare is two things.
    assert.deepEqual([...gh.querySelectorAll(".account-kinds .tag")].map(text), ["Code"]);
    assert.deepEqual([...cf.querySelectorAll(".account-kinds .tag")].map(text), ["Hosting", "Domains"]);
    assert.equal(isThere(root.querySelector(".account-group")), false, "a few accounts aren't put under headings");
    assert.deepEqual(unnamed(root), []);
  });

  test("past six accounts, the page lists them under their kind", async () => {
    const added = (["vercel", "netlify", "sentry", "stripe", "resend"] as const).map((type) => store.createService(db, user.id, { type, name: `My ${type}`, secretRef: `${type.toUpperCase()}_KEY`, canWrite: false }));
    const root = page();
    servicesView(root, user);
    await until(() => root.querySelector(".account-group"));
    const groups = [...root.querySelectorAll(".account-group")];
    assert.deepEqual(groups.map((g) => text(g.querySelector(".account-group-label"))), ["Code", "Hosting", "Errors", "Payments", "Email"]);
    const hosting = groups.find((g) => text(g.querySelector(".account-group-label")) === "Hosting")!;
    assert.deepEqual([...hosting.querySelectorAll(".account-name")].map(text).sort(), ["My Cloudflare", "My netlify", "My vercel"]);
    assert.deepEqual(unnamed(root), []);
    for (const s of added) store.deleteService(db, s);
  });

  test("a key that expires soon says so on its row; one further off shows its date", async () => {
    const github = store.listServices(db, user.id).find((s) => s.type === "github")!;
    const inDays = (d: number) => new Date(Date.now() + d * 86_400_000 - 3_600_000).toISOString();
    store.setServiceLastTest(db, github, { ok: true, message: "Connected as me", at: new Date().toISOString(), expiresAt: inDays(9) });
    let root = page();
    servicesView(root, user);
    await until(() => /Key expires in/.test(text(root)));
    assert.match(text(root), new RegExp(`Key expires in 9 days \\(${inDays(9).slice(0, 10)}\\)`));
    assert.ok([...root.querySelectorAll(".health-pill")].some((p) => text(p) === "Key expiring"), "and the header says so in a word");

    store.setServiceLastTest(db, github, { ok: true, message: "Connected as me", at: new Date().toISOString(), expiresAt: inDays(60) });
    root = page();
    servicesView(root, user);
    await until(() => /Connected as me/.test(text(root)));
    assert.match(text(root), new RegExp(`Connected as me · expires ${inDays(60).slice(0, 10)}`));
    store.setServiceLastTest(db, github, undefined);
  });

  test("connecting one: every kind of account, and the steps to its key", async () => {
    const root = page();
    connectServiceView(root, user, () => {});
    await settle();
    // Every kind of account the catalog has, each with its own choice.
    for (const account of Object.values(ACCOUNTS)) assert.match(text(root), new RegExp(account.label));
    assert.equal(root.querySelectorAll("input[type=radio][name=type]").length, Object.keys(ACCOUNTS).length);
    // Listed by what they're for.
    const groups = [...root.querySelectorAll(".choice-group")].map((g) => [text(g.querySelector(".choice-group-label")), g.querySelectorAll("input[type=radio]").length]);
    assert.deepEqual(groups, [["Code", 2], ["Hosting", 8], ["Database", 3], ["Sign-in", 1], ["Errors", 1], ["Payments", 2], ["Email", 2], ["Analytics", 1], ["Search", 1], ["AI", 1]]);
    assert.deepEqual(unnamed(root), []);

    // Search Console's key is a service account's JSON file, shared with each property.
    const gsc = root.querySelector<HTMLInputElement>("input[type=radio][name=type][value=search-console]")!;
    gsc.checked = true;
    gsc.dispatchEvent(new Event("change"));
    assert.match(text(root), /Paste the whole JSON key file/);
    assert.match(text(root), /Users and permissions → Add user/);
    assert.ok(root.querySelector("a[href='https://console.cloud.google.com/iam-admin/serviceaccounts']"));
    assert.deepEqual(unnamed(root), []);
  });
});

describe("Status", () => {
  test("each provider an app uses: the parts in trouble as tiles, the rest folded, the incidents that matter", async () => {
    providerAnswer = {
      indicator: "minor",
      description: "Partial outage",
      incidents: [
        { name: "Actions delayed", impact: "minor", parts: ["Actions"] },
        { name: "Copilot slow", impact: "minor", parts: ["Copilot"] },
      ],
      components: [
        { name: "Git Operations", state: "operational" },
        { name: "Actions", state: "degraded" },
        { name: "API Requests", state: "operational" },
        { name: "Webhooks", state: "operational" },
        { name: "Copilot", state: "partial" },
      ],
    };
    db.exec("DELETE FROM provider_status");
    const root = page();
    statusView(root, user);
    await until(() => root.querySelector(".status-strip") && root.querySelector("[aria-labelledby=s-unused]"));
    assert.equal(text(root.querySelector(".nav a[aria-current=page]")), "Status");
    assert.match(text(root.querySelector(".page-header")), /GitHub reports trouble in parts your apps use/);
    const gh = [...root.querySelectorAll(".account-card")].find((c) => text(c.querySelector(".account-name")) === "GitHub")!;
    assert.equal(text(gh.querySelector(".health-pill")), "Affects your apps");
    assert.match(text(gh.querySelector(".overall")), /Overall:\s*Partial outage/, "the provider's own word, labelled, beside the verdict for my apps");
    // Three numbers at a glance.
    const figures = Object.fromEntries([...gh.querySelectorAll(".status-strip .figure")].map((f) => [text(f.querySelector(".label")), text(f.querySelector(".figure-value")) + " · " + text(f.querySelector(".figure-note"))]));
    assert.deepEqual(figures, {
      "Parts you use": "3/4 · 1 not operational",
      "Incidents affecting you": "1 · 1 elsewhere, not affecting you",
      Maintenance: "0 · none planned",
    });
    // What's wrong in full; the rest folded under More.
    const shown = gh.querySelector(":scope > .status-body")!;
    assert.deepEqual([...shown.querySelectorAll(".part .part-name")].map(text), ["Actions"], "only the part in trouble; Copilot isn't used");
    assert.match(text(shown), /Affecting your apps\s*Actions delayed/);
    assert.match(text(gh.querySelector(".status-more summary")), /More: 4 parts · 1 incident elsewhere/);
    assert.match(text(gh.querySelector(".status-more")), /Incidents elsewhere\s*Copilot slow/);
    assert.match(text(gh.querySelector(".status-foot")), /Used by\s*Star-Map/);
    // Cloudflare: no app uses it, so it's listed below, briefly.
    assert.match(text(root.querySelector("[aria-labelledby=s-unused]")), /Not used by any app\s*Cloudflare/);
    assert.deepEqual(unnamed(root), []);
    providerAnswer = { indicator: "none", description: "All Systems Operational", incidents: [] };
    db.exec("DELETE FROM provider_status");
  });
});

describe("AI assistants, on screen", () => {
  test("adding one: a name, what it may do and see, then its setup once, with its token", async () => {
    const root = page();
    settingsView(root, user, "assistants");
    await until(() => root.querySelectorAll("section .section-head h2").length >= 3);
    const sections = [...root.querySelectorAll("section .section-head h2")].map(text);
    assert.deepEqual(sections, ["Connection", "Assistants", "Activity"]);
    [...root.querySelectorAll("button")].find((b) => text(b) === "Add one with its own token")!.click();
    const form = root.querySelector<HTMLFormElement>(".inline-panel form")!;
    form.querySelector<HTMLInputElement>("input[name=name]")!.value = "Claude Code on my laptop";
    form.querySelector<HTMLSelectElement>("select[name=access]")!.value = "read";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await until(() => /isn't shown again/.test(text(root)));
    const codes = [...root.querySelector(".notice--attention")!.closest(".inline-panel")!.querySelectorAll(".code-body")].map(text);
    assert.match(codes[0]!, /^claude mcp add --env PERISKOPOS_AGENT_TOKEN=gca_[\w-]{43} --scope user periskopos node /);
    assert.match(codes[1]!, /"PERISKOPOS_AGENT_TOKEN": "gca_/);
    await until(() => [...root.querySelectorAll(".account-card .account-name")].some((n) => text(n) === "Claude Code on my laptop"));
    const card = [...root.querySelectorAll(".account-card")].find((c) => text(c.querySelector(".account-name")) === "Claude Code on my laptop")!;
    assert.equal(text(card.querySelector(".health-pill")), "Read only");
    assert.match(text(card), /Apps\s*All apps/);
    assert.deepEqual(unnamed(root), []);
  });

  test("the connection: off until switched on, the no-token setup, then who's connected", async () => {
    db.exec("DELETE FROM agent_audit");
    updateSettings(db, user.id, { agentAccess: false });
    const root = page();
    settingsView(root, user, "assistants");
    await until(() => !!root.querySelector(".connection-line"));
    const line = () => text(root.querySelector(".connection-line"));
    assert.match(line(), /^Off: no assistant can see anything/);
    assert.match(text(root.querySelector(".connection-facts")), /MCP server\s*In this install/);
    const steps = root.querySelector<HTMLDetailsElement>(".connect-steps")!;
    assert.equal(steps.open, true, "open while nothing has connected");
    assert.match(text(steps.querySelector(".code-body")), /^claude mcp add --scope user periskopos node "/);
    assert.doesNotMatch(text(steps), /PERISKOPOS_AGENT_TOKEN/);
    const toggle = root.querySelector<HTMLInputElement>("input[name=agentAccess]")!;
    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    await until(() => !/^Off/.test(line()));
    assert.match(line(), /No assistant has connected yet|can't start the MCP server/);
    const thisPc = [...root.querySelectorAll(".account-card")].find((c) => text(c.querySelector(".account-name")) === "This PC");
    assert.ok(thisPc, "This PC is listed before it's used");
    assert.equal(text([...thisPc!.querySelectorAll("button")].at(-1)), "Turn off");
    assert.deepEqual(unnamed(root), []);
  });

  test("the approval dialog offers to allow for an hour only to an assistant with its own token", () => {
    const base = { appSlug: "star-map", appName: "Star-Map", actionId: "redeploy:c_1", label: "Redeploy", service: "My Render", agent: "Cursor", requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const buttons = () => [...document.querySelectorAll("dialog .actions button")].map(text);
    ask({ ...base, id: "ap_own", agentId: "ag_1", appId: "a_1" });
    assert.deepEqual(buttons(), ["Decline", "Approve, and allow for 1 hour", "Approve"]);
    document.querySelector("dialog")?.remove();
    ask({ ...base, id: "ap_shared" });
    assert.deepEqual(buttons(), ["Decline", "Approve"]);
    document.querySelector("dialog")?.remove();
  });
});

describe("Settings, adding an app, the first run", () => {
  test("a periskopos:// link reaches every Settings tab", () => {
    for (const tab of SETTINGS_TABS) assert.equal(parseDeepLink(`periskopos://settings/${tab.key}`), `#/settings/${tab.key}`);
  });

  test("Settings: a tab for each kind of setting, each with its sections, every control named", async () => {
    const sections: Record<SettingsTab, string[]> = {
      general: ["You", "Watching", "This app"],
      appearance: ["Display"],
      notifications: ["Alerts", "Pause alerts", "Phone alerts"],
      assistants: ["Connection"],
      data: ["Backups", "History", "Export", "Import", "Restore default settings"],
      about: ["About"],
    };
    for (const tab of SETTINGS_TABS) {
      const root = page();
      settingsView(root, user, tab.key);
      await until(() => sections[tab.key].every((title) => sectionOf(root, title)));
      // The tab bar marks where you are, and links each tab by its own address.
      const current = root.querySelector(".tabs a[aria-current=page]");
      assert.equal(text(current), tab.label);
      assert.deepEqual([...root.querySelectorAll(".tabs a")].map((a) => a.getAttribute("href")), ["#/settings", "#/settings/appearance", "#/settings/notifications", "#/settings/assistants", "#/settings/data", "#/settings/about"]);
      for (const title of sections[tab.key]) assert.ok(sectionOf(root, title), `${tab.key}: ${title}`);
      // Only that tab's sections.
      const others = Object.entries(sections).filter(([k]) => k !== tab.key).flatMap(([, t]) => t);
      for (const title of others) assert.equal(isThere(sectionOf(root, title)), false, `${tab.key} shouldn't show ${title}`);
      assert.deepEqual(unnamed(root), [], tab.key);
    }
    assert.equal(settingsTabOf("data"), "data");
    assert.equal(settingsTabOf("nonsense"), "general");
    assert.equal(settingsTabOf(undefined), "general");
  });

  test("Notifications: with Notify me off the alarm can't be switched, and a test says real alerts won't come", async () => {
    updateSettings(db, user.id, { notificationsEnabled: false });
    try {
      const root = page();
      settingsView(root, user, "notifications");
      await until(() => sectionOf(root, "Alerts")?.querySelector("input[name=incidentAlarm]"));
      const part = sectionOf(root, "Alerts")!;
      assert.equal(part.querySelector<HTMLInputElement>("input[name=incidentAlarm]")!.disabled, true);
      assert.match(text(part), /Needs Notify me/);
      [...part.querySelectorAll("button")].find((b) => /test notification/.test(b.textContent ?? ""))!.click();
      await until(() => /real alerts won't come/.test(text(sectionOf(root, "Alerts"))));
      assert.match(text(sectionOf(root, "Alerts")), /real alerts won't come/);
    } finally {
      updateSettings(db, user.id, { notificationsEnabled: true });
    }
  });

  test("General: your name can be changed, and new apps' interval chosen", async () => {
    const root = page();
    const me = { ...user };
    settingsView(root, me, "general");
    await until(() => sectionOf(root, "You")?.querySelector("input[name=name]"));
    root.querySelector<HTMLInputElement>("input[name=name]")!.value = "Renamed";
    sectionOf(root, "You")!.querySelector("form")!.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
    await until(() => store.getLocalUser(db)?.name === "Renamed");
    assert.equal(store.getLocalUser(db)?.name, "Renamed");
    store.renameUser(db, store.getLocalUser(db)!, user.name);
    const select = root.querySelector<HTMLSelectElement>("select[name=defaultCheckIntervalMin]")!;
    assert.equal(select.querySelector("option[selected]")?.textContent, "Every 5 minutes");
    select.value = "15";
    select.dispatchEvent(new Event("change"));
    await until(() => getSettings(db, user.id).defaultCheckIntervalMin === 15);
    assert.equal(getSettings(db, user.id).defaultCheckIntervalMin, 15);
    updateSettings(db, user.id, { defaultCheckIntervalMin: 5 });
  });

  test("Appearance: a browser tab says the theme follows the system; times can be 24-hour", async () => {
    const root = page();
    settingsView(root, user, "appearance");
    await until(() => sectionOf(root, "Display")?.querySelector("input[name=clock]"));
    assert.match(text(sectionOf(root, "Display")), /follows your system/);
    assert.equal(root.querySelector("input[name=theme]"), null);
    assert.deepEqual([...root.querySelectorAll<HTMLInputElement>("input[name=clock]")].map((r) => [r.value, r.checked]), [["system", true], ["12", false], ["24", false]]);
    const radio = root.querySelector<HTMLInputElement>("input[name=clock][value='24']")!;
    radio.checked = true;
    radio.dispatchEvent(new Event("change"));
    assert.equal(clockPref(), "24");
    await until(() => root.querySelector<HTMLInputElement>("input[name=clock][value='24']")?.checked);
    assert.equal(root.querySelector<HTMLInputElement>("input[name=clock][value='24']")!.checked, true, "the redraw shows what was chosen");
    assert.deepEqual(unnamed(root), []);
    assert.doesNotMatch(clock("2026-11-06T15:30:00Z"), /[AP]M/i);
    saveClockPref("12");
    assert.match(clock("2026-11-06T15:30:00Z"), /[AP]M/i);
    saveClockPref("system");
  });

  test("Report an issue: the title bar's button copies the diagnostics, then opens the form", async () => {
    const root = page();
    settingsView(root, user, "about");
    await until(() => root.querySelector("button[aria-label='Report an issue']"));
    assert.ok(root.querySelector(".topbar button[aria-label='Report an issue']"));
    const steps: string[] = [];
    const nav = globalThis.navigator as unknown as { clipboard?: unknown };
    const before = Object.getOwnPropertyDescriptor(nav, "clipboard");
    Object.defineProperty(nav, "clipboard", { configurable: true, value: { writeText: async (t: string) => void steps.push(`copied ${t.slice(0, 10)}`) } });
    try {
      await reportIssue((url) => void steps.push(`opened ${url}`));
      assert.deepEqual(steps, ["copied Periskopos", `opened ${BUG_FORM_URL}`]);
    } finally {
      if (before) Object.defineProperty(nav, "clipboard", before);
      else delete nav.clipboard;
    }
  });

  test("the World's numbers reach the diagnostics through the server, only slow frames that mean it counting", async () => {
    const context = { getExtension: () => null, getParameter: () => "ANGLE (NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11)", RENDERER: 1 } as unknown as WebGLRenderingContext;
    const perf = watchWorldPerf(context, () => pictureSize(120, 450_000, 1.25, 1920, 1080));
    perf.pictured();
    for (let i = 0; i < 90; i++) perf.frame(33, 4, true);
    for (let i = 0; i < 10; i++) perf.frame(60, 9, true);
    perf.frame(166, 4, false); // slow on purpose
    perf.frame(60_000, 4, true); // asleep
    perf.level(2);
    perf.level(1);
    perf.lost();
    const sofar = worldPerfSoFar();
    assert.equal(sofar.frames, 100);
    assert.equal(sofar.typicalMs, 33);
    assert.equal(sofar.slow99Ms, 60);
    assert.equal(sofar.over50MsPercent, 10);
    assert.equal(sofar.lowestDetail, 2);
    assert.equal(sofar.detail, 1);
    assert.equal(sofar.pixelRatio, 1.5, "rounded to a half");
    assert.equal(sofar.megapixels, 3, "rounded to a half");
    perf.stop();
    await until(() => /Frame time: typical 33 ms/.test(diagnostics(db)));
    const report = diagnostics(db);
    assert.match(report, /World: \d+ visit/);
    assert.match(report, /10% over 50 ms/);
    assert.match(report, /Graphics: ANGLE \(NVIDIA GeForce RTX 3060 Direct3D11\)/);
    recordWorldPerf(null);
  });

  test("Settings rows: a switch and a dropdown are named by their title, and described by their hint", async () => {
    const root = page();
    settingsView(root, user, "general");
    await until(() => root.querySelector("input[name=watcherEnabled]"));
    const watch = root.querySelector<HTMLInputElement>("input[name=watcherEnabled]")!;
    assert.equal(watch.type, "checkbox");
    assert.equal(watch.getAttribute("role"), "switch");
    assert.equal(watch.getAttribute("aria-label"), "Watch apps in the background");
    assert.match(text(root.querySelector(`#${watch.getAttribute("aria-describedby")}`)), /records history/);
    assert.ok(watch.closest("label.setting-row"), "the whole row is the switch's label");
    const select = root.querySelector<HTMLSelectElement>("select[name=defaultCheckIntervalMin]")!;
    assert.equal(text(root.querySelector(`label[for="${select.id}"]`)), "Check new apps");
    assert.match(text(root.querySelector(`#${select.getAttribute("aria-describedby")}`)), /keep their own pace/);
  });

  test("Notifications: the alarm sits under provider incidents, and each kind is a row under Notify me", async () => {
    const root = page();
    settingsView(root, user, "notifications");
    await until(() => root.querySelector("input[name=incidentAlarm]"));
    const names = [...sectionOf(root, "Alerts")!.querySelectorAll<HTMLInputElement>("input[role=switch]")].map((i) => i.name);
    assert.deepEqual(names, ["notificationsEnabled", "alertOutages", "alertDeploys", "alertAccounts", "alertProviders", "incidentAlarm", "alertWarnings"]);
    assert.equal(root.querySelectorAll(".setting-row--sub").length, 6);
  });

  test("Notifications: each kind of alert is a switch that saves, and greys out under Notify me", async () => {
    const root = page();
    settingsView(root, user, "notifications");
    await until(() => sectionOf(root, "Alerts")?.querySelector("input[name=alertDeploys]"));
    const box = root.querySelector<HTMLInputElement>("input[name=alertDeploys]")!;
    assert.equal(box.checked, true);
    box.checked = false;
    box.dispatchEvent(new Event("change"));
    await until(() => !getSettings(db, user.id).alertDeploys);
    assert.equal(getSettings(db, user.id).alertDeploys, false);
    updateSettings(db, user.id, { alertDeploys: true, notificationsEnabled: false });
    try {
      const off = page();
      settingsView(off, user, "notifications");
      await until(() => off.querySelector("input[name=alertDeploys]"));
      assert.equal(off.querySelector<HTMLInputElement>("input[name=alertDeploys]")!.disabled, true);
    } finally {
      updateSettings(db, user.id, { notificationsEnabled: true });
    }
  });

  test("Notifications: alerts can be paused for a set time, says so, and can be resumed", async () => {
    const root = page();
    settingsView(root, user, "notifications");
    await until(() => sectionOf(root, "Pause alerts")?.querySelector("select[name=pauseWhat]"));
    [...sectionOf(root, "Pause alerts")!.querySelectorAll("button")].find((b) => b.textContent === "For 1 hour")!.click();
    await until(() => /All alerts are paused until/.test(text(sectionOf(root, "Pause alerts"))));
    assert.ok(Date.parse(getSettings(db, user.id).alertsPausedUntil) > Date.now());
    assert.match(text(sectionOf(root, "Pause alerts")), /All alerts are paused until/);
    [...sectionOf(root, "Pause alerts")!.querySelectorAll("button")].find((b) => b.textContent === "Resume")!.click();
    await until(() => getSettings(db, user.id).alertsPausedUntil === "");
    assert.equal(getSettings(db, user.id).alertsPausedUntil, "");
  });

  test("Data: says how long history is kept, and shortening it asks first", async () => {
    const root = page();
    settingsView(root, user, "data");
    await until(() => sectionOf(root, "History")?.querySelector("select[name=checksKeptDays]"));
    assert.match(text(sectionOf(root, "History")), /A summary of each day is kept for 365 days/);
    updateSettings(db, user.id, { checksKeptDays: 90 });
    const again = page();
    settingsView(again, user, "data");
    await until(() => again.querySelector("select[name=checksKeptDays]"));
    const select = again.querySelector<HTMLSelectElement>("select[name=checksKeptDays]")!;
    assert.equal(select.value, "90");
    const asked: string[] = [];
    const realConfirm = globalThis.confirm;
    globalThis.confirm = (q) => (asked.push(String(q)), false);
    select.value = "30";
    select.dispatchEvent(new Event("change"));
    globalThis.confirm = realConfirm;
    assert.match(asked[0]!, /deleted/);
    assert.equal(getSettings(db, user.id).checksKeptDays, 90, "declined: nothing changes");
    updateSettings(db, user.id, { checksKeptDays: 30 });
    const backups = backupsSection({ dir: "x", keep: 7, count: 0 } as BackupStatus, () => {});
    assert.equal(backups.querySelector("a")?.getAttribute("href"), "https://periskopos.com/docs/app/backups");
  });

  test("Notifications: the provider-incident alarm is a switch, off at first, and can be tried", async () => {
    const root = page();
    settingsView(root, user, "notifications");
    await until(() => sectionOf(root, "Alerts")?.querySelector<HTMLInputElement>("input[name=incidentAlarm]"));
    const box = sectionOf(root, "Alerts")!.querySelector<HTMLInputElement>("input[name=incidentAlarm]")!;
    assert.equal(box.checked, false);
    assert.match(text(sectionOf(root, "Alerts")), /Sound an alarm for provider incidents/);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    // until() gives up quietly, so each wait is followed by what it waited for.
    await until(() => getSettings(db, user.id).incidentAlarm);
    assert.equal(getSettings(db, user.id).incidentAlarm, true, "switching it on is saved");

    const tryIt = [...sectionOf(root, "Alerts")!.querySelectorAll("button")].find((b) => text(b) === "Test the alarm")!;
    tryIt.click();
    await until(() => /Dismiss it to stop the sound/.test(text(sectionOf(root, "Alerts"))));
    assert.match(text(sectionOf(root, "Alerts")), /Sent\. Dismiss it to stop the sound/);
    updateSettings(db, user.id, { incidentAlarm: false });
  });

  test("Start at login: a switch in the installed app, the shell's answer shown; words elsewhere", async () => {
    // In a browser tab (no shell): how it stands, and where to change it.
    const tab = page();
    settingsView(tab, user, "general");
    await until(() => /tray/.test(text(sectionOf(tab, "This app"))));
    assert.equal(isThere(sectionOf(tab, "This app")!.querySelector("input")), false);
    assert.match(text(sectionOf(tab, "This app")), /tray/);

    // In the installed app: a switch, flipped through the shell, showing what the shell says back.
    let on = false;
    const asked: boolean[] = [];
    const shellBridge = {
      platform: "win32",
      onNavigate: () => {},
      getStartAtLogin: (handler: (state: unknown) => void) => handler({ available: true, enabled: on }),
      setStartAtLogin: (value: boolean, handler: (state: unknown) => void) => {
        asked.push(value);
        on = value;
        handler({ available: true, enabled: on });
      },
    };
    (globalThis as { periskoposShell?: unknown }).periskoposShell = shellBridge;
    try {
      const root = page();
      settingsView(root, user, "general");
      await until(() => sectionOf(root, "This app")?.querySelector("input[role=switch]"));
      const box = () => sectionOf(root, "This app")!.querySelector<HTMLInputElement>("input[role=switch]")!;
      assert.equal(box().checked, false);
      box().checked = true;
      box().dispatchEvent(new Event("change"));
      await until(() => asked.length > 0 && box()?.checked);
      assert.deepEqual(asked, [true]);
      assert.equal(box().checked, true);
      assert.deepEqual(unnamed(root), []);

      // A dev run can't change it: the shell says so, and the page doesn't offer it.
      shellBridge.getStartAtLogin = (handler) => handler({ available: false, enabled: false });
      const dev = page();
      settingsView(dev, user, "general");
      await until(() => /tray/.test(text(sectionOf(dev, "This app"))));
      assert.equal(isThere(sectionOf(dev, "This app")!.querySelector("input")), false);
    } finally {
      delete (globalThis as { periskoposShell?: unknown }).periskoposShell;
    }
    assert.deepEqual(asLoginItemState({ available: true, enabled: false }), { available: true, enabled: false });
    assert.equal(asLoginItemState({ available: "yes", enabled: false }), null);
    assert.equal(asLoginItemState(null), null);
  });

  test("Backups: none yet, then Back up now makes one and says so", async () => {
    const root = page();
    settingsView(root, user, "data");
    await until(() => /No backup yet/.test(text(sectionOf(root, "Backups"))));
    const backupsBox = () => sectionOf(root, "Backups")!;
    assert.match(text(backupsBox()), /No backup yet/);
    assert.match(text(backupsBox()), /keys are never in it/);
    // In a browser tab there's no shell to open the folder: its path is shown instead.
    assert.ok(text(backupsBox()).includes(backups.dir));
    assert.equal([...backupsBox().querySelectorAll("button")].some((b) => /Open the backups folder/.test(text(b))), false);
    const button = [...backupsBox().querySelectorAll("button")].find((b) => text(b) === "Back up now")!;
    button.click();
    await until(() => /Last backup just now/.test(text(backupsBox())));
    assert.match(text(backupsBox()), /Last backup just now/);
    assert.match(text(backupsBox()), /1 kept/);
    assert.equal(backups.list().length, 1);
    assert.deepEqual(unnamed(root), []);
  });

  test("adding an app, and setting up for the first time", async () => {
    const add = page();
    addAppView(add, user, () => {});
    await settle();
    assert.ok(add.querySelector("input[name=url]"));
    assert.deepEqual(unnamed(add), []);

    const first = page();
    firstRunView(first, () => {});
    await settle();
    assert.ok(first.querySelector("input[name=name]"));
    assert.deepEqual(unnamed(first), []);
  });
});
