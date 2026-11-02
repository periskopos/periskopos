// Remember the window's size, position and maximized state across launches.
// Restoring blind is worse than not restoring: a window saved on a monitor
// that's since been unplugged would reopen off-screen, so a saved position is
// used only if it still lands on a connected display.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type WindowState = { x?: number; y?: number; width: number; height: number; maximized: boolean };
export type DisplayBounds = { x: number; y: number; width: number; height: number };

export const DEFAULT_WINDOW_STATE: WindowState = { width: 1200, height: 780, maximized: false };

// The page is responsive down to a phone; below this a desktop window is silly.
export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 560;

const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isFinitePositive = (v: unknown): v is number => isFiniteNumber(v) && v > 0;

// Enough of the title bar on a display to grab it.
export function isPositionVisible(x: number, y: number, width: number, displays: readonly DisplayBounds[]): boolean {
  const GRAB = 80;
  return displays.some(
    (d) => x + width - GRAB > d.x && x + GRAB < d.x + d.width && y >= d.y - 1 && y < d.y + d.height - GRAB,
  );
}

// Whatever is on disk becomes a usable state; a corrupt file is never an error.
export function sanitizeWindowState(raw: unknown, displays: readonly DisplayBounds[]): WindowState {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_WINDOW_STATE };
  const c = raw as Record<string, unknown>;
  const state: WindowState = {
    width: isFinitePositive(c.width) ? Math.max(MIN_WIDTH, Math.round(c.width)) : DEFAULT_WINDOW_STATE.width,
    height: isFinitePositive(c.height) ? Math.max(MIN_HEIGHT, Math.round(c.height)) : DEFAULT_WINDOW_STATE.height,
    maximized: c.maximized === true,
  };
  if (isFiniteNumber(c.x) && isFiniteNumber(c.y)) {
    const x = Math.round(c.x);
    const y = Math.round(c.y);
    if (isPositionVisible(x, y, state.width, displays)) Object.assign(state, { x, y });
  }
  return state;
}

const stateFile = (dir: string) => join(dir, "window-state.json");

export function readWindowState(dir: string, displays: readonly DisplayBounds[]): WindowState {
  const file = stateFile(dir);
  if (!existsSync(file)) return { ...DEFAULT_WINDOW_STATE };
  try {
    return sanitizeWindowState(JSON.parse(readFileSync(file, "utf8")), displays);
  } catch {
    return { ...DEFAULT_WINDOW_STATE };
  }
}

export function writeWindowState(dir: string, state: WindowState): void {
  try {
    mkdirSync(dirname(stateFile(dir)), { recursive: true });
    writeFileSync(stateFile(dir), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Losing the remembered geometry is not worth failing a quit over.
  }
}
