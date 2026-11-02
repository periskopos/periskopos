import { BrowserWindow, screen, shell } from "electron";
import { decideLink } from "./external-links.ts";
import { IPC_WINDOW_MAXIMIZED_STATE } from "./ipc-channels.ts";
import { PRELOAD } from "./paths.ts";
import type { ChromeColors } from "./shell-chrome.ts";
import { MIN_HEIGHT, MIN_WIDTH, readWindowState, writeWindowState } from "./window-state.ts";

// Keep the window on Periskopos's own address and hand everything else to
// the system browser.
function routeLinks(win: BrowserWindow, origin: string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (decideLink(url, origin) === "external") void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const decision = decideLink(url, origin);
    if (decision === "internal") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(url);
  });
  // A server redirect is a navigation too: one leading off the app's address
  // would otherwise load a web page in the window, past will-navigate.
  win.webContents.on("will-redirect", (event) => {
    const decision = decideLink(event.url, origin);
    if (decision === "internal") return;
    event.preventDefault();
    if (decision === "external") void shell.openExternal(event.url);
  });
}

const SAVE_BOUNDS_AFTER_MS = 500;

export type WindowOptions = {
  origin: string;
  userData: string;
  icon: string | undefined;
  colors: ChromeColors;
  canHideToTray: () => boolean;
  isQuitting: () => boolean;
  onHideToTray: () => void;
};

// Chromeless: the page draws its own title bar and window buttons (a
// drag region plus minimize / maximize / close). A Mac keeps
// its own traffic lights, inset to line up with the page's top bar. The page
// has no Node in it: only the small bridge in preload.cts.
export function createMainWindow(options: WindowOptions): BrowserWindow {
  const { origin, userData } = options;
  const isMac = process.platform === "darwin";
  const state = readWindowState(userData, screen.getAllDisplays().map((d) => d.workArea));
  const win = new BrowserWindow({
    ...(options.icon ? { icon: options.icon } : {}),
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: "Periskopos",
    // The page's own canvas colour, so a cold start doesn't flash another one.
    backgroundColor: options.colors.background,
    show: false,
    frame: isMac,
    ...(isMac ? { titleBarStyle: "hidden" as const, trafficLightPosition: { x: 16, y: 16 } } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      // Chromium throttles timers in a hidden page to about once a minute; the
      // page refreshes its status on a timer, and hidden-to-the-tray is when
      // it is wanted fresh.
      backgroundThrottling: false,
      preload: PRELOAD,
    },
  });

  if (state.maximized) win.maximize();
  win.once("ready-to-show", () => win.show());
  routeLinks(win, origin);

  // The page's maximize button needs to know which icon to show, and maximize
  // can happen without it (double-clicking the drag region, an OS snap).
  win.on("maximize", () => win.webContents.send(IPC_WINDOW_MAXIMIZED_STATE, true));
  win.on("unmaximize", () => win.webContents.send(IPC_WINDOW_MAXIMIZED_STATE, false));

  // Where the window is, remembered as it changes and not only on a real
  // close: with hide-to-tray that rarely happens, and Windows shutting down
  // ends the app without one.
  const saveBounds = () => {
    if (win.isDestroyed()) return;
    const b = win.getNormalBounds();
    writeWindowState(userData, { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() });
  };
  let saveLater: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(saveLater);
    saveLater = setTimeout(saveBounds, SAVE_BOUNDS_AFTER_MS);
  };
  win.on("resize", saveSoon);
  win.on("move", saveSoon);
  win.on("maximize", saveSoon);
  win.on("unmaximize", saveSoon);
  win.on("closed", () => clearTimeout(saveLater));

  win.on("close", (event) => {
    clearTimeout(saveLater);
    saveBounds();
    // The point of the app is to keep watching: closing the window hides it to
    // the tray (a Mac keeps the app running on its own), only Quit stops it.
    if (!isMac && !options.isQuitting() && options.canHideToTray()) {
      event.preventDefault();
      win.hide();
      options.onHideToTray();
    }
  });

  void win.loadURL(origin);
  return win;
}
