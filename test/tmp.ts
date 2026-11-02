import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Scratch folders for tests, all under one root per test process, removed
// when the process ends: node --test runs each file in its own process, so a
// file's folders go with it. A file still held open then (an SQLite database
// on Windows) can't be removed, so each run also clears roots a day old.

const PREFIX = "periskopos-test-";
const DAY = 24 * 60 * 60 * 1000;

let root: string | undefined;

function sweep(now = Date.now()) {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(PREFIX)) continue;
    const dir = path.join(tmpdir(), name);
    try {
      if (now - statSync(dir).mtimeMs > DAY) rmSync(dir, { recursive: true, force: true });
    } catch {
      // another run's, or still held open: a later run gets it
    }
  }
}

export function tempDir(prefix: string): string {
  if (!root) {
    sweep();
    root = mkdtempSync(path.join(tmpdir(), PREFIX));
    const dir = root;
    process.on("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
      } catch {
        // something in it is still open: the next run's sweep removes it
      }
    });
  }
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, prefix));
}
