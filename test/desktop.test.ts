import assert from "node:assert/strict";
import { MENU_ICONS, menuIconDir, menuIconFile, menuIconSvg } from "../desktop/menu-icons.ts";
import { APP_ID, notificationAppId } from "../desktop/paths.ts";
import { LOCKED_PAGE } from "../server/app.ts";
import { SESSION_COOKIE } from "../server/security.ts";
import { SESSION_COOKIE as DESKTOP_SESSION_COOKIE } from "../desktop/session.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { NOTICE_PREFIX, loginItemJson, noticeForRun, noticeLine, parseLoginItem, parseNoticeLine, toastXml } from "../shared/desktop.ts";
import type { AppStatus } from "../shared/types.ts";
import { encodeIco } from "../desktop/build/ico.ts";
import { decideLink, isAppPage } from "../desktop/external-links.ts";
import { allowPermission } from "../desktop/permissions.ts";
import { routeFromNoticeUrl, tooltipFor } from "../desktop/fleet-tooltip.ts";
import { ROOT, dataPaths, devUserData, originFor, portFor } from "../desktop/paths.ts";
import { lineSplitter } from "../desktop/server-process.ts";
import { DEFAULT_WINDOW_STATE, MIN_HEIGHT, MIN_WIDTH, isPositionVisible, sanitizeWindowState } from "../desktop/window-state.ts";
import { isPeriskoposPage } from "../desktop/wait-http.ts";
import { userAppDir } from "../server/config.ts";
import { systemNotifier } from "../server/alerts/notify.ts";
import { startupStatus } from "../server/startup.ts";

describe("what the server and the desktop app tell each other", () => {
  test("a notification survives the trip as one line", () => {
    const notice = { title: "Star-Map is down", body: "No answer", url: "http://localhost:4100/#/apps/star-map" };
    const line = noticeLine(notice);
    assert.ok(line.startsWith(NOTICE_PREFIX));
    assert.ok(!line.includes("\n"));
    assert.deepEqual(parseNoticeLine(line), notice);
  });

  test("an alarm survives the trip; anything but true for it isn't a notification", () => {
    const notice = { title: "Cloudflare reports an incident", body: "Workers Builds · affects Star-Map", alarm: true as const };
    assert.deepEqual(parseNoticeLine(noticeLine(notice)), notice);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}{"title":"t","body":"b","alarm":"yes"}`), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}{"title":"t","body":"b","alarm":false}`), undefined);
  });

  test("an alarm toast loops Windows' alarm sound until dismissed; a plain one doesn't", () => {
    const alarm = toastXml({ title: "Cloudflare <reports> an incident", body: "Workers & Pages", alarm: true }, "http://localhost:4100/#/");
    assert.match(alarm, /^<toast scenario="alarm" activationType="protocol" launch="http:\/\/localhost:4100\/#\/">/);
    assert.match(alarm, /<audio src="ms-winsoundevent:Notification\.Looping\.Alarm" loop="true"\/>/);
    assert.match(alarm, /<action activationType="system" arguments="dismiss" content=""\/>/);
    assert.match(alarm, /Cloudflare &lt;reports&gt; an incident.*Workers &amp; Pages/);
    const plain = toastXml({ title: "Star-Map is down", body: "No answer" });
    assert.equal(plain, `<toast><visual><binding template="ToastGeneric"><text>Star-Map is down</text><text>No answer</text></binding></visual></toast>`);
  });

  test("a dev run's notifications say so; the installed app's are as sent", () => {
    const notice = { title: "Moon-Base: CI is failing", body: "CI failing on main", url: "http://localhost:4101/#/apps/moon-base" };
    assert.deepEqual(noticeForRun(notice, true), notice);
    assert.deepEqual(noticeForRun(notice, false), { ...notice, title: "Dev · Moon-Base: CI is failing" });
  });

  test("anything that isn't exactly a notification is ignored", () => {
    assert.equal(parseNoticeLine("Periskopos is running at http://localhost:4100"), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}not json`), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}{"title":5,"body":"x"}`), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}{"title":"","body":"x"}`), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}{"title":"t","body":"b","url":7}`), undefined);
    assert.equal(parseNoticeLine(`${NOTICE_PREFIX}null`), undefined);
  });

  test("a runaway notification is cut, not passed on whole", () => {
    const parsed = parseNoticeLine(noticeLine({ title: "t".repeat(5000), body: "b".repeat(5000) }));
    assert.equal(parsed?.title.length, 200);
    assert.equal(parsed?.body.length, 1000);
  });

  test("the login-item file reads back what was written, and bad content means off", () => {
    assert.equal(parseLoginItem(loginItemJson(true)), true);
    assert.equal(parseLoginItem(loginItemJson(false)), false);
    assert.equal(parseLoginItem("{"), false);
    assert.equal(parseLoginItem('{"enabled":"yes"}'), false);
  });
});

