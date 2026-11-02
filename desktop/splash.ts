import { BrowserWindow } from "electron";
import { splashHtml } from "./splash-html.ts";
import type { ChromeColors } from "./shell-chrome.ts";

// A window on screen the moment the app is launched. Starting the server takes
// a few seconds; without this, clicking the icon looks like nothing happened.
// It says what it is waiting for, and a failed launch has something to close.
export type SplashWindow = { setStatus(text: string): void; close(): void };

export function createSplashWindow(colors: ChromeColors, icon: string | undefined): SplashWindow {
  const win = new BrowserWindow({
    ...(icon ? { icon } : {}),
    width: 420,
    height: 220,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    center: true,
    backgroundColor: colors.background,
    title: "Starting Periskopos",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });

  let loaded = false;
  let pending: string | null = null;
  let closed = false;

  const apply = (text: string): void => {
    if (closed || win.isDestroyed()) return;
    // JSON-encoded: the status carries errors and file paths verbatim.
    void win.webContents
      .executeJavaScript(`document.getElementById("status").textContent = ${JSON.stringify(text)};`)
      .catch(() => {
        // A splash that can't render its status must never fail the launch.
      });
  };

  win.once("ready-to-show", () => {
    if (!closed) win.show();
  });
  win.webContents.once("did-finish-load", () => {
    loaded = true;
    if (pending !== null) apply(pending);
  });
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml(colors))}`);

  return {
    setStatus(text) {
      if (loaded) apply(text);
      else pending = text;
    },
    close() {
      closed = true;
      if (!win.isDestroyed()) win.destroy();
    },
  };
}
