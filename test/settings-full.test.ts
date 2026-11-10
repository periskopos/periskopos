import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
import { DEFAULT_SHELL_PREFS, readShellPrefs, sanitizeShellPrefs, writeShellPrefs } from "../desktop/shell-prefs.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { DEFAULT_SETTINGS, getSettings, resetSettings, updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";

describe("the app's own preferences", () => {
  test("anything odd becomes the default", () => {
    for (const bad of [null, 3, "x", {}, { theme: "blue", onClose: "explode" }]) assert.deepEqual(sanitizeShellPrefs(bad), DEFAULT_SHELL_PREFS);
    assert.deepEqual(sanitizeShellPrefs({ theme: "light", onClose: "quit" }), { theme: "light", onClose: "quit" });
  });

  test("they survive being saved, and a missing or corrupt file is just the defaults", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "periskopos-prefs-"));
    assert.deepEqual(readShellPrefs(dir), DEFAULT_SHELL_PREFS);
    assert.equal(writeShellPrefs(dir, { theme: "dark", onClose: "quit" }), true);
    assert.deepEqual(readShellPrefs(dir), { theme: "dark", onClose: "quit" });
    assert.match(readFileSync(path.join(dir, "shell-prefs.json"), "utf8"), /"dark"/);
    writeFileSync(path.join(dir, "shell-prefs.json"), "{ not json");
    assert.deepEqual(readShellPrefs(dir), DEFAULT_SHELL_PREFS);
  });
});

describe("settings kept by the server", () => {
  let db: ReturnType<typeof openDb>;
  let userId: string;
  beforeEach(() => {
    db = openDb(":memory:");
    userId = store.createUser(db, "Me").id;
  });

  test("a new app gets the chosen interval, and all can be moved to one", () => {
    const first = store.createApp(db, userId, { name: "One", url: "https://one.example" });
    assert.equal(first.checkIntervalMin, 5, "the default stays 5");
    const second = store.createApp(db, userId, { name: "Two", url: "https://two.example", checkIntervalMin: 15 });
    assert.equal(second.checkIntervalMin, 15);
    assert.equal(store.setAllCheckIntervals(db, userId, 30), 2);
    assert.deepEqual(store.listApps(db, userId).map((a) => a.checkIntervalMin), [30, 30]);
  });

  test("another's apps aren't moved", () => {
    const other = store.createUser(db, "Other").id;
    store.createApp(db, other, { name: "Theirs", url: "https://theirs.example" });
    assert.equal(store.setAllCheckIntervals(db, userId, 30), 0);
  });

  test("a name can be changed, and stays changed", () => {
    const user = store.getLocalUser(db)!;
    assert.equal(store.renameUser(db, user, "New name").name, "New name");
    assert.equal(store.getLocalUser(db)!.name, "New name");
  });

  test("restoring defaults keeps where phone alerts go and how long checks are kept", () => {
    updateSettings(db, userId, { watcherEnabled: false, alertDeploys: false, agentAccess: true, alertsPausedUntil: "2099-01-01T00:00:00Z", defaultCheckIntervalMin: 30, phoneChannel: "email", emailTo: "me@example.org", checksKeptDays: 90 });
    const after = resetSettings(db, userId);
    assert.equal(after.watcherEnabled, true);
    assert.equal(after.alertDeploys, true);
    assert.equal(after.agentAccess, false);
    assert.equal(after.alertsPausedUntil, "");
    assert.equal(after.defaultCheckIntervalMin, DEFAULT_SETTINGS.defaultCheckIntervalMin);
    assert.equal(after.phoneChannel, "email");
    assert.equal(after.emailTo, "me@example.org");
    assert.equal(after.checksKeptDays, 90);
    assert.deepEqual(getSettings(db, userId), after);
  });

  test("checks are kept for as long as asked", () => {
    const app = store.createApp(db, userId, { name: "One", url: "https://one.example" });
    const conn = app.connections[0]!;
    const now = Date.now();
    const daysAgo = (n: number) => new Date(now - n * 24 * 60 * 60_000).toISOString();
    history.recordCheck(db, app.id, conn.id, { state: "up", at: daysAgo(60) });
    history.recordCheck(db, app.id, conn.id, { state: "up", at: daysAgo(10) });
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM checks").get() as { n: number }).n;
    history.prune(db, now, 90);
    assert.equal(count(), 2, "90 days keeps both");
    history.prune(db, now, 30);
    assert.equal(count(), 1, "30 days drops the older one");
  });
});