describe("run by the desktop app", () => {
  test("the server hands notifications over on its output instead of showing them", async () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      await systemNotifier("win32", { PERISKOPOS_DESKTOP: "1" }).notify({ title: "T", body: "B", url: "http://localhost:4100/#/" });
    } finally {
      process.stdout.write = original;
    }
    assert.equal(written.length, 1);
    assert.deepEqual(parseNoticeLine(written[0].trim()), { title: "T", body: "B", url: "http://localhost:4100/#/" });
  });

  test("start-at-login is the desktop app's to report", async () => {
    // Where the file is comes from PERISKOPOS_DATA_DIR at import, so only the owner and
    // the shape are asserted here.
    const status = await startupStatus("win32", { PERISKOPOS_DESKTOP: "1" });
    assert.equal(status.managedBy, "desktop");
    assert.equal(status.supported, true);
    assert.equal(typeof status.enabled, "boolean");
    assert.equal((await startupStatus("linux", {})).managedBy, undefined);
  });

  test("a checkout keeps its registry where it was; an install uses the user's profile", () => {
    const checkout = dataPaths(false, "C:/Users/me/AppData/Roaming/Periskopos");
    assert.equal(checkout.dataDir, path.join(ROOT, "data"));
    // Electron's folder is named after the package ("periskopos"); the
    // keys are in the server's Periskopos folder, where the README says.
    const saved = process.env.PERISKOPOS_ENV_FILE;
    delete process.env.PERISKOPOS_ENV_FILE;
    try {
      const installed = dataPaths(true, "/profile/periskopos", "/profile/Periskopos");
      assert.equal(installed.dataDir, path.join("/profile/periskopos", "data"));
      assert.equal(installed.envFile, path.join("/profile/Periskopos", ".env.local"));
      assert.equal(dataPaths(true, "/profile/periskopos").envFile, path.join(userAppDir(), ".env.local"));
    } finally {
      if (saved !== undefined) process.env.PERISKOPOS_ENV_FILE = saved;
    }
  });

  test("a checkout runs beside the installed app: its own port and its own profile folder", () => {
    assert.equal(portFor(true, {}), 4100);
    assert.equal(portFor(false, {}), 4101);
    assert.equal(portFor(false, { PERISKOPOS_PORT: "4200" }), 4200);
    assert.equal(portFor(true, { PERISKOPOS_PORT: "4200" }), 4200);
    assert.equal(originFor(4101), "http://127.0.0.1:4101");
    // Electron's lock is tied to the profile folder: the same one would hand
    // `npm run dev` straight over to the installed app.
    const appData = "/profile";
    assert.notEqual(devUserData(appData), path.join(appData, "periskopos"));
    assert.equal(path.dirname(devUserData(appData)), path.normalize(appData));
  });
});

describe("the window", () => {
  const ORIGIN = "http://127.0.0.1:4100";

  test("stays on Periskopos; the web goes to the browser; nothing odd goes anywhere", () => {
    assert.equal(decideLink("http://127.0.0.1:4100/#/apps/x", ORIGIN), "internal");
    assert.equal(decideLink("https://github.com/acme/apps", ORIGIN), "external");
    assert.equal(decideLink("http://127.0.0.1:9999/", ORIGIN), "external");
    assert.equal(decideLink("file:///C:/Windows/System32/calc.exe", ORIGIN), "block");
    assert.equal(decideLink("javascript:alert(1)", ORIGIN), "block");
    assert.equal(decideLink("ms-msdt:/id", ORIGIN), "block");
    assert.equal(decideLink("not a url", ORIGIN), "block");
  });

  test("only the app's own origin may talk to the shell, not one that merely starts the same", () => {
    assert.equal(isAppPage("http://127.0.0.1:4100/#/fleet", ORIGIN), true);
    assert.equal(isAppPage("http://127.0.0.1:41000/", ORIGIN), false);
    assert.equal(isAppPage("http://127.0.0.1:4100.evil.example/", ORIGIN), false);
    assert.equal(isAppPage("http://localhost:4100/", ORIGIN), false); // the window only ever loads ORIGIN
    assert.equal(isAppPage("", ORIGIN), false);
  });

  test("the page may write to the clipboard (its Copy buttons), and nothing else; no other page may", () => {
    assert.equal(allowPermission("clipboard-sanitized-write", "http://127.0.0.1:4100/#/settings", ORIGIN), true);
    assert.equal(allowPermission("clipboard-sanitized-write", "https://example.com/", ORIGIN), false);
    for (const permission of ["clipboard-read", "notifications", "media", "geolocation", "openExternal"]) {
      assert.equal(allowPermission(permission, "http://127.0.0.1:4100/", ORIGIN), false, permission);
    }
  });

  test("a saved position is used only if it still lands on a connected display", () => {
    const one = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    assert.equal(isPositionVisible(100, 100, 1200, one), true);
    assert.equal(isPositionVisible(2500, 100, 1200, one), false); // the second monitor is gone
    assert.equal(isPositionVisible(100, 3000, 1200, one), false);
    assert.equal(isPositionVisible(100, -200, 1200, one), false, "the title bar above the screen can't be grabbed");
    const state = sanitizeWindowState({ x: 2500, y: 100, width: 1300, height: 900, maximized: true }, one);
    assert.equal(state.x, undefined);
    assert.equal(state.maximized, true);
    assert.deepEqual(sanitizeWindowState({ x: 100.4, y: 50, width: 1300, height: 900, maximized: false }, one), { x: 100, y: 50, width: 1300, height: 900, maximized: false }, "on screen: kept");
  });

  test("a corrupt state file degrades to the default, and tiny sizes are raised", () => {
    const one = [{ x: 0, y: 0, width: 1920, height: 1040 }];
    assert.deepEqual(sanitizeWindowState("nope", one), DEFAULT_WINDOW_STATE);
    assert.deepEqual(sanitizeWindowState({ width: "wide", height: NaN }, one), DEFAULT_WINDOW_STATE);
    const small = sanitizeWindowState({ width: 10, height: 10 }, one);
    assert.equal(small.width, MIN_WIDTH);
    assert.equal(small.height, MIN_HEIGHT);
  });
});

