import { existsSync } from "node:fs";
import path from "node:path";

// Which icon file a surface should use. Windows window and taskbar icons want
// the multi-resolution .ico so the shell picks a real size; the tray and
// notifications read the 512 px PNG and resize it themselves. Pure, so it can
// be tested outside Electron.
export type IconSurface = "window" | "tray" | "notification";

export function iconCandidates(dir: string, surface: IconSurface, platform: string = process.platform): string[] {
  const names = surface === "window" && platform === "win32" ? ["icon.ico", "icon.png"] : ["icon.png", "icon.ico"];
  return names.map((name) => path.join(dir, name));
}

export function pickIcon(candidates: readonly string[], exists: (file: string) => boolean = existsSync): string | undefined {
  return candidates.find((file) => exists(file));
}
