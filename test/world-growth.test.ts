import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { growDelay, growMs, growthSince, parseSeen, riseShare, seenNow, widenShare } from "../shared/valley/growth.ts";
import type { Seen } from "../shared/valley/growth.ts";

const plot = (slug: string, floors = 3, look = "lit", requests?: number) => ({ slug, floors, look, requests }) as Parameters<typeof growthSince>[1][number];
const seen = (...plots: Parameters<typeof growthSince>[1]) => seenNow(null, plots, "town");

describe("what's grown since the last look", () => {
  test("nothing on the first look: there's nothing to compare with", () => {
    const grown = growthSince(null, [plot("a")]);
    assert.equal(grown.plots.size, 0);
  });

  test("nothing if nothing changed", () => {
    const before = seen(plot("a", 3, "lit", 500));
    const grown = growthSince(before, [plot("a", 3, "lit", 500)]);
    assert.equal(grown.plots.size, 0);
  });

  test("a new app's building rises, all its floors", () => {
    assert.deepEqual(growthSince(seen(plot("a")), [plot("a"), plot("b", 5)]).plots.get("b"), { rise: true, floors: 5, wider: null });
  });

  test("a plot with no building has nothing to bring up, until it has one", () => {
    const before = seen(plot("a", 2, "scaffold"));
    assert.equal(growthSince(null, [plot("a", 2, "scaffold")]).plots.size, 0);
    assert.equal(growthSince(before, [plot("a", 2, "scaffold")]).plots.size, 0);
    assert.equal(growthSince(before, [plot("a", 2, "empty")]).plots.size, 0);
    assert.equal(growthSince(before, [plot("a", 2, "lit")]).plots.get("a")?.rise, true);
  });

  test("more floors, or a bigger size, grows it; only the difference goes up", () => {
    assert.deepEqual(growthSince(seen(plot("a", 3)), [plot("a", 5)]).plots.get("a"), { rise: false, floors: 2, wider: null });
    assert.deepEqual(growthSince(seen(plot("a", 3, "lit", 500)), [plot("a", 3, "lit", 5000)]).plots.get("a"), { rise: false, floors: 0, wider: "small" });
  });

  test("nothing shrinks on show", () => {
    assert.equal(growthSince(seen(plot("a", 5, "lit", 200_000)), [plot("a", 2, "lit", 50)]).plots.size, 0);
  });

  test("a building's state isn't growth: down, fog and frost aren't new buildings", () => {
    const before = seen(plot("a"));
    for (const look of ["dark", "fog", "frozen", "warning"]) assert.equal(growthSince(before, [plot("a", 3, look)]).plots.size, 0, look);
  });

  test("traffic not read yet isn't traffic gone, or gained once it's read", () => {
    const before = seen(plot("a", 3, "lit", 5000));
    const unread = [plot("a", 3, "lit")];
    assert.equal(growthSince(before, unread).plots.size, 0);
    const after = seenNow(before, unread, "town");
    assert.equal(after.plots.a?.size, "standard", "what was known is kept");
    assert.equal(growthSince(after, [plot("a", 3, "lit", 5000)]).plots.size, 0);
    // Never known at all, then read: that's learning its size, not its growing.
    assert.equal(growthSince(seen(plot("a", 3, "lit")), [plot("a", 3, "lit", 500_000)]).plots.size, 0);
  });

  test("an app that went away and came back rises again", () => {
    const gone = seenNow(seen(plot("a"), plot("b")), [plot("a")], "town");
    assert.equal(growthSince(gone, [plot("a"), plot("b")]).plots.get("b")?.rise, true);
  });

  test("what's remembered survives being saved, and nonsense is nothing", () => {
    const before: Seen = seen(plot("a", 3, "lit", 500));
    assert.deepEqual(parseSeen(JSON.parse(JSON.stringify(before))), before);
    for (const bad of [null, 3, "x", {}, { stage: "town" }, { stage: 1, plots: {} }, { stage: "town", plots: { a: { floors: "2", built: true } } }, { stage: "town", plots: { a: null } }]) assert.equal(parseSeen(bad), null, JSON.stringify(bad));
  });
});

describe("how growing looks", () => {
  test("goes up from nothing to everything, never back down", () => {
    for (const floors of [1, 3, 10]) {
      let last = 0;
      assert.equal(riseShare(0, floors), 0);
      for (let ms = 0; ms <= growMs(floors); ms += 8) {
        const share = riseShare(ms, floors);
        assert.ok(share >= last - 1e-9, `fell back at ${ms} ms with ${floors} floors`);
        last = share;
      }
      assert.equal(riseShare(growMs(floors), floors), 1);
      assert.equal(riseShare(growMs(floors) + 500, floors), 1);
    }
  });

  test("comes up a floor at a time, with a pause between", () => {
    const floors = 4;
    const justBefore = riseShare(growMs(floors) * 0.48, floors);
    const justAfter = riseShare(growMs(floors) * 0.5, floors);
    assert.ok(Math.abs(justBefore - 0.5) < 1e-6, "two floors up, and waiting");
    assert.ok(Math.abs(justAfter - 0.5) < 1e-6, "still waiting");
  });

  test("a taller building takes longer, but nobody waits for long", () => {
    assert.ok(growMs(8) > growMs(4));
    assert.ok(growMs(1) >= 1000);
    assert.ok(growMs(100) <= 5000);
    assert.ok(growDelay(1000) <= 3000);
    assert.ok(growDelay(1) > growDelay(0));
  });

  test("widening starts and ends still", () => {
    assert.equal(widenShare(0, 3), 0);
    assert.equal(widenShare(growMs(3), 3), 1);
    assert.ok(widenShare(100, 3) < 0.1);
  });
});
