// The complete set of shell <-> page channels. The product API is HTTP on the
// local server (the page is an ordinary client of it, like a browser tab);
// IPC carries shell concerns only: things a browser tab can't do. Nothing
// product-shaped belongs here.
//
// preload.cts can't import this file (a sandboxed preload is CommonJS and
// loads nothing else), so it repeats these strings, and a test keeps the two
// in step.

export const IPC_NAVIGATE = "periskopos:navigate"; // main -> page: go to a route
export const IPC_SET_CHROME_COLORS = "periskopos:set-chrome-colors";
export const IPC_OPEN_LOGS = "periskopos:open-logs";
export const IPC_OPEN_BACKUPS = "periskopos:open-backups"; // the database's copies, in the file manager

// The window is frameless on Windows and Linux: the page draws its own
// minimize / maximize / close, so they cross as ordinary commands.
export const IPC_WINDOW_MINIMIZE = "periskopos:window-minimize";
export const IPC_WINDOW_TOGGLE_MAXIMIZE = "periskopos:window-toggle-maximize";
export const IPC_WINDOW_CLOSE = "periskopos:window-close";
export const IPC_WINDOW_HARD_RELOAD = "periskopos:window-hard-reload";
export const IPC_WINDOW_GET_MAXIMIZED = "periskopos:window-get-maximized";
// With no native title bar there's no menu bar either: the page's menu
// button (or a tap of Alt) asks for the application menu, at a point in the
// page (CSS pixels).
export const IPC_WINDOW_MENU = "periskopos:window-menu";
// main -> page: sent on request and whenever it changes (an OS snap or a
// double-click on the title bar maximizes without the button).
export const IPC_WINDOW_MAXIMIZED_STATE = "periskopos:window-maximized-state";

// Updates: the window's update button reads where the updater stands, hears
// when it changes, and asks it to check, install or download. The updater
// itself stays in the shell.
export const IPC_UPDATE_GET = "periskopos:update-get";
export const IPC_UPDATE_STATE = "periskopos:update-state"; // main -> page: on request and on every change
export const IPC_UPDATE_ACT = "periskopos:update-act";

// Start at login is the system's setting, so the shell keeps it: the page
// asks for it, or to change it, and hears back whether it can be changed
// here (the installed app only) and whether it's on.
export const IPC_LOGIN_ITEM_GET = "periskopos:login-item-get";
export const IPC_LOGIN_ITEM_SET = "periskopos:login-item-set";
export const IPC_LOGIN_ITEM_STATE = "periskopos:login-item-state"; // main -> page: the answer to either

export const ALL_CHANNELS = [
  IPC_NAVIGATE,
  IPC_SET_CHROME_COLORS,
  IPC_OPEN_LOGS,
  IPC_OPEN_BACKUPS,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_TOGGLE_MAXIMIZE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_HARD_RELOAD,
  IPC_WINDOW_GET_MAXIMIZED,
  IPC_WINDOW_MENU,
  IPC_WINDOW_MAXIMIZED_STATE,
  IPC_UPDATE_GET,
  IPC_UPDATE_STATE,
  IPC_UPDATE_ACT,
  IPC_LOGIN_ITEM_GET,
  IPC_LOGIN_ITEM_SET,
  IPC_LOGIN_ITEM_STATE,
] as const;
