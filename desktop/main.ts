import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, safeStorage, session, shell } from "electron";
import type { IpcMainEvent } from "electron";
import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { backupsDir } from "../server/backup.ts";
import { VERSION } from "../server/config.ts";
import { recordCrash } from "../server/crash-log.ts";
import { disableStartup, startupStatus } from "../server/startup.ts";
import { LOGIN_ITEM_FILE, isUpdateAction, loginItemJson, noticeForRun } from "../shared/desktop.ts";
import type { UpdateAction } from "../shared/desktop.ts";
import type { DesktopNotice } from "../shared/desktop.ts";
import { openDaemonLog } from "./daemon-log.ts";
import type { DaemonLog } from "./daemon-log.ts";
import { PROTOCOL, findDeepLinkInArgv, isSafeRoute, parseDeepLink } from "./deep-link.ts";
import { isAppPage } from "./external-links.ts";
import { attentionCount, badgeText, fetchApps, fetchStatuses, routeFromNoticeUrl, tooltipFor } from "./fleet-tooltip.ts";
import {
  IPC_NAVIGATE,
  IPC_OPEN_BACKUPS,
  IPC_OPEN_LOGS,
  IPC_SET_CHROME_COLORS,
  IPC_UPDATE_ACT,
  IPC_LOGIN_ITEM_GET,
  IPC_LOGIN_ITEM_SET,
  IPC_LOGIN_ITEM_STATE,
  IPC_UPDATE_GET,
  IPC_UPDATE_STATE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_GET_MAXIMIZED,
  IPC_WINDOW_HARD_RELOAD,
  IPC_WINDOW_MAXIMIZED_STATE,
  IPC_WINDOW_MENU,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_TOGGLE_MAXIMIZE,
} from "./ipc-channels.ts";
import { buildMenuTemplate, DOCS_URL, ISSUES_URL } from "./menu-template.ts";
import type { MenuCommand } from "./menu-template.ts";
import { showNotification } from "./notifications.ts";
import { menuIconDir } from "./menu-icons.ts";
import { ROOT, dataPaths, devUserData, iconFor, notificationAppId, originFor, portFor } from "./paths.ts";
import { lockDownPermissions } from "./permissions.ts";
import { SESSION_COOKIE } from "./session.ts";
import { keysKey } from "./keys-key.ts";
import { startServer } from "./server-process.ts";
import { readChromeColors, writeChromeColors } from "./shell-chrome.ts";
import { createSplashWindow } from "./splash.ts";
import type { SplashWindow } from "./splash.ts";
import { destroyTray, hasTray, installTray, refreshTrayMenu, setTrayGlance, setTrayTooltip } from "./tray.ts";
import { buildGlance, trayVariant } from "./tray-glance.ts";
import type { GlanceApp } from "./tray-glance.ts";
import { trayUpdateItem } from "./update-plan.ts";
import type { UpdateState } from "./update-plan.ts";
import { startUpdater } from "./updater.ts";
import { classifyHolder, describeHolder, findHolder, holderDetail } from "./port-holder.ts";
import { probe, waitForPeriskopos } from "./wait-http.ts";
import { createMainWindow } from "./window.ts";

// Periskopos as a desktop app: a window onto the local server with its own
// title bar, a tray icon so it keeps watching when the window is closed,
// notifications that open the window, deep links, and (installed) starting at
// login. The server is the same one `npm start` runs; this only hosts it. Run
// from a checkout with `npm run desktop`.

const TOOLTIP_EVERY_MS = 60_000;

let mainWindow: BrowserWindow | null = null;
let server: ChildProcess | null = null;
let log: DaemonLog | null = null;
let quitting = false;
let shownTrayHint = false;
let poll: NodeJS.Timeout | undefined;
// This launch's key to its own server (docs/AGENT-SAFETY.md §4.1): handed to
// the server on stdin, to the window as a cookie, and to nothing else.
const sessionKey = randomBytes(32).toString("base64url");
let updater: ReturnType<typeof startUpdater> | undefined;
let updateState: UpdateState = { kind: "unavailable", reason: "Only the installed app updates itself; this one runs from the project folder." };

