import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import { fatalLine, parseFatalLine } from "../shared/desktop.ts";
import { createApp } from "../server/app.ts";
import { Backups, KEEP, backupName, backupsDir } from "../server/backup.ts";
import { DatabaseError, SCHEMA_VERSION, openDb } from "../server/db.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import { writeSecret } from "../server/keys/secrets.ts";
import { agentMayCall } from "../server/security.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// The database's daily copies (server/backup.ts), restoring one, and a
// database that won't open stopping the start with a reason.

const tmp = () => tempDir("periskopos-backup-");
const HOUR = 60 * 60 * 1000;

// A registry on disk with an app and an account in it, and a clock to move.
function registry() {
  const dataDir = tmp();
  const db = openDb(path.join(dataDir, "periskopos.db"));
  const user = store.createUser(db, "Me");
  store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org" });
  store.createApp(db, user.id, { name: "Moon-Base", url: "https://example.net" });
  let now = Date.parse("2026-10-18T09:30:00Z");
  const clock = {
    now: () => new Date(now),
    pass: (ms: number) => {
      now += ms;
    },
  };
  const backups = new Backups({ db, dir: backupsDir(dataDir), now: clock.now });
  return { dataDir, db, user, backups, clock };
}

describe("backing up the database", () => {
  test("a backup restores: put in place of the database, it opens with the apps in it", () => {
    const { dataDir, db, user, backups } = registry();
    const made = backups.backUpNow();
    assert.equal(made.name, "periskopos-2026-10-18T093000Z.db");
    assert.ok(made.bytes > 0);
    // Changes after the backup aren't in it.
    store.createApp(db, user.id, { name: "Later", url: "https://later.example" });
    db.close();

    // The README's restore: with the app quit, the backup in place of periskopos.db.
    const restoredDir = tmp();
    copyFileSync(path.join(backupsDir(dataDir), made.name), path.join(restoredDir, "periskopos.db"));
    const restored = openDb(path.join(restoredDir, "periskopos.db"));
    const me = store.getLocalUser(restored)!;
    assert.equal(me.name, "Me");
    assert.deepEqual(
      store.listApps(restored, me.id).map((a) => a.name).sort(),
      ["Moon-Base", "Star-Map"],
    );
    // Each app's checks came with it.
    assert.ok(store.listApps(restored, me.id).every((a) => a.connections.some((c) => c.type === "site")));
    assert.equal((restored.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, SCHEMA_VERSION);
    restored.close();
  });

  test("once a day: due with none yet, not again until a day has passed", () => {
    const { backups, clock } = registry();
    assert.equal(backups.due(), true);
    assert.ok(backups.runIfDue());
    clock.pass(23 * HOUR);
    assert.equal(backups.due(), false);
    assert.equal(backups.runIfDue(), undefined);
    clock.pass(HOUR);
    assert.equal(backups.due(), true);
    assert.ok(backups.runIfDue());
    assert.equal(backups.list().length, 2);
  });

  test(`keeps the last ${KEEP}, newest first, and leaves other files alone`, () => {
    const { backups, clock } = registry();
    mkdirSync(backups.dir, { recursive: true });
    writeFileSync(path.join(backups.dir, "mine.txt"), "not a backup");
    const names: string[] = [];
    for (let i = 0; i < KEEP + 3; i++) {
      names.push(backups.backUpNow().name);
      clock.pass(24 * HOUR);
    }
    const kept = backups.list().map((b) => b.name);
    assert.deepEqual(kept, names.slice(-KEEP).reverse());
    assert.ok(readdirSync(backups.dir).includes("mine.txt"));
    const status = backups.status();
    assert.equal(status.count, KEEP);
    assert.equal(status.last?.name, names.at(-1));
  });

  test("a copy cut short is never taken for a backup, and is cleared away", () => {
    const { backups, clock } = registry();
    backups.backUpNow();
    const partial = path.join(backups.dir, `${backupName(new Date("2026-10-01T00:00:00Z"))}.partial`);
    writeFileSync(partial, "half a database");
    assert.equal(backups.list().length, 1);
    clock.pass(24 * HOUR);
    backups.backUpNow();
    assert.deepEqual(readdirSync(backups.dir).filter((n) => n.endsWith(".partial")), []);
  });

  test("a backup that fails is shown in the status, and cleared by the next one that works", () => {
    const { backups } = registry();
    // A file where the backups folder should be: the copy can't be made.
    writeFileSync(backups.dir, "in the way");
    assert.equal(backups.runIfDue(), undefined);
    assert.ok(backups.status().error, "the failure is reported");
    rmSync(backups.dir);
    assert.ok(backups.runIfDue());
    assert.equal(backups.status().error, undefined);
  });

  test("never has the keys in it: they stay in the keys file (AGENT-SAFETY §4.3)", () => {
    const keysFile = path.join(tmp(), ".env.local");
    const before = process.env.PERISKOPOS_ENV_FILE;
    process.env.PERISKOPOS_ENV_FILE = keysFile;
    try {
      const { db, user, backups } = registry();
      const key = `ghp_${"k".repeat(36)}`;
      writeSecret("GITHUB_TOKEN_BACKUP_TEST", key);
      store.createService(db, user.id, { type: "github", name: "GitHub", secretRef: "GITHUB_TOKEN_BACKUP_TEST", canWrite: false });
      const made = backups.backUpNow();
      assert.match(readFileSync(keysFile, "utf8"), new RegExp(key));
      const copy = readFileSync(path.join(backups.dir, made.name));
      assert.equal(copy.includes(key), false, "the key is in the backup");
      // Only database copies in the folder: no keys file, no token.
      assert.deepEqual(readdirSync(backups.dir).filter((n) => !n.endsWith(".db")), []);
    } finally {
      if (before === undefined) delete process.env.PERISKOPOS_ENV_FILE;
      else process.env.PERISKOPOS_ENV_FILE = before;
    }
  });
});

describe("a database that won't open", () => {
  test("a file that isn't a database says so, and is left as it was", () => {
    const file = path.join(tmp(), "periskopos.db");
    writeFileSync(file, "this is not a database, it's a shopping list ".repeat(100));
    assert.throws(() => openDb(file), (err: Error) => err instanceof DatabaseError && /Couldn't open the database/.test(err.message) && /not a database/.test(err.message));
    assert.match(readFileSync(file, "utf8"), /shopping list/);
  });

  test("a backup from a newer Periskopos is refused, not half-used", () => {
    const file = path.join(tmp(), "periskopos.db");
    openDb(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    raw.close();
    assert.throws(() => openDb(file), (err: Error) => err instanceof DatabaseError && /newer Periskopos/.test(err.message));
  });

  test("a step that can't be applied names the schema it was going to", () => {
    const file = path.join(tmp(), "periskopos.db");
    const raw = new DatabaseSync(file);
    // Schema 1 claimed, but a table the next step makes is already there.
    raw.exec("CREATE TABLE checks (id INTEGER); PRAGMA user_version = 1");
    raw.close();
    assert.throws(() => openDb(file), (err: Error) => err instanceof DatabaseError && /schema 2/.test(err.message));
  });

  test("the reason reaches the app's dialog as one line on the server's output", () => {
    const message = "Couldn't open the database C:\\x\\periskopos.db: file is not a database\n\nTo restore a backup, quit…";
    assert.equal(parseFatalLine(fatalLine(message)), message);
    assert.equal(parseFatalLine("@periskopos-fatal {broken"), undefined);
    assert.equal(parseFatalLine("Couldn't open the database"), undefined);
  });
});

describe("Back up now, from Settings", () => {
  const TOKEN = "t".repeat(43);
  const distDir = tmp();
  writeFileSync(path.join(distDir, "index.html"), '<meta name="periskopos" content="app" />');

  test("the API makes a copy and says when the last one was; an agent can't ask for one", async () => {
    const { db, backups } = registry();
    const watcher = new Watcher({ db, notifier: silentNotifier, baseUrl: "http://localhost:4100", isOnline: async () => true });
    const gc = createApp({ db, token: TOKEN, port: 4100, distDir, watcher, backups });
    const call = (method: string, url: string) => gc.request(`http://localhost:4100${url}`, { method, headers: { "x-periskopos-token": TOKEN } });

    const before = (await (await call("GET", "/api/settings")).json()) as { backups: { count: number; last?: unknown; dir: string } };
    assert.equal(before.backups.count, 0);
    assert.equal(before.backups.last, undefined);
    assert.equal(before.backups.dir, backups.dir);

    const res = await call("POST", "/api/settings/backup");
    assert.equal(res.status, 200);
    const after = (await res.json()) as { backups: { count: number; last?: { name: string } } };
    assert.equal(after.backups.count, 1);
    assert.equal(after.backups.last?.name, "periskopos-2026-10-18T093000Z.db");

    assert.equal(agentMayCall("POST", "/api/settings/backup"), false);
    assert.equal(agentMayCall("GET", "/api/settings"), true);
  });
});
