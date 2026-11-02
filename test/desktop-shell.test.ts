import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import vm from "node:vm";
import type { AppStatus } from "../shared/types.ts";
import { preloadSource } from "../desktop/build/build-preload.ts";
import { MAX_LOG_BYTES, logFileName, logsToPrune, openDaemonLog } from "../desktop/daemon-log.ts";
import { PROTOCOL, findDeepLinkInArgv, isSafeRoute, parseDeepLink } from "../desktop/deep-link.ts";
import { attentionCount, badgeText } from "../desktop/fleet-tooltip.ts";
import { iconCandidates, pickIcon } from "../desktop/icon-file.ts";
import { ALL_CHANNELS } from "../desktop/ipc-channels.ts";
import { buildMenuTemplate } from "../desktop/menu-template.ts";
import type { MenuCommand } from "../desktop/menu-template.ts";
import { DARK_CHROME_COLORS, LIGHT_CHROME_COLORS, isHexColor, readChromeColors, writeChromeColors } from "../desktop/shell-chrome.ts";
import { splashHtml } from "../desktop/splash-html.ts";
import { tempDir } from "./tmp.ts";

const tmp = () => tempDir("periskopos-shell-");

describe("the bridge to the page (preload)", () => {
  test("it builds into valid CommonJS with no TypeScript left in it", () => {
    const source = preloadSource();
    assert.doesNotThrow(() => new vm.Script(source, { filename: "preload.cjs" }));
    assert.ok(!/^\s*import\s/m.test(source), "a sandboxed preload can't use import");
    assert.ok(!/\bas typeof import\(/.test(source) && !/:\s*(string|boolean|Colors)\b/.test(source), "types must be stripped");
  });

  test("the preload and the shell speak the same channels, and only those", () => {
    const used = new Set([...preloadSource().matchAll(/"(periskopos:[a-z-]+)"/g)].map((m) => m[1]));
    for (const channel of used) assert.ok((ALL_CHANNELS as readonly string[]).includes(channel), `${channel} isn't in ipc-channels.ts`);
    // Every command the page can send is one the shell listens for.
    const toPage = ["periskopos:navigate", "periskopos:window-maximized-state", "periskopos:update-state"];
    const fromPage = ALL_CHANNELS.filter((c) => !toPage.includes(c));
    for (const channel of fromPage) assert.ok(used.has(channel), `${channel} has no preload entry`);
  });

  test("the preload exposes the bridge under the one name the page looks for", () => {
    const exposed: Record<string, unknown>[] = [];
    const sandbox = {
      require: () => ({ contextBridge: { exposeInMainWorld: (name: string, api: Record<string, unknown>) => exposed.push({ name, ...api }) }, ipcRenderer: {} }),
      process: { platform: "win32" },
    };
    vm.runInNewContext(preloadSource(), sandbox);
    assert.equal(exposed.length, 1);
    assert.equal(exposed[0].name, "periskoposShell");
    for (const fn of ["onNavigate", "setChromeColors", "openLogs", "openBackups", "minimizeWindow", "toggleMaximizeWindow", "closeWindow", "getMaximized", "onMaximizedChange"]) {
      assert.equal(typeof exposed[0][fn], "function", fn);
    }
  });
});

describe("remembered colours", () => {
  test("defaults follow the OS theme, and only plain hex colours are accepted", () => {
    const dir = tmp();
    assert.deepEqual(readChromeColors(dir, true), DARK_CHROME_COLORS);
    assert.deepEqual(readChromeColors(dir, false), LIGHT_CHROME_COLORS);
    assert.equal(isHexColor("#0b0d10"), true);
    assert.equal(isHexColor("#fff"), true);
    assert.equal(isHexColor("red"), false);
    assert.equal(isHexColor("rgb(0,0,0)"), false);
    assert.equal(isHexColor("#12345"), false);
    assert.equal(isHexColor(5), false);
  });

  test("what the page reports comes back next launch; a bad report is refused", () => {
    const dir = tmp();
    const colors = { background: "#101010", foreground: "#eeeeee", accent: "#3fb950" };
    assert.equal(writeChromeColors(dir, colors), true);
    assert.deepEqual(readChromeColors(dir, false), colors);
    assert.equal(writeChromeColors(dir, { ...colors, accent: "url(javascript:alert(1))" }), false);
    assert.equal(writeChromeColors(dir, null), false);
    assert.deepEqual(readChromeColors(dir, false), colors, "the refused report changed nothing");
  });

  test("a corrupt or partial file degrades field by field", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "shell-chrome.json"), "{ nope");
    assert.deepEqual(readChromeColors(dir, true), DARK_CHROME_COLORS);
    writeFileSync(path.join(dir, "shell-chrome.json"), JSON.stringify({ background: "#222222", foreground: 7 }));
    assert.deepEqual(readChromeColors(dir, true), { background: "#222222", foreground: DARK_CHROME_COLORS.foreground, accent: DARK_CHROME_COLORS.accent });
  });

  test("the splash is painted in those colours and carries no script", () => {
    const html = splashHtml({ background: "#123456", foreground: "#fedcba", accent: "#00ff00" });
    for (const c of ["#123456", "#fedcba", "#00ff00"]) assert.ok(html.includes(c));
    assert.ok(html.includes("Periskopos"));
    assert.ok(!/<script/i.test(html));
  });
});