describe("the tray and notifications", () => {
  const status = (state: AppStatus["state"], i: number): AppStatus => ({ slug: `a${i}`, state, checks: {} });

  test("the tooltip is the Fleet's own headline", () => {
    assert.equal(tooltipFor([status("up", 0), status("up", 1)]), "Periskopos: All normal");
    assert.equal(tooltipFor([status("up", 0), status("down", 1)]), "Periskopos: 1 down");
    assert.equal(tooltipFor([status("up", 0), status("prelaunch", 1)]), "Periskopos: All normal");
  });

  test("a notification click opens the window on the right page, and only for this Periskopos", () => {
    assert.equal(routeFromNoticeUrl("http://localhost:4100/#/apps/star-map", 4100), "#/apps/star-map");
    assert.equal(routeFromNoticeUrl("http://127.0.0.1:4100/#/", 4100), "#/");
    assert.equal(routeFromNoticeUrl("http://localhost:4100/", 4100), "#/");
    assert.equal(routeFromNoticeUrl("http://localhost:4200/#/apps/x", 4100), undefined);
    assert.equal(routeFromNoticeUrl("https://evil.example/#/apps/x", 4100), undefined);
    assert.equal(routeFromNoticeUrl("http://localhost.evil.example:4100/#/", 4100), undefined);
    assert.equal(routeFromNoticeUrl(undefined, 4100), undefined);
  });
});

describe("plumbing", () => {
  test("output cut anywhere still comes out as whole lines", () => {
    const lines: string[] = [];
    const push = lineSplitter((l) => lines.push(l));
    push("one\ntw");
    push("o\r\nthr");
    push("ee\n");
    assert.deepEqual(lines, ["one", "two", "three"]);
  });

  test("only Periskopos's own pages count as Periskopos, locked or not", () => {
    assert.equal(isPeriskoposPage('<html><meta name="periskopos" content="app" /></html>'), true);
    assert.equal(isPeriskoposPage(LOCKED_PAGE), true);
    assert.equal(isPeriskoposPage("<html>Welcome to nginx</html>"), false);
  });

  test("the window's cookie has the name the server reads", () => {
    assert.equal(DESKTOP_SESSION_COOKIE, SESSION_COOKIE);
  });

  test("an .ico holds each image at the offset its directory says", () => {
    const a = Buffer.from("AAAA");
    const b = Buffer.from("BBBBBB");
    const ico = encodeIco([a, b], [16, 256]);
    assert.equal(ico.readUInt16LE(2), 1);
    assert.equal(ico.readUInt16LE(4), 2);
    assert.equal(ico.readUInt8(6), 16);
    assert.equal(ico.readUInt8(6 + 16), 0); // 256 is written as 0
    const offsetB = ico.readUInt32LE(6 + 16 + 12);
    assert.equal(ico.subarray(offsetB, offsetB + 6).toString(), "BBBBBB");
    assert.throws(() => encodeIco([a], [16, 32]));
  });
});

describe("notifications and the tray menu", () => {
  test("only the installed app uses the installed app's notification id", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { build: { appId: string } };
    assert.equal(notificationAppId(true), pkg.build.appId);
    assert.equal(APP_ID, pkg.build.appId);
    assert.notEqual(notificationAppId(false), pkg.build.appId, "a dev run's shortcut must never catch the installed app's notification clicks");
  });

  test("menu icons: a dark glyph on light menus, a light one on dark, a template on a Mac", () => {
    assert.match(menuIconFile("/d", "quit", false, "win32"), /menu-quit-dark\.png$/);
    assert.match(menuIconFile("/d", "quit", true, "win32"), /menu-quit-light\.png$/);
    assert.match(menuIconFile("/d", "quit", true, "darwin"), /menu-quit-dark\.png$/);
    assert.equal(menuIconDir(true, "/res", "/root"), path.join("/res", "menu"));
    assert.equal(menuIconDir(false, "/res", "/root"), path.join("/root", "desktop", "build", "menu"));
    for (const icon of MENU_ICONS) assert.match(menuIconSvg(icon, "light"), /^<svg [^>]*stroke="#e6e9ee"/);
  });

  test("the installer carries the menu icons", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { build: { extraResources: { from: string; to: string }[] } };
    assert.ok(pkg.build.extraResources.some((r) => r.from === "desktop/build/menu" && r.to === "menu"));
  });
});
