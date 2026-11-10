import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WatcherLog } from "../shared/types.ts";
import { overallLine } from "../shared/world.ts";
import { briefFigures, figuresCalm, hudParts } from "../web/src/views/world/hudRoom.ts";
import { lastCheckSaid } from "../web/src/views/world/looks.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");

describe("what's on screen round the map", () => {
  const parts = (appCount: number | undefined, picture = true, replaying = false) => hudParts({ appCount, picture, replaying });

  test("the apps not read: nothing that needs them", () => {
    assert.deepEqual(parts(undefined), { controls: false, legend: false, key: false, walks: false });
  });

  test("no map: no buttons to move it and no key to it", () => {
    assert.deepEqual(parts(5, false), { controls: false, legend: false, key: false, walks: false });
  });

  test("no apps: the map, but nothing to tour, replay or key", () => {
    assert.deepEqual(parts(0), { controls: true, legend: true, key: false, walks: false });
  });

  test("in a replay, the tour and the replay button step aside", () => {
    assert.deepEqual(parts(5, true, true), { controls: true, legend: true, key: true, walks: false });
    assert.deepEqual(parts(5), { controls: true, legend: true, key: true, walks: true });
  });
});

describe("the watcher's figure", () => {
  type Said = Parameters<typeof lastCheckSaid>[0];
  const world = (watching = true, stopped = false) => ({ plots: [{ slug: "a" }], watching, stopped, failed: false }) as unknown as Said["world"];
  const row = (agoMs: number, slug = "a"): WatcherLog["checks"][number] => ({ at: new Date(NOW - agoMs).toISOString(), state: "up", slug, app: slug, what: "Site" });
  const said = (over: Partial<Said>) => lastCheckSaid({ world: world(), checks: [], read: true, off: false, now: NOW, ...over });

  test("before the log is read it doesn't say none", () => {
    assert.deepEqual(said({ read: false, checks: [row(1000)] }), { value: "Not read" });
  });

  test("says when, and how many lately", () => {
    assert.deepEqual(said({ checks: [row(1000), row(30_000), row(10 * 60_000)] }), { value: "Just now", note: "2 in 2 min" });
  });

  test("the newest counts, whichever order the log is in", () => {
    assert.equal(said({ checks: [row(10 * 60_000), row(3 * 60_000)] }).value, "3 min ago");
  });

  test("older than the window, no count of none", () => {
    assert.deepEqual(said({ checks: [row(10 * 60_000)] }), { value: "10 min ago", note: "by the watcher" });
  });

  test("an app that's gone from the map isn't what it last looked at", () => {
    assert.equal(said({ checks: [row(1000, "gone"), row(5 * 60_000)] }).value, "5 min ago");
  });

  test("stopped says so, with when it last looked", () => {
    assert.deepEqual(said({ world: world(false, true), checks: [row(12 * 60_000)] }), { value: "Not checking", note: "last 12 min ago" });
    assert.deepEqual(said({ world: world(false, true) }), { value: "Not checking" });
  });

  test("turned off, and nothing yet", () => {
    assert.deepEqual(said({ off: true }), { value: "Turned off", note: "in Settings" });
    assert.deepEqual(said({}), { value: "None yet", note: "by the watcher" });
  });
});

describe("a title with a lot to say", () => {
  const line = (text: string) => overallLine({ state: "down", text }, [], NOW).text;

  test("up to two things, as they are", () => {
    assert.equal(line("1 down"), "1 down");
    assert.equal(line("1 down · 2 unknown"), "1 down · 2 unknown");
  });

  test("more than that: the worst, and how many more", () => {
    assert.equal(line("1 down · 1 needs attention · 2 unknown"), "1 down · 3 more need a look");
    assert.equal(line("2 needs attention · 1 unknown · 1 with no recent data"), "2 needs attention · 2 more need a look");
  });
});

describe("the figures, calm and brief", () => {
  const stats = (over: Partial<{ running: number; total: number; notRunning: { state: string }[]; deploying: unknown[] }> = {}) => ({ running: 5, total: 5, notRunning: [], deploying: [], ...over });

  test("step back only when all's well", () => {
    assert.equal(figuresCalm(stats(), "up"), true);
    assert.equal(figuresCalm(stats({ running: 4, notRunning: [{ state: "prelaunch" }] }), "up"), true, "not live yet is on purpose");
    assert.equal(figuresCalm(stats(), "attention"), false, "a service in trouble isn't calm");
    assert.equal(figuresCalm(stats({ deploying: [{}] }), "up"), false);
    assert.equal(figuresCalm(stats({ running: 4, notRunning: [{ state: "stale" }] }), "up"), false);
  });

  test("in a line: running, deploying, and the last check or why there isn't one", () => {
    assert.equal(briefFigures(stats({ running: 4 }), { value: "3 min ago" }), "4 of 5 running · last check 3 min ago");
    assert.equal(briefFigures(stats({ deploying: [{}] }), { value: "Just now" }), "5 of 5 running · 1 deploying · last check just now");
    assert.equal(briefFigures(stats(), { value: "Turned off" }), "5 of 5 running · checks: turned off");
  });
});
