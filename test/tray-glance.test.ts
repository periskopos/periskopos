import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";
import type { AppStatus, DeployState, Incident } from "../shared/types.ts";
import {
  DOTS,
  STATE_RANK,
  TEXT_MARKER,
  appRoute,
  buildGlance,
  dotIconFile,
  dotSvg,
  glanceKey,
  lineDetail,
  menuText,
  trayIconSvg,
  trayVariant,
  unreachableGlance,
} from "../desktop/tray-glance.ts";
import { STATE_RANK as PAGE_RANK } from "../web/src/format.ts";

const status = (slug: string, state: AppStatus["state"], extra: Partial<AppStatus> = {}): AppStatus => ({ slug, state, checks: {}, ...extra });
const incident = (reason: string, kind: Incident["kind"] = "ci"): Incident => ({ id: "i", appId: "a", kind, startedAt: "2026-10-17T10:00:00Z", reason });
const commit = (sha: string) => ({ sha, message: "m", at: "2026-10-17T10:00:00Z" });
const deploy = (state: DeployState["state"]): DeployState => ({ state, latest: commit("abc1234def"), live: commit("0000000aaa") });

describe("the tray's glance", () => {
  test("problems first, in the Apps page's own order, then by name", () => {
    assert.deepEqual(STATE_RANK, PAGE_RANK);
    const apps = ["Zed", "Alpha", "Mid", "Beta", "Gamma", "New"].map((name) => ({ slug: name.toLowerCase(), name }));
    const g = buildGlance(apps, [
      status("zed", "up"),
      status("alpha", "prelaunch"),
      status("mid", "attention"),
      status("beta", "down"),
      status("gamma", "unknown"),
      // "new" has no status yet: checking, between unknown and up
    ]);
    assert.deepEqual(
      g.lines.map((l) => l.label),
      ["Beta — Down", "Mid — Needs attention", "Gamma — Unknown", "New — Checking…", "Zed — Up", "Alpha — Not live yet"],
    );
    assert.deepEqual(
      g.lines.map((l) => l.dot),
      ["down", "attention", "unknown", "unknown", "up", "prelaunch"],
    );
    assert.equal(g.headline.label, "1 down · 1 needs attention · 1 unknown");
    assert.equal(g.headline.dot, "down");
  });

  test("each line says the newest problem, else a deploy worth knowing, else the state", () => {
    assert.deepEqual(lineDetail(status("e", "attention", { incident: incident("CI failing on main") })), { text: "CI failing on main", dot: "attention" });
    assert.deepEqual(lineDetail(status("e", "down", { incident: incident("No answer (timeout)", "outage"), deploy: deploy("deploying") })), {
      text: "No answer (timeout)",
      dot: "down",
    });
    assert.deepEqual(lineDetail(status("e", "up", { deploy: deploy("deploying") })), { text: "Deploying abc1234", dot: "info" });
    assert.deepEqual(lineDetail(status("e", "up", { deploy: deploy("not-deployed") })), { text: "Not live: abc1234", dot: "attention" });
    assert.deepEqual(lineDetail(status("e", "up", { deploy: { state: "deploying" } })), { text: "Deploying", dot: "info" });
    assert.deepEqual(lineDetail(status("e", "up", { deploy: deploy("live") })), { text: "Up", dot: "up" });
    const refused = { state: "down" as const, at: "2026-10-17T10:00:00Z", detail: "Connection refused" };
    assert.deepEqual(lineDetail(status("e", "down", { checks: { site: refused } })), { text: "Connection refused", dot: "down" });
    // Two checks failing: the one that failed last speaks.
    const older = { state: "down" as const, at: "2026-10-17T09:00:00Z", detail: "Old failure" };
    assert.deepEqual(lineDetail(status("e", "down", { checks: { a: older, b: refused, c: older } })), { text: "Connection refused", dot: "down" });
    // Down outranks a deploy under way; a push not live on an app not live yet keeps its quiet dot.
    assert.deepEqual(lineDetail(status("e", "down", { deploy: deploy("deploying") })), { text: "Down", dot: "down" });
    assert.deepEqual(lineDetail(status("e", "prelaunch", { deploy: deploy("not-deployed") })), { text: "Not live: abc1234", dot: "prelaunch" });
    assert.deepEqual(lineDetail(status("e", "none")), { text: "No checks", dot: "none" });
    assert.deepEqual(lineDetail(undefined), { text: "Checking…", dot: "unknown" });
  });

  test("a long or multi-line reason is cut to one short line", () => {
    const { text } = lineDetail(status("e", "attention", { incident: incident(`Build failed:\n${"x".repeat(200)}`) }));
    assert.ok(!text.includes("\n"));
    assert.ok(text.length <= 60);
    assert.ok(text.endsWith("…"));
  });

  test("lines open the app's page, and an app the list hasn't named shows by its slug", () => {
    const g = buildGlance([{ slug: "star-map", name: "Star-Map" }], [status("star-map", "up"), status("moon-base", "up")]);
    assert.deepEqual(
      g.lines.map((l) => [l.label, l.route]),
      [
        ["moon-base — Up", "#/apps/moon-base"],
        ["Star-Map — Up", "#/apps/star-map"],
      ],
    );
    assert.equal(g.headline.label, "All normal");
    assert.equal(appRoute("a b"), "#/apps/a%20b");
  });

  test("ten apps at most, then 'and N more…' opening the Apps page", () => {
    const statuses = Array.from({ length: 13 }, (_, i) => status(`app-${String(i).padStart(2, "0")}`, i === 12 ? "down" : "up"));
    const g = buildGlance([], statuses);
    assert.equal(g.lines.length, 10);
    assert.equal(g.lines[0].route, "#/apps/app-12"); // the problem is never the one cut
    assert.deepEqual(g.more, { label: "and 3 more…", route: "#/" });
    assert.equal(buildGlance([], statuses.slice(0, 10)).more, undefined);
  });

  test("the same apps make the same menu, so a quiet refresh doesn't rebuild it", () => {
    const apps = [{ slug: "a", name: "A" }];
    assert.equal(glanceKey(buildGlance(apps, [status("a", "up")])), glanceKey(buildGlance(apps, [status("a", "up", { uptime30d: 99 })])));
    assert.notEqual(glanceKey(buildGlance(apps, [status("a", "up")])), glanceKey(buildGlance(apps, [status("a", "down")])));
  });

  test("an & in a name shows on Windows instead of becoming a shortcut", () => {
    assert.equal(menuText("Salt & Pepper", "win32"), "Salt && Pepper");
    assert.equal(menuText("Salt & Pepper", "darwin"), "Salt & Pepper");
  });

  test("every state has a dot for light and dark menus, and a distinct text marker", () => {
    for (const dot of DOTS) for (const tone of ["dark", "light"] as const) assert.match(dotSvg(dot, tone), /^<svg [^>]+>.+<\/svg>$/);
    assert.equal(new Set(Object.values(TEXT_MARKER)).size, DOTS.length);
    assert.equal(path.basename(dotIconFile("/m", "down", false)), "dot-down-dark.png");
    assert.equal(path.basename(dotIconFile("/m", "down", true)), "dot-down-light.png");
  });
});