// The window's update button: where the updater stands, and what to do.
// The version from package.json: Electron's own app.getVersion() is
// Electron's version in a run from the project folder.
const updateSnapshot = () => ({ version: VERSION, state: updateState });
function runUpdate(action: UpdateAction): void {
  if (action === "check") updater?.check();
  else if (action === "install") updater?.install();
  else updater?.download();
}
// A route that arrived before the window could receive it (a link that
// launched the app, or a notification clicked while the window was hidden).
let pendingRoute: string | undefined;
// Start at login, once booted; the installed app only.
let loginItem: { readonly enabled: boolean; set: (on: boolean) => void } | undefined;
// Set at the end of boot(), once the server answers. Before then a window
// would open onto nothing, so a link or a second launch is only remembered.
let booted = false;
// The window was asked for (a second launch, a link) before boot finished.
let wantWindow = false;
// What the server said, on its way out, was stopping it from starting.
let whyStopped: string | undefined;

const startHidden = process.argv.includes("--hidden");
const isPackaged = app.isPackaged;
// PERISKOPOS_THEME=light or dark opens the window in that theme whatever the
// system's, for checking both; otherwise it follows the system.
if (process.env.PERISKOPOS_THEME === "light" || process.env.PERISKOPOS_THEME === "dark") nativeTheme.themeSource = process.env.PERISKOPOS_THEME;
// Before the single-instance lock below, which is tied to this folder.
if (!isPackaged) app.setPath("userData", devUserData(app.getPath("appData")));
const userData = () => app.getPath("userData");
const PORT = portFor(isPackaged);
const ORIGIN = originFor(PORT);

app.setAppUserModelId(notificationAppId(isPackaged));

const logLine = (text: string): void => log?.write(`${new Date().toISOString()} [shell] ${text}\n`);
const resources = () => process.resourcesPath;

// ── Crashes ─────────────────────────────────────────────────────────────

// The shell's own crashes, and its window's, go in the crash log beside the
// server's (server/crash-log.ts), so diagnostics and a bug report show them.
const crashFolder = () => dataPaths(isPackaged, userData()).dataDir;
process.on("uncaughtException", (err) => {
  recordCrash(`Desktop shell: ${err.stack ?? err.message}`, crashFolder());
  logLine(`crashed: ${err.stack ?? err.message}`);
  dialog.showErrorBox("Periskopos ran into a problem", `${err.message}\n\nHelp → Report an issue copies what happened, for a bug report.`);
});
app.on("render-process-gone", (_event, _contents, details) => {
  if (details.reason === "clean-exit") return;
  recordCrash(`Window: ${details.reason} (exit code ${details.exitCode})`, crashFolder());
  logLine(`the window's process is gone: ${details.reason} (exit code ${details.exitCode})`);
});
app.on("child-process-gone", (_event, details) => {
  if (details.reason === "clean-exit" || details.reason === "killed") return;
  recordCrash(`${details.type} process: ${details.reason} (exit code ${details.exitCode})`, crashFolder());
  logLine(`${details.type} process gone: ${details.reason} (exit code ${details.exitCode})`);
});

