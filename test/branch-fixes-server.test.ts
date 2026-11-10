import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HELD_KEPT, heldDue, heldSummary } from "../server/alerts/rules.ts";
import { openDb } from "../server/db.ts";
import { diagnostics } from "../server/diagnostics.ts";
import { recordProblem } from "../server/diagnostics.ts";
import { DEFAULT_SETTINGS, dropHeldAlerts, getSettings, heldAlerts, setHeldAlerts, updateSettings } from "../server/settings.ts";
import { applyImport, planImport } from "../server/setup-import.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import type { Settings } from "../shared/types.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe("what a pause holds", () => {
  test("a kind switched off during the pause isn't sent when it ends", () => {
    const held = [{ title: "A is down", kind: "outages" as const }, { title: "B's deploy failed", kind: "deploys" as const }, { title: "Checks stopped" }];
    const { due, kept } = heldDue(settings({ alertOutages: false }), held, NOW);
    assert.deepEqual(due.map((a) => a.title), ["B's deploy failed", "Checks stopped"]);
    assert.deepEqual(kept, []);
  });

  test("at the limit it doesn't claim to know how many there were", () => {
    const many = Array.from({ length: HELD_KEPT }, (_, i) => ({ title: `T${i}` }));
    const { title, body } = heldSummary(many);
    assert.equal(title, `Over ${HELD_KEPT} alerts while paused`);
    assert.match(body, new RegExp(`T${HELD_KEPT - 1}`));
    assert.doesNotMatch(body, /more\./);
  });

  test("what's held about an app goes when it does", () => {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    setHeldAlerts(db, me, [{ title: "Gone is down", appId: "a" }, { title: "Kept is down", appId: "b" }, { title: "Key failed" }]);
    dropHeldAlerts(db, me, "a");
    assert.deepEqual(heldAlerts(db, me).map((a) => a.title), ["Kept is down", "Key failed"]);
  });

  function watcher(notify: (n: { title: string }) => Promise<void>, isOnline: () => Promise<boolean> = async () => true) {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    updateSettings(db, me, { watcherEnabled: false }); // nothing to check: only what's held
    return { db, me, watcher: new Watcher({ db, notifier: { notify }, baseUrl: "http://localhost:4100", isOnline }) };
  }

  test("if the message can't be shown it's tried again, a few times, then given up", async () => {
    let tries = 0;
    const { db, me, watcher: w } = watcher(async () => {
      tries++;
      throw new Error("no toast");
    });
    setHeldAlerts(db, me, [{ title: "A is down" }]);
    await w.tick(NOW);
    assert.equal(heldAlerts(db, me).length, 1, "it's still there for the next tick");
    await w.tick(NOW);
    await w.tick(NOW);
    assert.equal(tries, 3);
    assert.equal(heldAlerts(db, me).length, 0, "and not for ever");
    await w.tick(NOW);
    assert.equal(tries, 3);
  });

  test("shown once it isn't shown again", async () => {
    const sent: string[] = [];
    const { db, me, watcher: w } = watcher(async (n) => void sent.push(n.title));
    setHeldAlerts(db, me, [{ title: "A is down" }]);
    await w.tick(NOW);
    await w.tick(NOW);
    assert.deepEqual(sent, ["A is down"]);
  });

  test("a stuck tick doesn't keep it back", async () => {
    const sent: string[] = [];
    let first = true;
    const { db, me, watcher: w } = watcher((n) => {
      if (first) {
        first = false;
        return new Promise<void>(() => undefined); // this tick never finishes
      }
      sent.push(n.title);
      return Promise.resolve();
    });
    setHeldAlerts(db, me, [{ title: "First" }]);
    void w.tick(NOW);
    await new Promise((r) => setTimeout(r, 5));
    setHeldAlerts(db, me, [{ title: "Second" }]);
    await w.tick(NOW);
    assert.deepEqual(sent, ["Second"]);
  });
});

