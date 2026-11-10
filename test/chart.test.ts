import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { axisPicks, monotoneSegments, niceScale } from "../shared/chart.ts";

describe("a chart's axis", () => {
  test("ends on a round number at or above the data", () => {
    assert.deepEqual(niceScale(90), { top: 100, ticks: [0, 50, 100] });
    for (const max of [1, 2, 3, 7, 19, 90, 101, 999, 1234, 56_000, 3_400_000]) {
      const { top, ticks } = niceScale(max);
      assert.ok(top >= max, `${max} fits under ${top}`);
      assert.equal(ticks[0], 0);
      assert.equal(ticks.at(-1), top);
      assert.ok(ticks.length <= 6, `${max} has a quiet grid`);
    }
  });

  test("counts in whole numbers", () => {
    for (const max of [1, 2, 3, 5, 7, 11]) assert.ok(niceScale(max).ticks.every(Number.isInteger), String(max));
  });

  test("nothing to show still has an axis", () => {
    assert.deepEqual(niceScale(0), { top: 1, ticks: [0, 1] });
    assert.deepEqual(niceScale(Number.NaN), { top: 1, ticks: [0, 1] });
  });
});

describe("a chart's line", () => {
  const controls = (segment: string) => segment.slice(2).split(" ").map(Number);

  test("has one piece for each gap, ending on each point", () => {
    const points = [[0, 10], [10, 40], [20, 25]] as const;
    const segments = monotoneSegments(points);
    assert.equal(segments.length, 2);
    assert.deepEqual(controls(segments[0]!).slice(4), [10, 40]);
    assert.deepEqual(controls(segments[1]!).slice(4), [20, 25]);
  });

  test("never draws higher or lower than the data", () => {
    const ys = [100, 3, 90, 91, 0, 0, 500, 2, 2, 480];
    const points = ys.map((y, i) => [i * 10, y] as const);
    monotoneSegments(points).forEach((segment, i) => {
      const [, y1, , y2] = controls(segment);
      const low = Math.min(ys[i]!, ys[i + 1]!);
      const high = Math.max(ys[i]!, ys[i + 1]!);
      for (const y of [y1!, y2!]) assert.ok(y >= low - 0.01 && y <= high + 0.01, `gap ${i}: ${y} is within ${low}..${high}`);
    });
  });

  test("a single point has no line", () => {
    assert.deepEqual(monotoneSegments([[0, 1]]), []);
  });
});

describe("a chart's dates", () => {
  test("first and last are always labelled, and the rest spread out", () => {
    assert.deepEqual(axisPicks(30), [0, 7, 15, 22, 29]);
    assert.deepEqual(axisPicks(24), [0, 6, 12, 17, 23]);
  });

  test("a short chart labels everything", () => {
    assert.deepEqual(axisPicks(3), [0, 1, 2]);
    assert.deepEqual(axisPicks(7), [0, 1, 2, 3, 4, 5, 6]);
    assert.deepEqual(axisPicks(0), []);
  });
});