// Help → Report an issue: the diagnostics (redacted: no keys, addresses or
// app names) go on the clipboard, and the bug form opens to paste them in.
// Nothing is sent by itself.
async function reportIssue(): Promise<void> {
  let copied = false;
  try {
    const res = await fetch(`${ORIGIN}/api/diagnostics`, { headers: { "x-periskopos-token": sessionKey }, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      clipboard.writeText(await res.text());
      copied = true;
    }
  } catch {
    // the server isn't answering: the form opens all the same
  }
  void shell.openExternal(`${ISSUES_URL}/new?template=bug_report.yml`);
  if (copied) notify({ title: "Diagnostics copied", body: "Paste them into the report's Diagnostics box." });
}

// ── The window ──────────────────────────────────────────────────────────

function flushRoute(): void {
  if (!pendingRoute || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
  mainWindow.webContents.send(IPC_NAVIGATE, pendingRoute);
  pendingRoute = undefined;
}

function showWindow(route?: string): void {
  if (route && isSafeRoute(route)) pendingRoute = route;
  if (!booted) {
    // boot() shows it, with the route, once the server answers: even when
    // started hidden at login, since someone has asked for the window since.
    wantWindow = true;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createMainWindow({
      origin: ORIGIN,
      userData: userData(),
      icon: iconFor("window", isPackaged, resources()),
      colors: readChromeColors(userData(), nativeTheme.shouldUseDarkColors),
      canHideToTray: hasTray,
      isQuitting: () => quitting,
      onHideToTray: hintTray,
    });
    mainWindow.on("closed", () => {
      mainWindow = null;
    });
    mainWindow.webContents.on("did-finish-load", flushRoute);
  } else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    flushRoute();
  }
}

// The first time the window is hidden rather than closed, say it's still
// watching: otherwise the X button reads as "quit".
function hintTray(): void {
  if (shownTrayHint) return;
  shownTrayHint = true;
  notify({ title: "Periskopos is still watching", body: "Closing the window keeps it running in the system tray. Quit it from the tray icon." });
}

function notify(notice: DesktopNotice): void {
  const route = routeFromNoticeUrl(notice.url, PORT);
  showNotification(noticeForRun(notice, isPackaged), iconFor("notification", isPackaged, resources()), () => showWindow(route), logLine);
}

// ── Messages from the page ──────────────────────────────────────────────

// Only the app's own window, showing the app's own page, may ask the shell for
// anything.
function trusted(event: IpcMainEvent): boolean {
  return mainWindow !== null && event.sender === mainWindow.webContents && isAppPage(event.senderFrame?.url ?? "", ORIGIN);
}

function onPage(channel: string, handler: (event: IpcMainEvent, payload: unknown) => void): void {
  ipcMain.on(channel, (event, payload: unknown) => {
    if (trusted(event)) handler(event, payload);
    else logLine(`ignored ${channel} from an untrusted sender`);
  });
}

function registerPageHandlers(): void {
  onPage(IPC_SET_CHROME_COLORS, (_event, colors) => {
    // Cosmetic and best effort: a malformed payload is only logged.
    if (!writeChromeColors(userData(), colors)) logLine("ignored malformed chrome colours");
  });
  onPage(IPC_OPEN_LOGS, () => {
    if (log) shell.showItemInFolder(log.path);
  });
  onPage(IPC_OPEN_BACKUPS, () => {
    // The server makes the folder with its first copy; it may not be there yet.
    const dir = backupsDir(dataPaths(isPackaged, userData()).dataDir);
    mkdirSync(dir, { recursive: true });
    void shell.openPath(dir);
  });
  onPage(IPC_WINDOW_HARD_RELOAD, () => mainWindow?.webContents.reloadIgnoringCache());
  onPage(IPC_WINDOW_MINIMIZE, () => mainWindow?.minimize());
  onPage(IPC_WINDOW_TOGGLE_MAXIMIZE, () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  onPage(IPC_WINDOW_CLOSE, () => mainWindow?.close());
  // The application menu where the page asks (its menu button), since a
  // frameless window shows no menu bar. Page pixels times the zoom are the
  // window's own.
  onPage(IPC_WINDOW_MENU, (_event, at) => {
    const menu = Menu.getApplicationMenu();
    if (!menu || !mainWindow) return;
    const { x, y } = (typeof at === "object" && at !== null ? at : {}) as { x?: unknown; y?: unknown };
    const zoom = mainWindow.webContents.getZoomFactor();
    const point = typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x * zoom), y: Math.round(y * zoom) } : {};
    menu.popup({ window: mainWindow, ...point });
  });
  onPage(IPC_UPDATE_GET, (event) => event.sender.send(IPC_UPDATE_STATE, updateSnapshot()));
  onPage(IPC_UPDATE_ACT, (_event, action) => {
    if (isUpdateAction(action)) runUpdate(action);
    else logLine("ignored an unknown update action");
  });
  const loginItemState = () => ({ available: loginItem !== undefined, enabled: loginItem?.enabled ?? false });
  onPage(IPC_LOGIN_ITEM_GET, (event) => event.sender.send(IPC_LOGIN_ITEM_STATE, loginItemState()));
  onPage(IPC_LOGIN_ITEM_SET, (event, on) => {
    if (typeof on === "boolean" && loginItem) loginItem.set(on);
    else logLine("ignored a start-at-login change");
    event.sender.send(IPC_LOGIN_ITEM_STATE, loginItemState());
  });
  onPage(IPC_WINDOW_GET_MAXIMIZED, (event) => {
    event.sender.send(IPC_WINDOW_MAXIMIZED_STATE, mainWindow?.isMaximized() ?? false);
  });
}

// ── Application menu ────────────────────────────────────────────────────

