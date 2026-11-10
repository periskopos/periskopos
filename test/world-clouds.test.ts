import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { cloudsMayLift, FIRST_LOOK_MS, GIVE_UP_MS, LOOK_AGAIN_MS } from "../web/src/views/world/clouds.ts";

describe("the clouds on opening the World", () => {
  const at = (elapsedMs: number, pictureUp = false, noPicture = false) => cloudsMayLift({ elapsedMs, shortestMs: FIRST_LOOK_MS, pictureUp, noPicture });

  test("stay until the picture is up", () => {
    assert.equal(at(FIRST_LOOK_MS + 1000), false);
    assert.equal(at(FIRST_LOOK_MS + 1000, true), true);
  });

  test("a picture that's quick still gets its moment", () => {
    assert.equal(at(100, true), false);
    assert.equal(at(FIRST_LOOK_MS, true), true);
  });

  test("coming back is quicker than the first time", () => {
    assert.ok(LOOK_AGAIN_MS < FIRST_LOOK_MS);
  });

  test("never stand in front of a page with no picture coming", () => {
    assert.equal(at(0, false, true), true);
  });

  test("never hold the page, however the picture is going", () => {
    assert.equal(at(GIVE_UP_MS - 1), false);
    assert.equal(at(GIVE_UP_MS), true);
  });

  test("move only what keeps moving while the page is busy, and stay out of the way", () => {
    const css = readFileSync("web/src/styles/world.css", "utf8").replace(/\r\n/g, "\n");
    const block = (name: string) => css.slice(css.indexOf(`@keyframes ${name}`)).split("\n}\n")[0]!;
    for (const name of ["world-cloud-nearer", "world-cloud-seen", "world-clouds-word-in"]) {
      assert.ok(block(name).length > 0);
      const moved = [...block(name).matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]);
      assert.ok(moved.length > 0 && moved.every((p) => p === "transform" || p === "opacity"), `${name} moves ${moved.join(", ")}`);
    }
    assert.match(css, /\.world-clouds \{[^}]*pointer-events: none/);
    assert.match(css, /prefers-reduced-motion: reduce\) \{[^}]*\.world-clouds-layer/);
  });
});
