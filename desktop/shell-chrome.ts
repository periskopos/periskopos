// Remember the colour the app is actually painted in, so the shell can paint
// the same thing before the app exists.
//
// A window's backgroundColor is picked at creation, long before the page has
// loaded a stylesheet, and the splash has no page at all. The page is the only
// thing that knows the resolved colour (it follows the OS light/dark setting),
// so it reports it across the bridge after every appearance change and the
// shell reads it back at the next launch. One launch behind is the deliberate
// trade: a second copy of the palettes in shell code would drift.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type ChromeColors = {
  background: string; // window background before first paint
  foreground: string; // splash text and mark
  accent: string; // the one saturated colour: the splash's progress bar
};

// tokens.css's canvas, primary text and "info" colour, dark and light. Used
// until the page has reported once, and whenever the stored file is unusable.
export const DARK_CHROME_COLORS: ChromeColors = { background: "#0b0d10", foreground: "#e6e9ee", accent: "#58a6ff" };
export const LIGHT_CHROME_COLORS: ChromeColors = { background: "#f5f6f8", foreground: "#0f1419", accent: "#0b62d6" };

export const defaultChromeColors = (dark: boolean): ChromeColors => (dark ? DARK_CHROME_COLORS : LIGHT_CHROME_COLORS);

const FILE = "shell-chrome.json";

// Only #rgb / #rrggbb: anything else could be a CSS function the shell can't
// parse, or page-supplied text that shouldn't reach Electron.
export const isHexColor = (value: unknown): value is string =>
  typeof value === "string" && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);

export const chromeColorsPath = (dir: string): string => join(dir, FILE);

export function readChromeColors(dir: string, dark: boolean): ChromeColors {
  const fallback = defaultChromeColors(dark);
  const file = chromeColorsPath(dir);
  if (!existsSync(file)) return fallback;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return fallback;
    // Field by field, so a file that lacks one colour keeps the others.
    const record = parsed as Record<string, unknown>;
    const pick = (name: keyof ChromeColors): string => (isHexColor(record[name]) ? record[name] : fallback[name]);
    return { background: pick("background"), foreground: pick("foreground"), accent: pick("accent") };
  } catch {
    return fallback; // a truncated or hand-edited file must not stop a launch
  }
}

// False when the payload was rejected, so the caller can log it.
export function writeChromeColors(dir: string, colors: unknown): boolean {
  if (!colors || typeof colors !== "object") return false;
  const { background, foreground, accent } = colors as Record<string, unknown>;
  if (!isHexColor(background) || !isHexColor(foreground) || !isHexColor(accent)) return false;
  try {
    mkdirSync(dirname(chromeColorsPath(dir)), { recursive: true });
    writeFileSync(chromeColorsPath(dir), JSON.stringify({ background, foreground, accent }, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}