function installApplicationMenu(dataDir: string): void {
  app.setAboutPanelOptions({
    applicationName: "Periskopos",
    applicationVersion: VERSION,
    copyright: "Copyright 2026 Daniel Noam Tuby · Apache License 2.0",
  });
  const run = (command: MenuCommand): void => {
    switch (command) {
      case "about":
        app.showAboutPanel();
        return;
      case "check-updates":
        updater?.check();
        return;
      case "open-window":
        showWindow();
        return;
      case "show-logs":
        if (log) shell.showItemInFolder(log.path);
        return;
      case "open-data":
        void shell.openPath(dataDir);
        return;
      case "open-docs":
        void shell.openExternal(DOCS_URL);
        return;
      case "report-issue":
        void reportIssue();
        return;
    }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate({ isPackaged, platform: process.platform }, run)));
}

// ── Start at login ──────────────────────────────────────────────────────

function setLoginItem(dataDir: string, on: boolean): void {
  app.setLoginItemSettings({ openAtLogin: on, args: on ? ["--hidden"] : [], enabled: on });
  writeLoginItemFile(dataDir, on);
  refreshTrayMenu();
}

function writeLoginItemFile(dataDir: string, on: boolean): void {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path.join(dataDir, LOGIN_ITEM_FILE), loginItemJson(on));
  } catch {
    // The Settings page just won't show it.
  }
}

// ── The tray's glance and tooltip, and a Mac's dock badge ───────────────

// The app asks its own server with its own session key. The apps' names come
// in the same refresh; if only they fail, the last names seen are kept (an
// app missing from them shows by its slug).
function startActivityPolling(): void {
  let saidWhy = false;
  let apps: GlanceApp[] = [];
  const refresh = async () => {
    const [statuses, listed] = await Promise.all([fetchStatuses(ORIGIN, sessionKey), fetchApps(ORIGIN, sessionKey)]);
    if (listed) apps = listed;
    if (!statuses) {
      if (!saidWhy) logLine(`tray tooltip: ${ORIGIN} didn't give its status, so the tooltip keeps what it said`);
      saidWhy = true;
      return; // keep what it said
    }
    saidWhy = false;
    setTrayTooltip(tooltipFor(statuses));
    setTrayGlance(buildGlance(apps, statuses), trayVariant(statuses));
    app.dock?.setBadge(badgeText(attentionCount(statuses)));
  };
  void refresh();
  poll = setInterval(() => void refresh(), TOOLTIP_EVERY_MS);
  poll.unref();
}

// ── Starting up ─────────────────────────────────────────────────────────

async function fail(splash: SplashWindow | undefined, message: string): Promise<never> {
  splash?.close();
  const { response } = await dialog.showMessageBox({
    type: "error",
    buttons: log ? ["Quit", "Show log and quit"] : ["Quit"],
    defaultId: 0,
    cancelId: 0,
    message: "Periskopos couldn't start",
    detail: message,
  });
  if (response === 1 && log) shell.showItemInFolder(log.path);
  quitting = true;
  // app.exit skips before-quit, so the server this run started (if any) is
  // stopped here or it would be left running without a window.
  server?.kill();
  app.exit(1);
  throw new Error(message);
}

// Another Periskopos holds the port. A server started outside any app
// and left running (by hand, an old login service, a coding session) is
// named and, if I say so, stopped, and starting goes on. Another app's own
// server, or anything that can't be told, is never touched.
async function settleOtherCopy(splash: SplashWindow | undefined): Promise<void> {
  const holder = await findHolder(PORT);
  const kind = holder ? classifyHolder(holder) : "unknown";
  if (holder && kind === "leftover") {
    // The retired login service (asked for as a plain run, not as the app's
    // server, whose own setting this isn't).
    const startsAtLogin = await startupStatus(process.platform, {}).then((s) => s.enabled, () => false);
    const { response } = await dialog.showMessageBox({
      type: "warning",
      buttons: ["Stop it and continue", "Quit"],
      defaultId: 0,
      cancelId: 1,
      message: "A Periskopos server is already running",
      detail: holderDetail(holder, PORT, startsAtLogin),
    });
    if (response !== 0) {
      splash?.close();
      quitting = true;
      app.exit(0);
      throw new Error("Quit rather than stop the other server");
    }
    splash?.setStatus("Stopping the other server…");
    logLine(`stopping leftover server ${describeHolder(holder)}`);
    try {
      process.kill(holder.pid);
    } catch (err) {
      await fail(splash, `Couldn't stop ${describeHolder(holder)}: ${(err as Error).message}`);
    }
    // So it doesn't come back at the next login. Starting goes on either way.
    if (startsAtLogin) {
      await disableStartup().then(
        (done) => logLine(`old login service: ${done}`),
        (err: Error) => logLine(`couldn't remove the old login service: ${err.message}`),
      );
    }
    for (let i = 0; i < 20; i++) {
      if ((await probe(ORIGIN)) === "none") return;
      await new Promise((r) => setTimeout(r, 250));
    }
    await fail(splash, `${describeHolder(holder)} didn't stop. Stop it yourself, then start the app again.`);
  }
  await fail(
    splash,
    kind === "app"
      ? `Another Periskopos app is already running on port ${PORT} (${describeHolder(holder!)}). Quit it from its tray icon, then start this one again.`
      : `Another copy of Periskopos is already running on port ${PORT}${holder ? `: ${describeHolder(holder)}` : ""}. Stop it, then start the app again.`,
  );
}

