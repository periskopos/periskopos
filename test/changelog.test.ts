import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { stampChangelog } from "../scripts/changelog.ts";

const log = "# Changelog\n\n## Next release\n\n- A change.\n\n## 0.3.8 (2026-11-02)\n\n- Older.\n";

test("npm version turns Next release into the new version and today, leaving older releases alone", () => {
  assert.equal(stampChangelog(log, "0.3.9", "2026-11-03"), "# Changelog\n\n## 0.3.9 (2026-11-03)\n\n- A change.\n\n## 0.3.8 (2026-11-02)\n\n- Older.\n");
});

test("the script stamps today's local date, even when UTC is still on yesterday", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "periskopos-changelog-"));
  const script = path.resolve("scripts/changelog.ts");
  const stamped = (TZ: string) => {
    writeFileSync(path.join(dir, "CHANGELOG.md"), log);
    execFileSync(process.execPath, [script], { cwd: dir, env: { ...process.env, TZ, npm_package_version: "0.3.9" }, stdio: "ignore" });
    return /^## 0\.3\.9 \((.+)\)$/m.exec(readFileSync(path.join(dir, "CHANGELOG.md"), "utf8"))![1];
  };
  try {
    // 26 hours apart, so never the same date: a date from UTC would be the same in both.
    assert.notEqual(stamped("Pacific/Kiritimati"), stamped("Etc/GMT+12"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a release without a Next release section is stopped before it's tagged", () => {
  assert.throws(() => stampChangelog("# Changelog\n\n## 0.3.8 (2026-11-02)\n", "0.3.9", "2026-11-03"), /no "## Next release" section/);
  // Only a heading of its own counts, not the words in a sentence.
  assert.throws(() => stampChangelog("Notes go under ## Next release.\n", "0.3.9", "2026-11-03"), /no "## Next release"/);
});
