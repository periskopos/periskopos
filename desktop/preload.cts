// The only bridge between the page and the shell. Kept deliberately tiny and
// product-free (see ipc-channels.ts). The page also runs in an ordinary
// browser tab, so every call site treats `window.periskoposShell` as
// optional.
//
// A sandboxed preload has to be CommonJS and can't be type-stripped by
// Electron, so build/build-preload.ts strips this file's types into
// build/preload.cjs (npm run desktop does it). That limits it to erasable
// syntax and `require`, and to the channel names repeated below (a test keeps
// them equal to ipc-channels.ts).
const { contextBridge, ipcRenderer } = require("electron") as typeof import("electron");

type Colors = { background: string; foreground: string; accent: string };

contextBridge.exposeInMainWorld("periskoposShell", {
  platform: process.platform,

  // The shell asking the page to go somewhere (a notification or a link was clicked).
  onNavigate(handler: (route: string) => void): void {
    ipcRenderer.on("periskopos:navigate", (_event, route: unknown) => {
      if (typeof route === "string") handler(route);
    });
  },

  // What colour the page is painted, so the next cold start opens in it.
  setChromeColors(colors: Colors): void {
    ipcRenderer.send("periskopos:set-chrome-colors", colors);
  },

  openLogs(): void {
    ipcRenderer.send("periskopos:open-logs");
  },
  openBackups(): void {
    ipcRenderer.send("periskopos:open-backups");
  },

  // Window controls: the page draws its own title bar.
  hardReloadWindow(): void {
    ipcRenderer.send("periskopos:window-hard-reload");
  },
  minimizeWindow(): void {
    ipcRenderer.send("periskopos:window-minimize");
  },
  toggleMaximizeWindow(): void {
    ipcRenderer.send("periskopos:window-toggle-maximize");
  },
  closeWindow(): void {
    ipcRenderer.send("periskopos:window-close");
  },
  showMenu(x: number, y: number): void {
    ipcRenderer.send("periskopos:window-menu", { x, y });
  },
  getMaximized(handler: (maximized: boolean) => void): void {
    ipcRenderer.once("periskopos:window-maximized-state", (_event, maximized: unknown) => {
      handler(maximized === true);
    });
    ipcRenderer.send("periskopos:window-get-maximized");
  },
  onMaximizedChange(handler: (maximized: boolean) => void): void {
    ipcRenderer.on("periskopos:window-maximized-state", (_event, maximized: unknown) => {
      handler(maximized === true);
    });
  },

  // Updates: where the updater stands, now and whenever it changes, and
  // asking it to check, install or download. The page checks the shape.
  onUpdateState(handler: (snapshot: unknown) => void): void {
    ipcRenderer.on("periskopos:update-state", (_event, snapshot: unknown) => handler(snapshot));
    ipcRenderer.send("periskopos:update-get");
  },
  updateAction(action: string): void {
    ipcRenderer.send("periskopos:update-act", action);
  },

  // Start at login: whether it can be changed here and whether it's on, now
  // or after switching it. The page checks the shape.
  getStartAtLogin(handler: (state: unknown) => void): void {
    ipcRenderer.once("periskopos:login-item-state", (_event, state: unknown) => handler(state));
    ipcRenderer.send("periskopos:login-item-get");
  },
  setStartAtLogin(on: boolean, handler: (state: unknown) => void): void {
    ipcRenderer.once("periskopos:login-item-state", (_event, state: unknown) => handler(state));
    ipcRenderer.send("periskopos:login-item-set", on === true);
  },
});
