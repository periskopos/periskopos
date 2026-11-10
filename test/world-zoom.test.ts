import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { glide, wheelZoom } from "../web/src/views/world/scene/zoomFeel.ts";

describe("zooming the map", () => {
  const PIXELS = 0;

  test("counts how far the wheel went, not how many events said so", () => {
    let flick = 1;
    for (let i = 0; i < 25; i++) flick *= wheelZoom(-4, PIXELS, false);
    assert.ok(Math.abs(flick - wheelZoom(-100, PIXELS, false)) < 0.001, "25 small events are one notch");
    assert.ok(flick < 1.1, "a notch is a small step");
  });

  test("goes in and out by the same step, and never far at once", () => {
    assert.ok(Math.abs(wheelZoom(-100, PIXELS, false) * wheelZoom(100, PIXELS, false) - 1) < 1e-9);
    assert.ok(wheelZoom(-5000, PIXELS, false) <= 1.25);
    assert.ok(wheelZoom(5000, PIXELS, false) >= 0.8);
    assert.ok(wheelZoom(-3, 1, false) > wheelZoom(-3, PIXELS, false), "a wheel that counts in lines");
    assert.ok(wheelZoom(-5, PIXELS, true) > wheelZoom(-5, PIXELS, false), "a pinch reports smaller numbers");
  });

  const run = (frameMs: number, untilMs: number) => {
    let state = { at: 0, speed: 0 };
    const seen: number[] = [];
    for (let t = frameMs; t <= untilMs; t += frameMs) {
      state = glide(state.at, 1, state.speed, frameMs);
      seen.push(state.at);
    }
    return seen;
  };

  test("starts gently, gathers speed, and arrives without overshooting", () => {
    const seen = run(1000 / 60, 3000);
    const steps = seen.map((at, i) => at - (seen[i - 1] ?? 0));
    assert.ok(seen[0]! < 0.02, `a jump on the first frame: ${seen[0]}`);
    assert.ok(steps[3]! > steps[0]!, "it should gather speed");
    assert.ok(seen.every((at) => at <= 1.0000001), "overshot");
    assert.ok(Math.abs(seen.at(-1)! - 1) < 0.001, "never arrived");
  });

  test("takes about the same time at any frame rate", () => {
    for (const fps of [30, 60, 72, 144]) {
      const half = (run(1000 / fps, 2000).findIndex((at) => at >= 0.5) + 1) * (1000 / fps);
      assert.ok(half > 180 && half < 290, `${fps} fps took ${half} ms to get halfway`);
    }
  });

  test("carries on smoothly if the goal moves on the way", () => {
    let state = { at: 0, speed: 0 };
    for (let i = 0; i < 10; i++) state = glide(state.at, 1, state.speed, 1000 / 60);
    const before = state.speed;
    state = glide(state.at, 2, state.speed, 1000 / 60);
    assert.ok(state.speed >= before, "it should never stall when another notch comes in");
    assert.ok(state.speed < before * 1.5, "or lurch");
  });
});