describe("periskopos:// links", () => {
  test("known routes become page routes", () => {
    assert.equal(parseDeepLink("periskopos://fleet"), "#/");
    assert.equal(parseDeepLink("periskopos://apps"), "#/", "the page's new name works too");
    assert.equal(parseDeepLink("periskopos://services"), "#/services");
    assert.equal(parseDeepLink("periskopos://status"), "#/status");
    assert.equal(parseDeepLink("periskopos://apps/star-map/deploys"), "#/apps/star-map/deploys");
    assert.equal(parseDeepLink("periskopos://apps/star-map/settings/connections"), "#/apps/star-map/settings/connections");
    assert.equal(parseDeepLink("periskopos://apps/star-map/settings/nonsense"), undefined);
    assert.equal(parseDeepLink("periskopos://apps/star-map/history/connections"), undefined);
    assert.equal(parseDeepLink("periskopos://settings"), "#/settings");
    assert.equal(parseDeepLink("periskopos://settings/data"), "#/settings/data");
    assert.equal(parseDeepLink("periskopos://settings/../apps"), undefined);
    assert.equal(parseDeepLink("periskopos://settings/anything"), undefined);
    assert.equal(parseDeepLink("periskopos://apps/star-map"), "#/apps/star-map");
    assert.equal(parseDeepLink("periskopos://apps/star-map/history"), "#/apps/star-map/history");
    assert.equal(parseDeepLink("periskopos://apps/star-map/settings"), "#/apps/star-map/settings");
  });

  test("anything else is refused, never passed through", () => {
    for (const bad of [
      "periskopos://apps/STAR_MAP",
      "periskopos://apps/star-map/delete",
      "periskopos://apps/star-map/history/extra",
      "periskopos://apps/%00",
      "periskopos://apps/%E0%A4%A",
      "periskopos://apps/" + "a".repeat(41),
      "periskopos://run/abc",
      "periskopos://services/new",
      "https://example.org",
      "javascript:alert(1)",
      "not a url",
    ]) {
      assert.equal(parseDeepLink(bad), undefined, bad);
    }
    assert.equal(PROTOCOL, "periskopos");
  });

  test("whatever comes out is always a safe route (the URL parser normalizes dot segments)", () => {
    for (const odd of ["periskopos://apps/../../etc", "periskopos://apps/a/./history", "periskopos://apps//star-map", "periskopos://APPS/star-map", "periskopos://apps/star-map?x=1#y"]) {
      const route = parseDeepLink(odd);
      if (route !== undefined) assert.ok(isSafeRoute(route), `${odd} gave ${route}`);
    }
    // Not all refused: the normalized ones still lead somewhere, and only there.
    assert.equal(parseDeepLink("periskopos://apps/a/./history"), "#/apps/a/history");
    assert.equal(parseDeepLink("periskopos://apps/star-map?x=1#y"), "#/apps/star-map", "the query and fragment are dropped");
  });

  test("a launch's arguments are scanned for one, and only safe routes reach the page", () => {
    assert.equal(findDeepLinkInArgv(["periskopos.exe", "--hidden", "periskopos://apps/moon-base"]), "#/apps/moon-base");
    assert.equal(findDeepLinkInArgv(["periskopos.exe", "periskopos://bogus"]), undefined);
    assert.equal(findDeepLinkInArgv(["periskopos.exe"]), undefined);
    assert.equal(isSafeRoute("#/apps/star-map"), true);
    assert.equal(isSafeRoute("#/"), true);
    assert.equal(isSafeRoute("https://evil.example"), false);
    assert.equal(isSafeRoute("#//evil.example"), false);
    assert.equal(isSafeRoute("javascript:alert(1)"), false);
    assert.equal(isSafeRoute("#/apps/<script>"), false);
  });
});

