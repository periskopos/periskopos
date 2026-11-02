import { closeSync, existsSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

// Keep the server's output. A packaged app has no console, so without this
// every line would be discarded and "it didn't start" would have nothing to
// send. Output goes to a dated file under the data folder, rotated when it
// passes a size and pruned after a few days.

export const MAX_LOG_BYTES = 5 * 1024 * 1024; // rotate past this so a runaway can't fill the disk
export const KEEP_LOG_DAYS = 5;

// Today's log, and the .1 that rotation leaves behind.
const NAME_RE = /^periskopos-(\d{4}-\d{2}-\d{2})\.log(?:\.1)?$/;

export function logFileName(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `periskopos-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`;
}

// Which files to delete, keeping the newest `keep` days. Only names this
// module made: anything else in the folder isn't ours to remove. Kept by date
// rather than by file, because a day can hold two (the live file and its .1).
export function logsToPrune(names: readonly string[], keep: number = KEEP_LOG_DAYS): string[] {
  const dated = names.flatMap((name) => {
    const date = NAME_RE.exec(name)?.[1];
    return date === undefined ? [] : [{ name, date }];
  });
  const kept = new Set([...new Set(dated.map((d) => d.date))].sort().reverse().slice(0, Math.max(0, keep)));
  return dated.filter((d) => !kept.has(d.date)).map((d) => d.name);
}

export type DaemonLog = { readonly path: string; write(chunk: string): void; close(): void };

const fileSize = (file: string): number => {
  try {
    return existsSync(file) ? statSync(file).size : 0;
  } catch {
    return 0;
  }
};

export function openDaemonLog(dir: string, now: Date = new Date(), maxBytes: number = MAX_LOG_BYTES): DaemonLog {
  mkdirSync(dir, { recursive: true });
  for (const name of logsToPrune(readdirSync(dir))) {
    try {
      rmSync(join(dir, name), { force: true });
    } catch {
      // A locked old log is not worth failing a launch over.
    }
  }

  const path = join(dir, logFileName(now));
  let written = fileSize(path);
  // A held descriptor with writeSync, not a stream: a stream's buffer is lost
  // if the process dies, which is exactly when the log is wanted.
  let fd: number | null = null;
  const open = (): number => (fd ??= openSync(path, "a"));
  const closeFd = (): void => {
    if (fd === null) return;
    try {
      closeSync(fd);
    } catch {
      // Already gone.
    }
    fd = null;
  };
  const rotate = (): void => {
    closeFd();
    try {
      renameSync(path, `${path}.1`);
    } catch {
      // Best effort: keep appending rather than lose output.
    }
    written = 0;
  };

  return {
    path,
    write(chunk) {
      if (written >= maxBytes) rotate();
      written += Buffer.byteLength(chunk, "utf8");
      try {
        writeSync(open(), chunk);
      } catch {
        // Never let logging take down the shell.
      }
    },
    close: closeFd,
  };
}