async function boot(): Promise<void> {
  lockDownPermissions(session.defaultSession, ORIGIN);
  const { dataDir, envFile } = dataPaths(isPackaged, userData());
  log = openDaemonLog(path.join(dataDir, "logs"));
  registerPageHandlers();
  // Installed only: a checkout's keys stay plain text, as `npm start` reads them.
  const keysHex = isPackaged && envFile ? keysKey(envFile, safeStorage, logLine) : undefined;

  // Shown the moment the app is launched (not when it's started hidden at login).
  const splash = startHidden
    ? undefined
    : createSplashWindow(readChromeColors(userData(), nativeTheme.shouldUseDarkColors), iconFor("window", isPackaged, resources()));
  splash?.setStatus("Starting Periskopos…");

  // Only this app's own server will do: it holds the key that opens
  // Periskopos (docs/AGENT-SAFETY.md §4.1). Another copy on the port
  // (an old `npm run install-service`, `npm run dev`) can't be shared.
  const found = await probe(ORIGIN);
  if (found === "other") await fail(splash, `Something else is using port ${PORT}. Stop it, or set PERISKOPOS_PORT to another port.`);
  if (found !== "none") await settleOtherCopy(splash);

  server = startServer({
    root: ROOT,
    port: PORT,
    dataDir,
    envFile,
    sessionKey,
    keysKey: keysHex,
    log,
    onNotice: notify,
    onFatal: (message) => {
      whyStopped = message;
    },
    onExit: (code, signal) => {
      server = null;
      // While starting, waitForPeriskopos notices and fail() says so:
      // one dialog, not two.
      if (!quitting && booted) void serverDied(code, signal);
    },
  });
  try {
    splash?.setStatus(`Waiting for the server on ${ORIGIN}…`);
    await waitForPeriskopos(ORIGIN, { sessionKey, stillRunning: () => server !== null });
  } catch (err) {
    await fail(splash, whyStopped ?? `${(err as Error).message}.`);
  }
  // The window's way in: a cookie only this app's session holds, kept in
  // memory (no expiry date, so never written to disk), and sent only to
  // Periskopos's own address.
  await session.defaultSession.cookies.set({ url: ORIGIN, name: SESSION_COOKIE, value: sessionKey, httpOnly: true, sameSite: "strict" });

  // Installed only: a checkout's app must not register itself to start at
  // login, nor can it know where it will be tomorrow.
  // `enabled` is read from Windows each time the menu is built: a value kept
  // from start-up would put the menu back to it after every click.
  loginItem = isPackaged
    ? {
        get enabled() {
          const settings = app.getLoginItemSettings({ args: ["--hidden"] });
          // On Windows it can be registered yet switched off in Task Manager's
          // Startup tab (or Settings > Apps > Startup): then it doesn't start,
          // so it isn't on. Switching it on here switches that back on too.
          return process.platform === "win32" ? settings.openAtLogin && settings.executableWillLaunchAtLogin : settings.openAtLogin;
        },
        set: (on: boolean) => setLoginItem(dataDir, on),
      }
    : undefined;
  // `periskopos --enable-login-item` switches it on without the tray menu
  // (for setting up an install from a script).
  if (loginItem && process.argv.includes("--enable-login-item")) loginItem.set(true);
  else writeLoginItemFile(dataDir, loginItem?.enabled ?? false);

  // Installed only: a checkout updates with git pull.
  if (isPackaged) {
    updateState = { kind: "idle" };
    updater = startUpdater({
      envFile,
      keysKey: keysHex,
      log: logLine,
      notify,
      openExternal: (url) => void shell.openExternal(url),
      onState: (state) => {
        updateState = state;
        refreshTrayMenu();
        mainWindow?.webContents.send(IPC_UPDATE_STATE, updateSnapshot());
      },
      beforeInstall: () => {
        quitting = true;
      },
    });
  }

  installApplicationMenu(dataDir);
  installTray(iconFor("tray", isPackaged, resources()), {
    show: () => showWindow(),
    open: (route) => showWindow(route),
    openDataFolder: () => void shell.openPath(dataDir),
    quit: () => app.quit(),
    loginItem,
    update: () => trayUpdateItem(updateState),
    onUpdate: runUpdate,
    cutOffAssistants: () => void cutOffAssistants(),
  }, menuIconDir(isPackaged, resources(), ROOT));
  startActivityPolling();
  booted = true;
  // Started hidden at login, it still opens for a link that arrived meanwhile.
  if (!startHidden || !hasTray() || pendingRoute || wantWindow) showWindow();
  splash?.close();
}

