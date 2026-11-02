// Turns desktop/preload.cts into desktop/build/preload.cjs by stripping its
// types (Node's own stripper, the same one that runs the rest of the project
// as TypeScript). Run before the app starts or is packaged.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function preloadSource(): string {
  return stripTypeScriptTypes(readFileSync(path.join(here, "..", "preload.cts"), "utf8"), { mode: "strip" });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  mkdirSync(here, { recursive: true });
  writeFileSync(path.join(here, "preload.cjs"), preloadSource());
  console.log("[build-preload] wrote desktop/build/preload.cjs");
}
