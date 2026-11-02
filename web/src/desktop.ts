// Optional access to the desktop app's shell.
//
// The page is served to ordinary browser tabs as well as to the desktop app,
// so the bridge is always optional and every call site works without it. It
// carries shell concerns only (window buttons, the colours the page is
// painted in, "go to this route"); anything product-shaped goes over HTTP like
// it does in a browser. See desktop/ipc-channels.ts.

import type { UpdateAction } from "../../shared/desktop.ts";

export type ShellColors = { background: string; foreground: string; accent: string };

export type DesktopBridge = {
  platform: string;
  onNavigate(handler: (route: string) => void): void;
  setChromeColors?: (colors: ShellColors) => void;
  openLogs?: () => void;
  openBackups?: () => void;
  hardReloadWindow?: () => void;
  minimizeWindow?: () => void;
  toggleMaximizeWindow?: () => void;
  closeWindow?: () => void;
  showMenu?: (x: number, y: number) => void;
  getMaximized?: (handler: (maximized: boolean) => void) => void;
  onMaximizedChange?: (handler: (maximized: boolean) => void) => void;
  onUpdateState?: (handler: (snapshot: unknown) => void) => void;
  updateAction?: (action: UpdateAction) => void;
  getStartAtLogin?: (handler: (state: unknown) => void) => void;
  setStartAtLogin?: (on: boolean, handler: (state: unknown) => void) => void;
};

// Start at login as the shell tells it: whether it can be changed from the
// page (the installed app only) and whether it's on.
export type LoginItemState = { available: boolean; enabled: boolean };

export function asLoginItemState(value: unknown): LoginItemState | null {
  if (typeof value !== "object" || value === null) return null;
  const { available, enabled } = value as Record<string, unknown>;
  return typeof available === "boolean" && typeof enabled === "boolean" ? { available, enabled } : null;
}

// The bridge, or null in a browser tab.
export function desktopBridge(): DesktopBridge | null {
  const candidate = (globalThis as { periskoposShell?: unknown }).periskoposShell;
  if (typeof candidate !== "object" || candidate === null) return null;
  const record = candidate as Record<string, unknown>;
  return typeof record.onNavigate === "function" && typeof record.platform === "string" ? (candidate as DesktopBridge) : null;
}

const isHex = (value: string): boolean => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);

// Tells the shell what colour the page resolved to, so the next cold start
// (window and splash) opens in it. Called on load and when the OS switches
// between light and dark.
export function publishShellColors(): void {
  const bridge = desktopBridge();
  if (!bridge?.setChromeColors) return;
  const styles = getComputedStyle(document.documentElement);
  const token = (name: string) => styles.getPropertyValue(name).trim();
  const colors = { background: token("--color-bg-canvas"), foreground: token("--color-text-primary"), accent: token("--color-status-info") };
  if (isHex(colors.background) && isHex(colors.foreground) && isHex(colors.accent)) bridge.setChromeColors(colors);
}

// Run once at start-up: marks the page as living in the app (so the top bar
// can be the title bar), keeps the shell's colours current, and lets it
// navigate (a clicked notification or periskopos:// link).
export function initDesktopShell(): void {
  const bridge = desktopBridge();
  if (!bridge) return;
  document.body.classList.add("is-desktop-shell", `is-${bridge.platform}`);
  publishShellColors();
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", publishShellColors);
  bridge.onNavigate((route) => {
    // Only a hash route, never a URL: the shell checks too, and so do we.
    if (/^#\/[a-z0-9\-/]{0,120}$/.test(route)) location.hash = route;
  });
}