describe("the application menu", () => {
  const labels = (platform: NodeJS.Platform, isPackaged: boolean) => {
    const ran: MenuCommand[] = [];
    const template = buildMenuTemplate({ isPackaged, platform }, (c) => ran.push(c));
    const flat = (items: typeof template): typeof template => items.flatMap((i) => [i, ...(Array.isArray(i.submenu) ? flat(i.submenu) : [])]);
    return { all: flat(template), ran, template };
  };

  test("its own actions are wired, and Help points at this project", () => {
    const { all, ran } = labels("win32", true);
    for (const label of ["About Periskopos", "Show log", "Open data folder", "Periskopos README", "Report an issue"]) {
      const item = all.find((i) => i.label === label);
      assert.ok(item, label);
      (item.click as () => void)();
    }
    assert.deepEqual(ran, ["about", "show-logs", "open-data", "open-docs", "report-issue"]);
    assert.ok(!JSON.stringify(all).includes("electronjs.org"));
  });

  test("Check for updates: installed app only", () => {
    const { all, ran } = labels("win32", true);
    const item = all.find((i) => i.label === "Check for updates…");
    assert.ok(item);
    (item.click as () => void)();
    assert.deepEqual(ran, ["check-updates"]);
    assert.ok(!labels("win32", false).all.some((i) => i.label === "Check for updates…"));
  });

  test("DevTools only outside an installed app; Mac gets its app menu", () => {
    assert.ok(labels("win32", false).all.some((i) => i.role === "toggleDevTools"));
    assert.ok(!labels("win32", true).all.some((i) => i.role === "toggleDevTools"));
    assert.equal(labels("darwin", true).template[0].label, "Periskopos");
    assert.ok(labels("darwin", true).all.some((i) => i.role === "hideOthers"));
    assert.ok(!labels("win32", true).all.some((i) => i.role === "hideOthers"));
  });
});

describe("the log", () => {
  test("file names are dated; only our own old days are pruned, newest kept", () => {
    assert.equal(logFileName(new Date(2026, 9, 7)), "periskopos-2026-10-07.log");
    const names = [
      "periskopos-2026-10-01.log",
      "periskopos-2026-10-01.log.1",
      "periskopos-2026-10-02.log",
      "periskopos-2026-10-03.log",
      "periskopos-2026-10-04.log",
      "periskopos-2026-10-05.log",
      "periskopos-2026-10-06.log",
      "periskopos-2026-10-07.log",
      "my-notes.txt",
    ];
    assert.deepEqual(logsToPrune(names, 5).sort(), ["periskopos-2026-10-01.log", "periskopos-2026-10-01.log.1", "periskopos-2026-10-02.log"]);
    assert.deepEqual(logsToPrune(["my-notes.txt"], 0), []);
  });

  test("writes append, survive reopening, and rotate past the size limit", () => {
    const dir = tmp();
    const now = new Date(2026, 9, 7);
    const first = openDaemonLog(dir, now, 50);
    first.write("hello\n");
    first.close();
    const again = openDaemonLog(dir, now, 50);
    again.write("world\n");
    again.write("x".repeat(60) + "\n"); // passes 50 bytes
    again.write("after\n"); // the next write rotates first
    again.close();
    assert.equal(readFileSync(path.join(dir, "periskopos-2026-10-07.log.1"), "utf8").startsWith("hello\nworld\n"), true);
    assert.equal(readFileSync(path.join(dir, "periskopos-2026-10-07.log"), "utf8"), "after\n");
    assert.ok(MAX_LOG_BYTES > 1024 * 1024);
    assert.deepEqual(readdirSync(dir).length, 2);
  });
});

describe("icons and the dock badge", () => {
  test("Windows windows prefer the .ico; trays and notifications the .png", () => {
    assert.deepEqual(iconCandidates("/r", "window", "win32").map((f) => path.basename(f)), ["icon.ico", "icon.png"]);
    assert.deepEqual(iconCandidates("/r", "window", "darwin").map((f) => path.basename(f)), ["icon.png", "icon.ico"]);
    assert.deepEqual(iconCandidates("/r", "tray", "win32").map((f) => path.basename(f)), ["icon.png", "icon.ico"]);
    assert.equal(pickIcon(["/a", "/b"], (f) => f === "/b"), "/b");
    assert.equal(pickIcon(["/a"], () => false), undefined);
  });

  test("the badge counts the apps that need me, and stays legible", () => {
    const s = (state: AppStatus["state"], i: number): AppStatus => ({ slug: `a${i}`, state, checks: {} });
    assert.equal(attentionCount([s("up", 0), s("down", 1), s("attention", 2), s("prelaunch", 3), s("unknown", 4)]), 2);
    assert.equal(badgeText(0), "");
    assert.equal(badgeText(3), "3");
    assert.equal(badgeText(99), "99");
    assert.equal(badgeText(100), "99+");
    assert.equal(badgeText(250), "99+");
  });
});
