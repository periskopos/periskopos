import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";

// This project is pure TypeScript: no JavaScript source, no escape hatches
// from the type checker, and a strict compiler. CSS and HTML aren't
// programs, so they're fine. A failure here means one of those slipped in.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP = new Set(["node_modules", "dist", "release", "data", ".git", ".design", ".claude"]);
const SELF = path.join("test", "purity.test.ts");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(path.relative(ROOT, full));
  }
  return out;
}

// The one generated JavaScript file: desktop/preload.cts with its types
// stripped (build-preload.ts), because a sandboxed preload must be plain
// CommonJS. It is gitignored; the source stays TypeScript.
const GENERATED = new Set([path.join("desktop", "build", "preload.cjs")]);
const files = walk(ROOT).filter((f) => !GENERATED.has(f));
const sources = files.filter((f) => f.endsWith(".ts") && f !== SELF);

describe("pure TypeScript", () => {
  test("there is no JavaScript source", () => {
    const js = files.filter((f) => /\.(js|mjs|cjs|jsx)$/.test(f));
    assert.deepEqual(js, [], "convert these to TypeScript");
  });

  test("no explicit any, and no way around the type checker", () => {
    const banned: [RegExp, string][] = [
      [/:\s*any\b/, "an explicit `any` type"],
      [/\bas\s+any\b/, "a cast to `any`"],
      [/<any>/, "an `any` type argument"],
      [/@ts-ignore/, "@ts-ignore"],
      [/@ts-nocheck/, "@ts-nocheck"],
      [/@ts-expect-error/, "@ts-expect-error"],
    ];
    // The scan itself: it finds the code, and its patterns catch what they name.
    assert.ok(sources.includes(path.join("server", "db.ts")) && sources.includes(path.join("web", "src", "format.ts")), "the walk reaches the sources");
    for (const [line, what] of [["let x: any = 1;", "an explicit `any` type"], ["f(y as any)", "a cast to `any`"], ["// @ts-ignore", "@ts-ignore"]]) {
      assert.ok(banned.some(([pattern, name]) => name === what && pattern.test(line!)), line);
    }
    const found: string[] = [];
    for (const file of sources) {
      readFileSync(path.join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          for (const [pattern, what] of banned) if (pattern.test(line)) found.push(`${file}:${i + 1} has ${what}`);
        });
    }
    assert.deepEqual(found, []);
  });

  test("the compiler stays strict", () => {
    const { compilerOptions: o } = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as { compilerOptions: Record<string, unknown> };
    for (const flag of ["strict", "noUnusedLocals", "noUnusedParameters", "noImplicitReturns", "noFallthroughCasesInSwitch", "noImplicitOverride", "erasableSyntaxOnly", "verbatimModuleSyntax"]) {
      assert.equal(o[flag], true, `tsconfig.json must keep ${flag}: true`);
    }
    assert.equal(o.allowJs, false, "tsconfig.json must keep allowJs: false");
  });

  test("every TypeScript folder is type-checked", () => {
    const { include } = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as { include: string[] };
    const folders = new Set(sources.map((f) => f.split(path.sep)[0]).filter((f) => f.endsWith(".ts") === false));
    assert.ok(folders.has("server") && folders.has("web"), "the folders are found");
    for (const folder of folders) assert.ok(include.includes(folder), `tsconfig.json doesn't include ${folder}/`);
  });
});
