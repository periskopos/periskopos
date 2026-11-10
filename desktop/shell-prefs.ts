// What this computer's app remembers about itself, beside the window's place:
// its theme and what closing the window does. A small file in Electron's
// profile, read before the first window opens. A corrupt file is never an error.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ShellPrefs } from "../shared/desktop.ts";

export const DEFAULT_SHELL_PREFS: ShellPrefs = { theme: "system", onClose: "tray" };

const FILE = "shell-prefs.json";

export function sanitizeShellPrefs(raw: unknown): ShellPrefs {
  const given = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    theme: given.theme === "light" || given.theme === "dark" ? given.theme : DEFAULT_SHELL_PREFS.theme,
    onClose: given.onClose === "quit" ? "quit" : DEFAULT_SHELL_PREFS.onClose,
  };
}

export function readShellPrefs(userData: string): ShellPrefs {
  try {
    return sanitizeShellPrefs(JSON.parse(readFileSync(join(userData, FILE), "utf8")));
  } catch {
    return { ...DEFAULT_SHELL_PREFS };
  }
}

// Whether it was kept. In use for now either way.
export function writeShellPrefs(userData: string, prefs: ShellPrefs): boolean {
  try {
    mkdirSync(userData, { recursive: true });
    writeFileSync(join(userData, FILE), `${JSON.stringify(prefs)}\n`);
    return true;
  } catch {
    return false;
  }
}