describe("diagnostics", () => {
  test("a problem's own words don't give away an app or an account", () => {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    store.createApp(db, me, { name: "Acme Billing", url: "https://billing.example.org" });
    store.createService(db, me, { type: "github", name: "Client Co", canWrite: false });
    recordProblem("Couldn't check Acme Billing's configuration");
    recordProblem("Client Co's key was refused");
    const report = diagnostics(db);
    assert.doesNotMatch(report, /Acme Billing/);
    assert.doesNotMatch(report, /Client Co/);
    assert.match(report, /Couldn't check \[name\]'s configuration/);
  });
});

describe("importing, where it could guess wrong", () => {
  const github = (resource: string, account?: string) => ({ type: "github", resource, settings: {}, ...(account ? { account } : {}) });
  const fileOf = (apps: unknown[]) => ({ periskopos: "1", apps, accounts: [] });

  function here() {
    const db = openDb(":memory:");
    const me = store.createUser(db, "Me").id;
    const plan = (file: unknown) => planImport(db, me, getSettings(db, me), file);
    return { db, me, plan };
  }

  test("two apps at one address keep their own connections", () => {
    const { db, me, plan } = here();
    store.createApp(db, me, { name: "Prod", url: "https://x.example.org" });
    store.createApp(db, me, { name: "Canary", url: "https://x.example.org" });
    store.createService(db, me, { type: "github", name: "Work", canWrite: false });
    const file = fileOf([
      { name: "Prod", url: "https://x.example.org", connections: [github("me/prod", "Work")] },
      { name: "Canary", url: "https://x.example.org", connections: [github("me/canary", "Work")] },
    ]);
    applyImport(db, me, plan(file), false);
    const repos = (name: string) => store.listApps(db, me).find((a) => a.name === name)!.connections.filter((c) => c.type === "github").map((c) => c.resource);
    assert.deepEqual(repos("Prod"), ["me/prod"]);
    assert.deepEqual(repos("Canary"), ["me/canary"]);
  });

  test("a renamed app is still the same app when there's only one at the address", () => {
    const { db, me, plan } = here();
    store.createApp(db, me, { name: "New name", url: "https://x.example.org" });
    assert.deepEqual(plan(fileOf([{ name: "Old name", url: "https://x.example.org" }])).plan.newApps, []);
  });

  test("with several at the address and none of that name, it says so rather than guess", () => {
    const { db, me, plan } = here();
    store.createApp(db, me, { name: "A", url: "https://x.example.org" });
    store.createApp(db, me, { name: "B", url: "https://x.example.org" });
    const { plan: seen } = plan(fileOf([{ name: "C", url: "https://x.example.org" }]));
    assert.deepEqual(seen.newApps, []);
    assert.match(seen.refused[0]!.why, /several apps/);
  });

  test("the preview names what a key would read, and whose key", () => {
    const { db, me, plan } = here();
    store.createService(db, me, { type: "github", name: "Personal", canWrite: false });
    const { plan: seen } = plan(fileOf([{ name: "Theirs", url: "https://t.example.org", connections: [github("someone/their-repo", "Client Co")] }]));
    assert.deepEqual(seen.newApps[0]!.connections, ["GitHub someone/their-repo (through Personal)"]);
  });

  test("a line it can't read doesn't count as a check removed by hand", () => {
    const { db, me, plan } = here();
    const file = fileOf([{ name: "A", url: "https://a.example.org", connections: [{ type: "ssl", resource: "bad host!" }, { type: "site", resource: "https://a.example.org" }] }]);
    const seen = plan(file);
    assert.equal(seen.plan.newApps[0]!.unread.length, 1);
    const [added] = applyImport(db, me, seen, false);
    assert.ok(added!.connections.some((c) => c.type === "ssl"));
    assert.equal(added!.connections.some((c) => c.type === "domain"), false, "domain wasn't in the file, so it was removed");
  });

  test("with no interval in the file, a new app gets the one new apps get", () => {
    const { db, me, plan } = here();
    updateSettings(db, me, { defaultCheckIntervalMin: 30 });
    const [added] = applyImport(db, me, plan(fileOf([{ name: "A", url: "https://a.example.org" }])), false);
    assert.equal(added!.checkIntervalMin, 30);
  });
});
