import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { BackupFile, BackupStatus } from "../shared/types.ts";

// A copy of the whole registry (apps, connections, accounts, settings and
// the history) once a day, made by SQLite itself while the app runs
// (VACUUM INTO: a consistent snapshot, WAL included). The last KEEP are
// kept in backups/ beside the database. The keys are never in it: they live
// only in the keys file (docs/AGENT-SAFETY.md §4.3).
//
// Restoring is by hand, with Periskopos quit: copy a backup in place of
// periskopos.db (README: Backups).

export const KEEP = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_EVERY_MS = 60 * 60 * 1000;
const NAME = /^periskopos-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})Z\.db$/;

export const backupsDir = (dataDir: string): string => path.join(dataDir, "backups");

// periskopos-2026-10-18T093000Z.db: sorts by time, and says when.
export function backupName(at: Date): string {
  const iso = at.toISOString(); // 2026-10-18T09:30:00.000Z
  return `periskopos-${iso.slice(0, 10)}T${iso.slice(11, 19).replaceAll(":", "")}Z.db`;
}

function timeOf(name: string): string | undefined {
  const m = NAME.exec(name);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : undefined;
}

export class Backups {
  readonly dir: string;
  private db: DatabaseSync;
  private now: () => Date;
  private timer: NodeJS.Timeout | undefined;
  private lastError: string | undefined;

  constructor({ db, dir, now = () => new Date() }: { db: DatabaseSync; dir: string; now?: () => Date }) {
    this.db = db;
    this.dir = dir;
    this.now = now;
  }

  // Newest first. Only our own copies: anything else in the folder is left alone.
  list(): BackupFile[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .flatMap((name) => {
        const at = timeOf(name);
        return at ? [{ name, at, bytes: statSync(path.join(this.dir, name)).size }] : [];
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  status(): BackupStatus {
    const all = this.list();
    return { dir: this.dir, keep: KEEP, count: all.length, ...(all[0] ? { last: all[0] } : {}), ...(this.lastError ? { error: this.lastError } : {}) };
  }

  // Written under a temporary name and renamed when complete, so a copy cut
  // short (the app quit, the disk filled) is never taken for a backup.
  backUpNow(): BackupFile {
    mkdirSync(this.dir, { recursive: true });
    const name = backupName(this.now());
    const file = path.join(this.dir, name);
    const partial = `${file}.partial`;
    if (!this.list().some((b) => b.name === name)) {
      rmSync(partial, { force: true });
      try {
        this.db.prepare("VACUUM INTO ?").run(partial);
        renameSync(partial, file);
      } catch (err) {
        rmSync(partial, { force: true });
        throw err;
      }
    }
    this.prune();
    this.lastError = undefined;
    return this.list().find((b) => b.name === name)!;
  }

  // A day since the newest copy, or none yet.
  due(): boolean {
    const last = this.list()[0];
    return !last || this.now().getTime() - Date.parse(last.at) >= DAY_MS;
  }

  runIfDue(): BackupFile | undefined {
    if (!this.due()) return undefined;
    try {
      const made = this.backUpNow();
      console.log(`Backed up the database to ${path.join(this.dir, made.name)}`);
      return made;
    } catch (err) {
      this.lastError = (err as Error).message;
      console.error(`Couldn't back up the database: ${this.lastError}`);
      return undefined;
    }
  }

  // At start (a PC that's off at night still gets its daily copy), then
  // every hour to see whether a day has passed.
  start(): void {
    this.stop();
    this.runIfDue();
    this.timer = setInterval(() => this.runIfDue(), CHECK_EVERY_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private prune(): void {
    for (const old of this.list().slice(KEEP)) rmSync(path.join(this.dir, old.name), { force: true });
    // Left by a copy that was cut short (a copy runs start to finish
    // before anything else does, so none is under way now).
    for (const name of readdirSync(this.dir)) {
      if (name.endsWith(".partial") && NAME.test(name.slice(0, -".partial".length))) rmSync(path.join(this.dir, name), { force: true });
    }
  }
}
