// The design system's rules, checked (docs/DESIGN.md): styles take their colours from tokens.css,
// and every token a style uses exists.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

const TOKENS = "web/src/tokens.css";
const STYLES = "web/src/styles";
const read = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const styles = readdirSync(STYLES)
  .filter((f) => f.endsWith(".css"))
  .map((f) => ({ file: `${STYLES}/${f}`, css: read(`${STYLES}/${f}`) }));

// The only places a style may name a colour itself, each with its reason.
const ALLOWED: { file: string; selector: RegExp; why: string }[] = [
  { file: "accounts.css", selector: /^\.service-logo--[a-z-]+$/, why: "a service's own logo colour" },
  { file: "world.css", selector: /^(\.is-dusk )?\.world-clouds(-sky|\.is-dusk)?$/, why: "the World's sky, a picture rather than a surface" },
];

const RAW_COLOUR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch)\(/g;

// Each innermost rule, with the selector it sits under (media queries' own blocks are skipped).
const rules = (css: string) =>
  [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((m) => ({ selector: m[1]!.trim().replace(/\s+/g, " "), body: m[2]! }));

describe("the design system", () => {
  test("styles take their colours from tokens.css, outside the few named exceptions", () => {
    const strays: string[] = [];
    for (const { file, css } of styles) {
      const name = file.slice(STYLES.length + 1);
      for (const { selector, body } of rules(css)) {
        const found = body.match(RAW_COLOUR);
        if (!found) continue;
        const allowed = ALLOWED.some((a) => a.file === name && selector.split(",").every((s) => a.selector.test(s.trim())));
        if (!allowed) strays.push(`${name} ${selector}: ${found.join(" ")}`);
      }
    }
    assert.deepEqual(strays, [], "use a token from tokens.css, or add one there");
  });

  test("every exception still has something to excuse", () => {
    for (const a of ALLOWED) {
      const css = styles.find((s) => s.file.endsWith(`/${a.file}`))!.css;
      const used = rules(css).some((r) => r.body.match(RAW_COLOUR) && r.selector.split(",").every((s) => a.selector.test(s.trim())));
      assert.ok(used, `${a.file} ${a.selector} (${a.why}) no longer names a colour; drop the exception`);
    }
  });

  test("every token a style uses is defined", () => {
    const all = [read(TOKENS), ...styles.map((s) => s.css)].join("\n");
    const defined = new Set([...all.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
    const missing = new Set<string>();
    for (const { file, css } of styles) {
      for (const m of css.matchAll(/var\((--[a-z0-9-]+)\s*(,)?/g)) {
        if (!defined.has(m[1]) && !m[2]) missing.add(`${file.slice(STYLES.length + 1)} ${m[1]}`);
      }
    }
    assert.deepEqual([...missing], []);
  });
});
