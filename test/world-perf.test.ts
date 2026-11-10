import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { addToTally, cleanGpuName, newTally, parseWorldPerf, tallyAt, tallyOver, worldPerfLines } from "../shared/world-perf.ts";
import type { WorldPerf } from "../shared/world-perf.ts";
import { diagnostics, recordWorldPerf } from "../server/diagnostics.ts";
import { openDb } from "../server/db.ts";

const report: WorldPerf = {
  visits: 2,
  minutes: 12,
  frames: 21_000,
  typicalMs: 33,
  slow95Ms: 41,
  slow99Ms: 70,
  worstMs: 512,
  overHalfSecond: 1,
  over50MsPercent: 3,
  drawTypicalMs: 4,
  drawSlow95Ms: 9,
  firstFrameMs: 1800,
  detail: 1,
  lowestDetail: 2,
  lostGraphics: 0,
  drawCalls: 310,
  triangles: 480_000,
  pixelRatio: 1.5,
  megapixels: 3,
  gpu: "ANGLE (Intel UHD Graphics)",
};

describe("how the World ran, for a bug report", () => {
  test("frame times: the share under a time, and how many over one", () => {
    const tally = newTally();
    for (let i = 0; i < 95; i++) addToTally(tally, 33);
    for (let i = 0; i < 4; i++) addToTally(tally, 80);
    addToTally(tally, 9000);
    assert.equal(tallyAt(tally, 0.5), 33);
    assert.equal(tallyAt(tally, 0.95), 33);
    assert.equal(tallyAt(tally, 0.99), 80);
    assert.equal(tally.worst, 2000, "held at the longest it counts");
    assert.equal(tallyOver(tally, 50), 5);
    assert.equal(tallyAt(newTally(), 0.5), 0);
  });

  test("the graphics card's name loses its device number and anything a name wouldn't have", () => {
    assert.equal(cleanGpuName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)"), "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)");
    assert.equal(cleanGpuName("<script>me@example.org</script>"), "scriptmeexample.org/script");
    assert.equal(cleanGpuName(null), "unknown");
    assert.equal(cleanGpuName("x".repeat(500)).length, 120);
  });

  test("what the page sends is checked: only these numbers, in range, and nothing extra gets through", () => {
    assert.deepEqual(parseWorldPerf(report), report);
    assert.equal(parseWorldPerf(null), null);
    assert.equal(parseWorldPerf({ ...report, frames: -1 }), null);
    assert.equal(parseWorldPerf({ ...report, typicalMs: Number.NaN }), null);
    assert.equal(parseWorldPerf({ ...report, worstMs: "33" }), null);
    assert.equal(parseWorldPerf({ ...report, over50MsPercent: 101 }), null);
    const { frames: _left, ...missing } = report;
    assert.equal(parseWorldPerf(missing), null);
    const extra = parseWorldPerf({ ...report, appName: "Acme Billing", url: "https://acme.example.org" })!;
    assert.deepEqual(Object.keys(extra).sort(), Object.keys(report).sort());
    assert.doesNotMatch(worldPerfLines(extra).join("\n"), /Acme|example\.org/);
  });

  test("the report says so when the World hasn't been opened, and what it knows when it has", () => {
    const db = openDb(":memory:");
    recordWorldPerf(null);
    assert.match(diagnostics(db), /World: not opened since Periskopos started/);
    recordWorldPerf(report);
    const text = diagnostics(db);
    assert.match(text, /World: 2 visits · 21,000 frames over 12 min · first picture in 1,800 ms/);
    assert.match(text, /typical 33 ms · 95% under 41 ms · 99% under 70 ms · worst 512 ms · 3% over 50 ms · 1 over 500 ms/);
    assert.match(text, /level 1 now, 2 at its lowest/);
    assert.match(text, /310 draw calls · 480,000 triangles · 3 MP · pixel ratio 1\.5/);
    assert.match(text, /Graphics: ANGLE \(Intel UHD Graphics\)/);
    recordWorldPerf(null);
  });
});
