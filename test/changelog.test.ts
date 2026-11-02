import assert from "node:assert/strict";
import { test } from "node:test";
import { stampChangelog } from "../scripts/changelog.ts";

const log = "# Changelog\n\n## Next release\n\n- A change.\n\n## 0.3.8 (2026-11-02)\n\n- Older.\n";

test("npm version turns Next release into the new version and today, leaving older releases alone", () => {
  assert.equal(stampChangelog(log, "0.3.9", "2026-11-03"), "# Changelog\n\n## 0.3.9 (2026-11-03)\n\n- A change.\n\n## 0.3.8 (2026-11-02)\n\n- Older.\n");
});

test("a release without a Next release section is stopped before it's tagged", () => {
  assert.throws(() => stampChangelog("# Changelog\n\n## 0.3.8 (2026-11-02)\n", "0.3.9", "2026-11-03"), /no "## Next release" section/);
  // Only a heading of its own counts, not the words in a sentence.
  assert.throws(() => stampChangelog("Notes go under ## Next release.\n", "0.3.9", "2026-11-03"), /no "## Next release"/);
});
