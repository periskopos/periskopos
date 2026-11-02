import type { MenuItemConstructorOptions } from "electron";

// The application menu, built without importing electron at runtime so the
// wiring can be tested. Without one, Electron's stock menu ships: no Ground
// Control actions, and a Help item pointing at electronjs.org. On Windows the
// frameless window shows no menu bar, but the accelerators (reload, zoom,
// copy and paste) still work.

export type MenuCommand = "about" | "check-updates" | "open-window" | "show-logs" | "open-data" | "open-docs" | "report-issue";

export type MenuContext = {
  isPackaged: boolean; // DevTools is a development affordance, not a shipped feature
  platform: NodeJS.Platform;
};

export const DOCS_URL = "https://periskopos.com/docs/";
export const ISSUES_URL = "https://github.com/periskopos/periskopos/issues";

export function buildMenuTemplate(context: MenuContext, run: (command: MenuCommand) => void): MenuItemConstructorOptions[] {
  const isMac = context.platform === "darwin";

  const appItems: MenuItemConstructorOptions[] = [
    { label: "About Periskopos", click: () => run("about") },
    ...(context.isPackaged ? ([{ label: "Check for updates…", click: () => run("check-updates") }] satisfies MenuItemConstructorOptions[]) : []),
    { type: "separator" },
    { label: "Show log", click: () => run("show-logs") },
    { label: "Open data folder", click: () => run("open-data") },
    { type: "separator" },
    ...(isMac
      ? ([{ role: "hide" }, { role: "hideOthers" }, { role: "unhide" }, { type: "separator" }] satisfies MenuItemConstructorOptions[])
      : []),
    { role: "quit", label: "Quit Periskopos" },
  ];

  const viewItems: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    ...(context.isPackaged ? [] : ([{ role: "toggleDevTools" }] satisfies MenuItemConstructorOptions[])),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];

  return [
    { label: isMac ? "Periskopos" : "&File", submenu: appItems },
    { role: "editMenu" },
    { label: "&View", submenu: viewItems },
    { role: "windowMenu" },
    {
      label: "&Help",
      submenu: [
        { label: "Periskopos README", click: () => run("open-docs") },
        { label: "Report an issue", click: () => run("report-issue") },
      ],
    },
  ];
}
