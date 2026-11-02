// Renders desktop/resources/icon.svg into the icons the installers need:
// desktop/build/icon.png (512 px, also the tray and window icon) and
// desktop/build/icon.ico (Windows). Run by Electron itself, so it needs no
// image library: `electron desktop/build/prepare-icon.ts` (npm run prepare-icon).
import { app, BrowserWindow } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeIco } from "./ico.ts";
import { MENU_ICONS, menuIconName, menuIconSvg } from "../menu-icons.ts";
import type { Tone } from "../menu-icons.ts";
import { DOTS, TRAY_VARIANTS, dotIconName, dotSvg, trayIconName, trayIconSvg } from "../tray-glance.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(path.join(here, "..", "resources", "icon.svg"), "utf8");
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const SIZE = 1024; // render large, then scale down so every size stays crisp

app.disableHardwareAcceleration();

void app.whenReady().then(async () => {
  // enableLargerThanScreen: on a build machine with a small screen (GitHub's
  // Windows runners) the window is otherwise shrunk to fit, the capture comes
  // out short, and the icon is stretched into an oval.
  const win = new BrowserWindow({ show: false, width: SIZE, height: SIZE, useContentSize: true, enableLargerThanScreen: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  win.setContentSize(SIZE, SIZE);
  const page = `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{width:${SIZE}px;height:${SIZE}px;display:block}</style>${svg}`;
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
  await new Promise((r) => setTimeout(r, 400));
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
  if (image.isEmpty()) throw new Error("prepare-icon: the icon rendered empty");
  // Never ship a squashed icon: anything but a square capture is a failed build.
  const { width, height } = image.getSize();
  if (width !== height || width < 512) {
    console.error(`[prepare-icon] the capture is ${width}×${height}, not a square of at least 512 px; refusing to write a distorted icon`);
    app.exit(1);
    return;
  }

  const out = path.join(here);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "icon.png"), image.resize({ width: 512, height: 512, quality: "best" }).toPNG());
  const frames = ICO_SIZES.map((s) => image.resize({ width: s, height: s, quality: "best" }).toPNG());
  writeFileSync(path.join(out, "icon.ico"), encodeIco(frames, ICO_SIZES));
  console.log(`[prepare-icon] wrote icon.png (512 px) and icon.ico (${ICO_SIZES.join(", ")} px)`);

  // The rest go through the same window: rendered large, then written at
  // 16 px and @2x for high-DPI screens (Electron picks up `name@2x.png`).
  const menuDir = path.join(here, "menu");
  mkdirSync(menuDir, { recursive: true });
  const small = async (markup: string, name: string, what: string) => {
    const page = `<style>html,body{margin:0;background:transparent;overflow:hidden}svg{width:${SIZE}px;height:${SIZE}px;display:block}</style>${markup}`;
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    await new Promise((r) => setTimeout(r, 150));
    const shot = await win.webContents.capturePage({ x: 0, y: 0, width: SIZE, height: SIZE });
    if (shot.isEmpty()) throw new Error(`prepare-icon: the ${what} rendered empty`);
    writeFileSync(path.join(menuDir, name), shot.resize({ width: 16, height: 16, quality: "best" }).toPNG());
    writeFileSync(path.join(menuDir, name.replace(/\.png$/, "@2x.png")), shot.resize({ width: 32, height: 32, quality: "best" }).toPNG());
  };

  // The tray menu's icons, each for light and for dark menus.
  const tones: Tone[] = ["dark", "light"];
  for (const icon of MENU_ICONS) {
    for (const tone of tones) await small(menuIconSvg(icon, tone), menuIconName(icon, tone), `${icon} menu icon`);
  }
  // The glance's status dots, one per state, for light and for dark menus.
  for (const dot of DOTS) {
    for (const tone of tones) await small(dotSvg(dot, tone), dotIconName(dot, tone), `${dot} status dot`);
  }
  // The tray icon when something is wrong: the mark with a red or amber dot.
  for (const variant of TRAY_VARIANTS) await small(trayIconSvg(svg, variant), trayIconName(variant), `${variant} tray icon`);
  console.log(
    `[prepare-icon] wrote ${MENU_ICONS.length * 2} menu icons, ${DOTS.length * 2} status dots and ${TRAY_VARIANTS.length} tray icons (16 px and @2x) in desktop/build/menu`,
  );
  app.quit();
});
