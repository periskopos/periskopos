import { Menu, Tray, nativeImage, nativeTheme } from "electron";
import type { MenuItemConstructorOptions, NativeImage } from "electron";
import path from "node:path";
import { menuIconFile } from "./menu-icons.ts";
import type { MenuIcon } from "./menu-icons.ts";
import { TEXT_MARKER, dotIconFile, glanceKey, menuText, trayIconName } from "./tray-glance.ts";
import type { Dot, Glance, TrayVariant } from "./tray-glance.ts";
import type { TrayUpdateItem } from "./update-plan.ts";

export type TrayHandlers = {
  show: () => void;
  // Opens the window on a page of its own (#/apps/star-map).
  open: (route: string) => void;
  openDataFolder: () => void;
  quit: () => void;
  // undefined: not offered (a checkout's app must not register itself).
  loginItem: { enabled: boolean; set: (on: boolean) => void } | undefined;
  // The updater's line (check, downloading, restart to update) and its click.
  update: () => TrayUpdateItem;
  onUpdate: (action: NonNullable<TrayUpdateItem["action"]>) => void;
  // Shuts every AI assistant out at once (Settings turns them back on).
  cutOffAssistants?: () => void;
};

let tray: Tray | null = null;
let handlers: TrayHandlers | null = null;
let tooltip = "Periskopos";
let iconDir: string | undefined;
let baseIcon: NativeImage | null = null;
let shownVariant: TrayVariant = "normal";
// The apps, as the last refresh saw them; none until the first one answers.
let glance: Glance | undefined;
let shownGlance = "";

// One of the menu's icons, in the shade that reads on the menu as it is now
// (light or dark), or none if it wasn't built (a checkout that never ran
// prepare-icon). A Mac recolours a template image itself.
function icon(name: MenuIcon): { icon: NativeImage } | Record<string, never> {
  if (!iconDir) return {};
  const image = nativeImage.createFromPath(menuIconFile(iconDir, name, nativeTheme.shouldUseDarkColors));
  if (image.isEmpty()) return {};
  if (process.platform === "darwin") image.setTemplateImage(true);
  return { icon: image };
}

// A state's coloured dot, or (without the images) its marker in the text.
function dotted(label: string, dot: Dot): { label: string; icon?: NativeImage } {
  const image = iconDir ? nativeImage.createFromPath(dotIconFile(iconDir, dot, nativeTheme.shouldUseDarkColors)) : undefined;
  return image && !image.isEmpty() ? { label: menuText(label), icon: image } : { label: menuText(`${TEXT_MARKER[dot]}  ${label}`) };
}

// The glance above the app's own items: the headline, then each app,
// problems first. Each opens its page.
function glanceItems(h: TrayHandlers): MenuItemConstructorOptions[] {
  if (!glance) return [];
  const g = glance;
  return [
    { ...dotted(g.headline.label, g.headline.dot), click: () => h.open("#/") },
    { type: "separator" },
    ...g.lines.map((line): MenuItemConstructorOptions => ({ ...dotted(line.label, line.dot), click: () => h.open(line.route) })),
    ...(g.more ? [{ label: menuText(g.more.label), click: () => h.open(g.more?.route ?? "#/") }] : []),
    { type: "separator" },
  ];
}

// Start at login shows its state in its icon (a ticked circle when on), like
// the rows around it: Windows draws a tick or an icon there, not both.
// Without the images the state goes in the words instead.
function loginItemEntry(item: TrayHandlers["loginItem"]): MenuItemConstructorOptions {
  if (!item) return { label: "Start at login (installed app only)", enabled: false };
  const on = item.enabled;
  const image = icon(on ? "login-on" : "login-off");
  return { label: "icon" in image ? "Start at login" : `Start at login: ${on ? "on" : "off"}`, click: () => item.set(!on), ...image };
}

function menu(h: TrayHandlers) {
  const update = h.update();
  return Menu.buildFromTemplate([
    ...glanceItems(h),
    { label: "Open Periskopos", click: h.show, ...icon("open") },
    { type: "separator" },
    { label: update.label, enabled: update.enabled, click: () => update.action && h.onUpdate(update.action), ...icon(update.action === "install" || update.action === "download" ? "download" : "check") },
    loginItemEntry(h.loginItem),
    ...(h.cutOffAssistants ? [{ label: "Cut off AI assistants", click: h.cutOffAssistants }] : []),
    { label: "Open data folder", click: h.openDataFolder, ...icon("folder") },
    { type: "separator" },
    { label: "Quit Periskopos", click: h.quit, ...icon("quit") },
  ]);
}

export function installTray(iconFile: string | undefined, h: TrayHandlers, menuIcons?: string): void {
  if (tray || !iconFile) return;
  iconDir = menuIcons;
  const icon = nativeImage.createFromPath(iconFile);
  if (icon.isEmpty()) return;
  handlers = h;
  baseIcon = icon.resize({ width: 16, height: 16 }); // a full-size icon renders blurry in a tray
  tray = new Tray(baseIcon);
  tray.setToolTip(tooltip);
  tray.setContextMenu(menu(h));
  tray.on("click", h.show);
  // Windows switching between light and dark: redraw the icons to match.
  nativeTheme.on("updated", refreshTrayMenu);
}

// Whether there is a tray to hide the window to; without one, hiding would
// leave the app running with no way back.
export const hasTray = (): boolean => tray !== null;

export function setTrayTooltip(text: string): void {
  tooltip = text;
  tray?.setToolTip(text);
}

// The menu is rebuilt when "start at login" or the updater's state changes.
export function refreshTrayMenu(): void {
  if (tray && handlers) tray.setContextMenu(menu(handlers));
}

// The latest look at the apps. The menu is rebuilt only when what it shows
// changed (an open menu would otherwise flicker every minute), and the icon
// turns red or amber, from prepare-icon's variants, when something is wrong.
export function setTrayGlance(next: Glance, variant: TrayVariant): void {
  glance = next;
  const key = glanceKey(next);
  if (key !== shownGlance) {
    shownGlance = key;
    refreshTrayMenu();
  }
  if (variant !== shownVariant && tray && baseIcon) {
    const image = variant === "normal" || !iconDir ? baseIcon : nativeImage.createFromPath(path.join(iconDir, trayIconName(variant)));
    // Without the variant (a checkout that never ran prepare-icon) the plain
    // icon stays, and the tooltip still says what's wrong.
    tray.setImage(image.isEmpty() ? baseIcon : image);
    shownVariant = variant;
  }
}

export function destroyTray(): void {
  tray?.destroy();
  tray = null;
}
