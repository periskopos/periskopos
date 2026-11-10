import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SCREEN, screenBack, shareFor } from "../shared/valley/screen.ts";
import { antennaLight } from "../shared/world.ts";

describe("the screen behind a sign's logo", () => {
  test("says nothing where the light says nothing", () => {
    for (const look of ["fog", "frozen", "empty", "scaffold", "unknown", "past"] as const) assert.equal(antennaLight(look), null, look);
    assert.equal(screenBack(null), SCREEN);
    assert.equal(screenBack(undefined), SCREEN);
  });

  test("a status colour is a dark tint of it, never the colour itself", () => {
    const green = screenBack("#22c55e");
    assert.notEqual(green, SCREEN);
    assert.notEqual(green, "#22c55e");
    // Still a dark screen: white and coloured logos read on it.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(green.slice(i, i + 2), 16));
    assert.ok(Math.max(r!, g!, b!) < 90, green);
    assert.ok(g! > r! && g! > b!, "and green is the colour it leans to");
  });

  test("the whole status colour or none of it, at the ends", () => {
    assert.equal(screenBack("#ff0000", 1), "#ff0000");
    assert.equal(screenBack("#ff0000", 0), SCREEN);
  });

  test("trouble shows more of its colour than calm, and still leaves a dark screen", () => {
    assert.ok(shareFor("attention") > shareFor("up"));
    assert.equal(shareFor("down"), shareFor("attention"));
    assert.equal(shareFor("info"), shareFor("up"));
    const amber = screenBack("#f59e0b", shareFor("attention"));
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(amber.slice(i, i + 2), 16));
    assert.ok(r! > g! && g! > b!, `${amber} leans amber`);
    assert.ok(Math.max(r!, g!, b!) < 130, `${amber} keeps a white logo readable`);
  });

  test("a colour that can't be read is the plain screen", () => {
    assert.equal(screenBack("red"), SCREEN);
  });
});
