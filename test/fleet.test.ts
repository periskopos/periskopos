import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AppState, AppStatus, ProviderStatus } from "../shared/types.ts";
import { lastPushHint, providersRead, summarize } from "../shared/fleet.ts";

const apps = (...states: AppState[]): AppStatus[] => states.map((state, i) => ({ slug: `a${i}`, state, checks: {} }));

describe("whether providers can be called fine", () => {
  const NOW = Date.parse("2026-11-04T12:00:00Z");
  const provider = (over: Partial<ProviderStatus>) => ({ relevantIndicator: "none", checkedAt: new Date(NOW - 60_000).toISOString(), apps: [{ slug: "a", name: "A" }], ...over }) as ProviderStatus;

  test("only when every page my apps depend on was read lately and understood", () => {
    assert.equal(providersRead([provider({})], NOW), true);
    assert.equal(providersRead([provider({ relevantIndicator: "unknown" })], NOW), false);
    assert.equal(providersRead([provider({ checkedAt: new Date(NOW - 3 * 60 * 60_000).toISOString() })], NOW), false, "read hours ago");
    assert.equal(providersRead([provider({ checkedAt: undefined })], NOW), false, "never read");
    assert.equal(providersRead([provider({ relevantIndicator: "unknown", apps: [] })], NOW), true, "no app depends on it");
  });
});

describe("the fleet's headline (what the top-bar pill says)", () => {
  test("no apps", () => {
    assert.deepEqual(summarize([]), { state: "none", text: "No apps" });
  });

  test("all normal only when every app is up", () => {
    assert.deepEqual(summarize(apps("up", "up")), { state: "up", text: "All normal" });
    // An app with nothing to check (only links) isn't a problem, but "all normal" doesn't speak for it.
    assert.deepEqual(summarize(apps("up", "none")), { state: "up", text: "All normal · 1 with no checks" });
    assert.deepEqual(summarize(apps("none")), { state: "none", text: "1 with no checks" });
  });

  test("an app whose state isn't known is counted, never waved through", () => {
    assert.deepEqual(summarize(apps("up", "unknown")), { state: "unknown", text: "1 unknown" });
  });

  test("an app with no recent data spoils 'all normal', and hides no problem", () => {
    assert.deepEqual(summarize(apps("up", "stale")), { state: "stale", text: "1 with no recent data" });
    assert.deepEqual(summarize(apps("down", "stale")), { state: "down", text: "1 down · 1 with no recent data" });
  });

  test("an app that isn't live yet is on purpose: it neither alarms nor spoils 'all normal'", () => {
    assert.deepEqual(summarize(apps("up", "prelaunch")), { state: "up", text: "All normal" });
    assert.deepEqual(summarize(apps("down", "prelaunch")), { state: "down", text: "1 down" });
    assert.deepEqual(summarize(apps("prelaunch")), { state: "none", text: "Nothing live yet" });
  });

  test("counts, worst first, each kind named", () => {
    assert.deepEqual(summarize(apps("up", "down", "down", "attention", "unknown")), { state: "down", text: "2 down · 1 needs attention · 1 unknown" });
    assert.deepEqual(summarize(apps("attention", "attention", "up")), { state: "attention", text: "2 need attention" });
  });
});

describe("what 'Last push' says when it can't be known", () => {
  test("names only what's missing", () => {
    assert.equal(lastPushHint(true, true), "checking…");
    assert.equal(lastPushHint(true, false), "connect your host to see what's live");
    assert.equal(lastPushHint(false, true), "connect GitHub to compare with your commits");
    assert.equal(lastPushHint(false, false), "connect GitHub and a host");
  });
});
