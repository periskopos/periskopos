import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { NotificationsView } from "../shared/types.ts";
import { AWAY_MS, parseLooked, RECORD_MS, sinceYouLooked } from "../web/src/views/world/sinceLooked.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const plots = [
  { slug: "comet", name: "Comet-Mail" },
  { slug: "nova", name: "Nova-Shop" },
];
const look = (msAgo: number, apps = ["comet", "nova"]) => ({ at: NOW - msAgo, apps });
const quiet: NotificationsView = { now: [], earlier: [] };
const said = (over: Partial<Parameters<typeof sinceYouLooked>[0]>) => sinceYouLooked({ looked: look(3 * HOUR), now: NOW, notifications: quiet, plots, ...over });

describe("since you last looked", () => {
  test("says nothing the first time, back within minutes, or with nothing read", () => {
    assert.equal(said({ looked: null }), null);
    assert.equal(said({ looked: look(AWAY_MS - 1) }), null);
    assert.equal(said({ notifications: undefined }), null);
  });

  test("a quiet stretch isn't called quiet: it says nothing", () => {
    assert.equal(said({}), null);
  });

  test("what went wrong and was put right, one row an app, with how long", () => {
    const out = said({
      notifications: {
        now: [],
        earlier: [
          { title: "Comet-Mail", text: "Timed out", href: "#/apps/comet", startedAt: iso(2 * HOUR), endedAt: iso(2 * HOUR - 12 * MIN) },
          { title: "Comet-Mail", text: "Timed out", href: "#/apps/comet", startedAt: iso(HOUR), endedAt: iso(HOUR - 3 * MIN) },
        ],
      },
    });
    assert.equal(out?.title, "Since you last looked, 3 h ago");
    assert.deepEqual(out?.rows, [{ slug: "comet", name: "Comet-Mail", text: "had 2 problems, 15 min in all, and recovered", state: "up" }]);
  });

  test("what went wrong while you were away and still is comes first", () => {
    const out = said({
      notifications: {
        now: [{ state: "down", title: "Nova-Shop", text: "HTTP 502", href: "#/apps/nova", since: iso(30 * MIN) }],
        earlier: [{ title: "Comet-Mail", text: "Slow", href: "#/apps/comet", startedAt: iso(2 * HOUR), endedAt: iso(HOUR) }],
      },
    });
    assert.deepEqual(out?.rows.map((r) => [r.name, r.state]), [["Nova-Shop", "down"], ["Comet-Mail", "up"]]);
    assert.match(out!.rows[0]!.text, /^went down 30 min ago: HTTP 502$/);
  });

  test("a problem older than the last look isn't news, and the watcher's own aren't the apps'", () => {
    const out = said({
      notifications: {
        now: [
          { state: "attention", title: "Comet-Mail", text: "Certificate", href: "#/apps/comet", since: iso(5 * HOUR) },
          { state: "attention", title: "Periskopos", text: "Checks stopped", href: "#/settings", since: iso(HOUR), watching: true },
        ],
        earlier: [],
      },
    });
    assert.equal(out, null);
  });

  test("put right, but wrong again now: said so", () => {
    const out = said({
      notifications: {
        now: [{ state: "attention", title: "Comet-Mail", text: "Certificate", href: "#/apps/comet", since: iso(5 * HOUR) }],
        earlier: [{ title: "Comet-Mail", text: "Timed out", href: "#/apps/comet", startedAt: iso(2 * HOUR), endedAt: iso(HOUR) }],
      },
    });
    assert.deepEqual(out?.rows[0], { slug: "comet", name: "Comet-Mail", text: "had a problem for 1 h, and has one now", state: "attention" });
  });

  test("a new problem and an earlier one on the same app make one row", () => {
    const out = said({
      notifications: {
        now: [{ state: "down", title: "Comet-Mail", text: "HTTP 500", href: "#/apps/comet", since: iso(10 * MIN) }],
        earlier: [{ title: "Comet-Mail", text: "Timed out", href: "#/apps/comet", startedAt: iso(2 * HOUR), endedAt: iso(HOUR) }],
      },
    });
    assert.equal(out?.rows.length, 1);
    assert.equal(out?.rows[0]?.text, "went down 10 min ago: HTTP 500 · before that it had a problem for 1 h, and recovered");
  });

  test("apps added since the last look", () => {
    const added = [...plots, { slug: "lander", name: "Lander" }];
    assert.deepEqual(said({ plots: added })?.rows, [{ slug: "lander", name: "Lander", text: "was added", state: "new" }]);
  });

  test("what was remembered may be anything: not a last look, then nothing", () => {
    assert.equal(parseLooked({ at: "x", apps: [] }), null);
    assert.equal(parseLooked({ at: 5, apps: [1] }), null);
    assert.deepEqual(parseLooked({ at: 5, apps: ["a"] }), { at: 5, apps: ["a"] });
  });

  test("away longer than the record keeps: says only the last day, and says so", () => {
    const out = said({
      looked: look(3 * RECORD_MS),
      notifications: { now: [], earlier: [{ title: "Comet-Mail", text: "x", href: "#/apps/comet", startedAt: iso(2 * HOUR), endedAt: iso(HOUR) }] },
    });
    assert.match(out!.title, /^Since you last looked, /);
    assert.equal(out?.rows[0]?.text, "had a problem for 1 h in the last day, and recovered");
  });

  test("a problem still open is news however long ago you looked", () => {
    const out = said({
      looked: look(6 * RECORD_MS),
      notifications: { now: [{ state: "attention", title: "Comet-Mail", text: "Certificate", href: "#/apps/comet", since: iso(5 * RECORD_MS) }], earlier: [] },
    });
    assert.match(out!.rows[0]!.text, /^started needing attention .*: Certificate$/);
  });

  test("three rows at most, and how many more", () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ slug: `x${i}`, name: `X${i}` }));
    const out = said({ plots: [...plots, ...many] });
    assert.equal(out?.rows.length, 3);
    assert.equal(out?.more, 2);
  });
});