// The tray's kill switch: assistants are shut out and whatever they're
// waiting on is withdrawn (the server does that when access goes off).
async function cutOffAssistants(): Promise<void> {
  try {
    const res = await fetch(`${ORIGIN}/api/settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-periskopos-token": sessionKey },
      body: JSON.stringify({ agentAccess: false }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    notify({ title: "AI assistants are cut off", body: "None can read or ask for anything now. Turn them back on in Settings → AI assistants." });
  } catch (err) {
    notify({ title: "Couldn't cut off AI assistants", body: (err as Error).message });
  }
}

async function serverDied(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
  const { response } = await dialog.showMessageBox({
    type: "error",
    buttons: ["Restart", "Show log and quit", "Quit"],
    defaultId: 0,
    cancelId: 2,
    message: "Periskopos's server stopped",
    detail: `It exited (${signal ?? `code ${code}`}), so nothing is being watched.${log ? `\n\nLog: ${log.path}` : ""}`,
  });
  if (response === 0 && updateState.kind === "ready" && updater) {
    // A downloaded update installs on quit, and its installer would run
    // against the copy relaunching here: install it now instead, which
    // starts the new version itself.
    updater.install();
    return;
  }
  if (response === 0) app.relaunch();
  else if (response === 1 && log) shell.showItemInFolder(log.path);
  app.quit();
}

// ── One instance, deep links, quitting ──────────────────────────────────

// A second copy would fight the first over the port and the registry: hand
// the launch to the one already running (and any periskopos:// link it
// was given).
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Both can come before boot() is done (a Mac's open-url even before ready,
  // when no window can be made): showWindow only remembers the route then.
  app.on("second-instance", (_event, argv) => showWindow(findDeepLinkInArgv(argv)));
  // A Mac delivers a link as an event instead, and can do so before ready.
  app.on("open-url", (event, url) => {
    event.preventDefault();
    showWindow(parseDeepLink(url));
  });
  app.on("window-all-closed", () => {
    // Quitting is otherwise only ever explicit (tray, menu, Cmd+Q): the point
    // is to keep watching. Without a tray (a checkout whose icons were never
    // built) a closed window would leave an invisible app with its server
    // running and no way back, so that quits. A Mac keeps its dock icon.
    // Before boot is done the only window is the splash, and fail() quits.
    if (booted && process.platform !== "darwin" && !hasTray()) app.quit();
  });
  app.on("activate", () => {
    if (!mainWindow) showWindow();
  });
  app.on("before-quit", () => {
    quitting = true;
    clearInterval(poll);
    updater?.stop();
    destroyTray();
    server?.kill();
    log?.close();
  });
  void app.whenReady().then(() => {
    // Installed only: from a checkout the machine's handler would point at a
    // folder that may not be there tomorrow.
    if (isPackaged) app.setAsDefaultProtocolClient(PROTOCOL);
    // A link the Mac delivered before ready is already here: keep it.
    pendingRoute ??= findDeepLinkInArgv(process.argv);
    void boot();
  });
}
