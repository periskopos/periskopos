import path from "node:path";

// The tray menu's icons: simple line glyphs on a 24-unit grid, drawn by
// prepare-icon into 16 px PNGs (and @2x for high-DPI screens), one set for
// light menus and one for dark. Pure, so the choice of file can be tested
// outside Electron.

export type MenuIcon = "open" | "check" | "download" | "folder" | "quit" | "login-on" | "login-off";

const GLYPHS: Record<MenuIcon, string> = {
  // a window
  open: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/>',
  // an arrow coming round
  check: '<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>',
  // an arrow down into a tray
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  // a folder
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  // a power button
  quit: '<path d="M12 3v9"/><path d="M6.34 6.34a8 8 0 1 0 11.32 0"/>',
  // start at login, on: a ticked circle; off: the circle alone (the item's
  // state, since Windows draws a tick or an icon, not both)
  "login-on": '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  "login-off": '<circle cx="12" cy="12" r="9"/>',
};

export const MENU_ICONS = Object.keys(GLYPHS) as MenuIcon[];

// "dark" glyphs go on a light menu, "light" glyphs on a dark one.
export type Tone = "dark" | "light";
const INK: Record<Tone, string> = { dark: "#1f2328", light: "#e6e9ee" };

export function menuIconSvg(icon: MenuIcon, tone: Tone): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${INK[tone]}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[icon]}</svg>`;
}

// The file name for one icon; Electron picks up `name@2x.png` beside it.
export const menuIconName = (icon: MenuIcon, tone: Tone) => `menu-${icon}-${tone}.png`;

// Which file a menu should use. A Mac's menus recolour "template" images
// themselves, so it always gets the dark glyph (marked as a template by the
// caller); elsewhere the glyph is chosen against the menu's colour.
export function menuIconFile(dir: string, icon: MenuIcon, darkMenus: boolean, platform: string = process.platform): string {
  const tone: Tone = platform === "darwin" || !darkMenus ? "dark" : "light";
  return path.join(dir, menuIconName(icon, tone));
}

// Where they are: in the app's resources when installed, next to the build
// scripts in a checkout (where a missing file just means no icon).
export const menuIconDir = (isPackaged: boolean, resourcesPath: string, root: string): string =>
  isPackaged ? path.join(resourcesPath, "menu") : path.join(root, "desktop", "build", "menu");