describe("the tray icon", () => {
  test("red when any app is down, amber when one needs attention, else plain", () => {
    assert.equal(trayVariant([status("a", "up"), status("b", "attention"), status("c", "down")]), "down");
    assert.equal(trayVariant([status("a", "up"), status("b", "attention")]), "attention");
    assert.equal(trayVariant([status("a", "up"), status("b", "stale")]), "stale", "no recent data never wears the green lamp");
    assert.equal(trayVariant([status("a", "stale"), status("b", "attention")]), "attention");
    assert.equal(trayVariant([status("a", "up"), status("b", "unknown"), status("c", "prelaunch")]), "unknown", "not known never wears the green lamp either");
    assert.equal(trayVariant([status("a", "up"), status("c", "prelaunch")]), "normal");
    assert.equal(trayVariant([]), "normal");
  });

  test("a server that isn't answering: it says so, and lists no app as if it knew", () => {
    assert.deepEqual(unreachableGlance(), { headline: { label: "Can't read your apps' status", dot: "unknown" }, lines: [] });
  });

  test("a variant is the mark with its status lamp laid over in the state's colour", () => {
    const base = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512"/></svg>';
    const down = trayIconSvg(base, "down");
    assert.ok(down.startsWith(base.slice(0, -"</svg>".length)));
    assert.ok(down.endsWith("</svg>"));
    assert.match(down, /<circle cx="349" cy="163" [^>]*fill="#ff6b61"/);
    assert.match(trayIconSvg(base, "attention"), /fill="#f0883e"/);
    assert.throws(() => trayIconSvg("not an svg", "down"));
  });
});
