import path from "node:path";
import { fileURLToPath } from "node:url";
import { userAppDir } from "../server/config.ts";
import { iconCandidates, pickIcon } from "./icon-file.ts";
import type { IconSurface } from "./icon-file.ts";

// The folder holding desktop/, server/ and the rest: the repo when run from a
// checkout, the app's own folder when installed.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Installed, Periskopos listens on 4100; run from a checkout (npm run
// dev), on 4101, so the two can be open at once. PERISKOPOS_PORT overrides either.
export const INSTALLED_PORT = 4100;
export const DEV_PORT = 4101;
export const portFor = (isPackaged: boolean, env: NodeJS.ProcessEnv = process.env): number =>
  Number(env.PERISKOPOS_PORT ?? (isPackaged ? INSTALLED_PORT : DEV_PORT));
export const originFor = (port: number): string => `http://127.0.0.1:${port}`;

// Electron's profile folder for a run from a checkout. Its own, not the
// installed app's: the single-instance lock is tied to this folder, so with
// one shared, `npm run dev` would just hand itself over to the installed
// app; and the window's place and the caches stay apart too.
export const devUserData = (appData: string): string => path.join(appData, "periskopos-dev");

// Where the registry and keys live. From a checkout the registry stays in
// the repo's data/, so the app and `npm run dev` share one, and the keys are
// wherever the server puts them (the profile's Periskopos folder).
// Installed, the registry is in data/ inside Electron's own profile folder
// (for the app named "periskopos"), and the keys are in the Periskopos
// folder the server and the README use. On Windows and macOS, whose file
// names ignore case, those are one folder; on Linux, two.
export function dataPaths(
  isPackaged: boolean,
  userData: string,
  appDir: string = userAppDir(),
): { dataDir: string; envFile: string | undefined } {
  if (!isPackaged) {
    return { dataDir: process.env.PERISKOPOS_DATA_DIR ? path.resolve(process.env.PERISKOPOS_DATA_DIR) : path.join(ROOT, "data"), envFile: process.env.PERISKOPOS_ENV_FILE };
  }
  return { dataDir: path.join(userData, "data"), envFile: process.env.PERISKOPOS_ENV_FILE ?? path.join(appDir, ".env.local") };
}

// The app mark, as prepared by prepare-icon (a checkout that never ran it has
// none, and every caller treats that as "no icon", never a failure).
export function iconFor(surface: IconSurface, isPackaged: boolean, resourcesPath: string): string | undefined {
  const dir = isPackaged ? resourcesPath : path.join(ROOT, "desktop", "build");
  return pickIcon(iconCandidates(dir, surface));
}

// The page's bridge to the shell, made from preload.cts by build-preload.ts.
export const PRELOAD = path.join(ROOT, "desktop", "build", "preload.cjs");

// Windows attributes notifications, and sends their clicks, by this id. A
// development or test run gets its own: Electron gives the bare electron.exe
// it runs from a Start Menu shortcut with the id it's given, and if that were
// the installed app's, clicking the installed app's notifications would open
// a bare Electron window instead.
// It was local.periskopos.app until 0.3.5. The installer keeps the uninstall
// entry the old id gave it (package.json build.nsis.guid, which
// electron-builder would otherwise derive from the id), so an update still
// replaces the installed copy instead of adding a second one.
export const APP_ID = "com.periskopos.app";
export const notificationAppId = (isPackaged: boolean): string => (isPackaged ? APP_ID : `${APP_ID}.dev`);
