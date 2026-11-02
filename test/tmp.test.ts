import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The tests' scratch folders (test/tmp.ts) don't pile up in the system's
// temp folder: tens of thousands had, one set per run.

const helper = pathToFileURL(path.join(import.meta.dirname, "tmp.ts")).href;

// A process that makes a folder through the helper, puts a file in it, says
// where, and ends.
const runChild = () =>
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { writeFileSync } from "node:fs";
    import path from "node:path";
    import { tempDir } from ${JSON.stringify(helper)};
    const dir = tempDir("periskopos-check-");
    writeFileSync(path.join(dir, "a.txt"), "x");
    console.log(dir);
  `], { encoding: "utf8" }).trim();

test("a test's folder is gone once its process ends", () => {
  const dir = runChild();
  assert.ok(dir.startsWith(path.join(tmpdir(), "periskopos-test-")), dir);
  assert.equal(existsSync(dir), false);
  assert.equal(existsSync(path.dirname(dir)), false, "nor is the run's root");
});

test("a root left by an earlier run is cleared once it's a day old, not before", () => {
  const old = path.join(tmpdir(), `periskopos-test-old${process.pid}`);
  const recent = path.join(tmpdir(), `periskopos-test-new${process.pid}`);
  for (const dir of [old, recent]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "periskopos.db"), "");
  }
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  utimesSync(old, twoDaysAgo, twoDaysAgo);
  try {
    runChild();
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(recent), true);
  } finally {
    rmSync(old, { recursive: true, force: true });
    rmSync(recent, { recursive: true, force: true });
  }
});
