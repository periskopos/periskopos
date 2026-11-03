// npm version runs this (the "version" script in package.json) after raising
// the version and before committing: CHANGELOG.md's "## Next release" becomes
// "## <version> (<today>)", so package.json stays the one place the version
// is written. A release with no "Next release" section stops here, before
// anything is committed or tagged.
import { readFileSync, writeFileSync } from "node:fs";
import { dayKey } from "../server/history.ts";

export function stampChangelog(text: string, version: string, date: string): string {
  if (!/^## Next release$/m.test(text)) {
    throw new Error('CHANGELOG.md has no "## Next release" section: add this release\'s larger steps under one first.');
  }
  return text.replace(/^## Next release$/m, `## ${version} (${date})`);
}

if (import.meta.main) {
  const version = process.env.npm_package_version ?? JSON.parse(readFileSync("package.json", "utf8")).version;
  const file = "CHANGELOG.md";
  try {
    // Today where I am, not in UTC: a release just after midnight is that day's.
    writeFileSync(file, stampChangelog(readFileSync(file, "utf8"), version, dayKey(Date.now())));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}
