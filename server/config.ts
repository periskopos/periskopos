import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// PERISKOPOS_DATA_DIR points a run at another registry, e.g. for trying things out
// without touching the real one.
export const DATA_DIR = process.env.PERISKOPOS_DATA_DIR
  ? path.resolve(process.env.PERISKOPOS_DATA_DIR)
  : path.join(ROOT, "data");
// My own per-user folder for Periskopos, outside any project, so an
// agent working in a repo never comes across the keys (docs/AGENT-SAFETY.md
// §4.3). The installed desktop app uses the same folder.
export function userAppDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "Periskopos");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "Periskopos");
  return path.join(env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "Periskopos");
}

// The installed desktop app's data folder: Electron's folder for an app
// named "periskopos", with data/ inside (desktop/paths.ts).
export function installedAppDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  const base =
    platform === "win32"
      ? (env.APPDATA ?? path.join(home, "AppData", "Roaming"))
      : platform === "darwin"
        ? path.join(home, "Library", "Application Support")
        : (env.XDG_CONFIG_HOME ?? path.join(home, ".config"));
  return path.join(base, "periskopos", "data");
}

export const DIST_WEB = path.join(ROOT, "dist", "web");
export const VERSION = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
// What Periskopos calls itself to the providers and sites it reads.
export const APP_USER_AGENT = `Periskopos/${VERSION}`;

// Only ever 127.0.0.1 (NFR-SEC1).
export const HOST = "127.0.0.1";
export const PORT = Number(process.env.PERISKOPOS_PORT ?? 4100);
