// Screenshots and a walkthrough video of the demo (scripts/demo.ts), in light
// and dark, from a hidden window:
//
//   npm run shots -- [shots|video|all] [--out <folder>] [--only <name>] [--version 0.5.0] [--port 4199]
//
// It starts a fresh demo of its own for the run and stops it after, so the
// made-up history is never old enough to show as late (the demo runs no checks,
// so after a while its apps turn to "No recent data"). --port uses a demo
// that's already running there instead, for trying things by hand.
// --only takes the shots whose names start with it (--only world: the World's).
// --version 0.5.0 shows that version wherever the app shows its own, so shots taken
// before a release match it. They go out only once that version is published.
// Before each shot the page is checked: the version, and nothing late, failed or
// still loading. A shot that fails is still saved, and the run ends with an
// error naming it, so a bad picture is never mistaken for a good one.
// periskopos.com's `npm run shots -- <out>` turns the captures into the site's
// images and video and the README's GIFs.
// Screenshots are 1440×900 pages at 2× (and the whole page when it's
// taller), rendered offscreen so the window isn't held to the screen's size; the video is 1280×800 at 1.5×, 30 fps, encoded by ffmpeg.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, nativeTheme, session } from "electron";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
// Its own demo, unless one already running on --port is to be used.
const OWN = !opt("--port");
const DEMO = path.join(ROOT, "data", OWN ? "demo-capture" : "demo");
const PORT = Number(opt("--port") ?? 4299);
const MODE = args.find((a) => ["shots", "video", "all"].includes(a)) ?? "all";
const OUT = path.resolve(opt("--out") ?? path.join(ROOT, "data", "captures"));
const ONLY = opt("--only") ?? "";
const ORIGIN = `http://127.0.0.1:${PORT}`;
let KEY = ""; // read once the demo is serving
const THEMES = ["light", "dark"] as const;
type Theme = (typeof THEMES)[number];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Its own profile: never the dev or installed app's.
app.setPath("userData", path.join(ROOT, "data", "demo-capture-profile"));
app.disableHardwareAcceleration();

// What runs in the page: a pointer that glides to things and clicks them,
// found by their text, for the video.
const PAGE_HELPERS = `(() => {
  if (window.__demo) return;
  const cursor = document.createElement("div");
  cursor.innerHTML = '<svg width="22" height="28" viewBox="0 0 22 28"><path d="M2 2 L2 22 L7.5 17 L11 25.5 L14.5 24 L11 15.5 L18.5 15.5 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(900px, 640px)", transition: "transform 0ms", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" });
  const ring = document.createElement("div");
  Object.assign(ring.style, { position: "fixed", left: "-14px", top: "-14px", width: "28px", height: "28px", borderRadius: "50%", background: "rgba(80,140,255,.35)", zIndex: "2147483646", pointerEvents: "none", opacity: "0", transition: "opacity 250ms, transform 250ms" });
  document.documentElement.append(ring, cursor);
  let x = 900, y = 640;
  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight; };
  const find = (text, within) => {
    const all = [...document.querySelectorAll(within ?? "a, button, [role=tab], [role=button], tr, li, h1, h2, h3, span, div")];
    const hits = all.filter((el) => visible(el) && el.textContent.trim().startsWith(text));
    hits.sort((a, b) => a.textContent.length - b.textContent.length);
    return hits[0];
  };
  window.__demo = {
    move(tx, ty, ms) {
      cursor.style.transition = "transform " + ms + "ms cubic-bezier(.45,.05,.25,1)";
      cursor.style.transform = "translate(" + tx + "px," + ty + "px)";
      x = tx; y = ty;
      return new Promise((r) => setTimeout(r, ms + 30));
    },
    async moveTo(text, within, ms = 700) {
      const el = find(text, within);
      if (!el) throw new Error("Not on the page: " + text);
      const r = el.getBoundingClientRect();
      await this.move(Math.round(r.left + Math.min(r.width / 2, 60)), Math.round(r.top + r.height / 2), ms);
      return el;
    },
    async click(text, within, ms) {
      const el = await this.moveTo(text, within, ms);
      ring.style.transform = "translate(" + x + "px," + y + "px) scale(.4)";
      ring.style.opacity = "1";
      await new Promise((r) => setTimeout(r, 120));
      ring.style.transform = "translate(" + x + "px," + y + "px) scale(1.2)";
      ring.style.opacity = "0";
      const target = el.closest("a, button, [role=tab], [role=button]") ?? el.querySelector("a") ?? el;
      target.click();
      await new Promise((r) => setTimeout(r, 200));
    },
    async scroll(dy, ms) {
      const box = [...document.querySelectorAll("*")].find((el) => el.scrollHeight > el.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) ?? document.scrollingElement;
      const start = box.scrollTop, t0 = performance.now();
      await new Promise((done) => {
        const step = (t) => {
          const k = Math.min(1, (t - t0) / ms);
          box.scrollTop = start + dy * (k < .5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
          k < 1 ? requestAnimationFrame(step) : done();
        };
        requestAnimationFrame(step);
      });
    },
  };
})()`;

// Paths on this PC (the checkout, the demo's folder, the home folder) shown as an installed
// copy's, so a capture never carries the folder or user name it was made on.
const PATHS: [string, string][] = [
  [path.join(DEMO, ".env.local"), "C:\\Users\\you\\AppData\\Roaming\\Periskopos\\.env.local"],
  [DEMO, "C:\\Users\\you\\AppData\\Roaming\\periskopos\\data"],
  [ROOT, "C:\\Users\\you\\AppData\\Local\\Programs\\periskopos\\resources\\app"],
  [os.homedir(), "C:\\Users\\you"],
];
// The version to show, in place of package.json's.
const VERSION = opt("--version");
const CURRENT = (JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { version: string }).version;
if (VERSION && !/^\d+\.\d+\.\d+$/.test(VERSION)) throw new Error(`--version wants a version such as 0.5.0, not ${VERSION}`);
// Each path also as it appears inside JSON (the MCP settings snippet).
const PAIRS = [
  ...PATHS.flatMap(([from, to]) => [[from, to], [JSON.stringify(from).slice(1, -1), JSON.stringify(to).slice(1, -1)]]),
  ...(VERSION ? [[CURRENT, VERSION]] : []),
];
// Kept up as the page redraws, by an observer set up once per window.
const MASK = `(() => {
  const pairs = ${JSON.stringify(PAIRS)};
  const swap = (s) => pairs.reduce((acc, [from, to]) => acc.split(from).join(to), s);
  const mask = () => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode()); ) { const next = swap(n.nodeValue); if (next !== n.nodeValue) n.nodeValue = next; }
    for (const el of document.querySelectorAll("input, textarea")) { const next = swap(el.value); if (next !== el.value) el.value = next; }
  };
  mask();
  if (!window.__masking) {
    window.__masking = new MutationObserver(mask);
    window.__masking.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
})()`;

// What the page must show for a shot to be right. Returns what's wrong.
const CHECK = `(() => {
  const wrong = [];
  const tag = document.querySelector(".version-tag")?.textContent?.trim();
  if (tag !== ${JSON.stringify(`v${VERSION ?? CURRENT}`)}) wrong.push("the version shows " + (tag ?? "nothing"));
  const text = document.body.innerText;
  if (/with no recent data/i.test(text)) wrong.push("the demo's history has gone stale");
  if (/Something went wrong/i.test(text)) wrong.push("an error page");
  if (/^\\s*Loading…\\s*$/m.test(text)) wrong.push("still loading");
  if (document.querySelector(".world-clouds")) wrong.push("the World is still under cloud");
  return wrong;
})()`;
const problems: string[] = [];

async function open(win: BrowserWindow, route: string) {
  await win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(route)}`);
  await wait(1400);
  if (route.startsWith("#/world")) {
    // The World opens under cloud, which lifts once its picture is drawn (8 s at
    // most), and the camera comes down as it thins: wait for both.
    for (let t = 0; t < 15000 && (await win.webContents.executeJavaScript(`!!document.querySelector(".world-clouds")`)); t += 250) await wait(250);
    await wait(2500);
  }
  await win.webContents.executeJavaScript(MASK);
  // A text the mask changed shows once the window paints again.
  await wait(300);
}

async function newWindow(theme: Theme, width: number, height: number, zoom: number, offscreen: boolean): Promise<BrowserWindow> {
  nativeTheme.themeSource = theme;
  const win = new BrowserWindow({
    show: false,
    width: width * zoom,
    height: height * zoom,
    useContentSize: true,
    backgroundColor: theme === "dark" ? "#0b0d10" : "#ffffff",
    webPreferences: { offscreen, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  // Asked for again once it exists: a new window is held to the screen's size.
  win.setContentSize(width * zoom, height * zoom);
  win.webContents.setZoomFactor(zoom);
  win.webContents.on("did-finish-load", () => {
    win.webContents.setZoomFactor(zoom);
    void win.webContents.insertCSS("::-webkit-scrollbar { display: none }");
  });
  // A load can fail while the previous window is still closing: try again.
  for (let attempt = 1; ; attempt++) {
    try {
      await win.loadURL(`${ORIGIN}/#/`);
      break;
    } catch (err) {
      if (attempt === 3) throw err;
      await wait(1000);
    }
  }
  await wait(1500);
  return win;
}

// ── Screenshots ─────────────────────────────────────────────────────────

// A third entry is run in the page once it's open, and the shot taken when
// the view has moved to what it chose.
const label = (text: string) => `[...document.querySelectorAll(".world-label")].find((b) => b.textContent.includes(${JSON.stringify(text)}))?.click()`;
const SHOTS: [string, string, string?][] = [
  ["apps", "#/"],
  ["app-overview", "#/apps/nova-shop"],
  ["app-attention", "#/apps/comet-mail"],
  ["app-deploying", "#/apps/moon-base"],
  ["app-deploys", "#/apps/nova-shop/deploys"],
  ["app-traffic", "#/apps/nova-shop/traffic"],
  ["app-configuration", "#/apps/nova-shop/config"],
  ["app-history", "#/apps/orbit-api/history"],
  ["status", "#/status"],
  ["accounts", "#/services"],
  // For the docs on periskopos.com
  ["add-app", "#/apps/new"],
  ["connect-account", "#/services/new"],
  ["app-actions", "#/apps/nova-shop/actions"],
  ["app-settings", "#/apps/nova-shop/settings"],
  ["app-connections", "#/apps/nova-shop/settings/connections"],
  ["app-protocol", "#/apps/nova-shop/settings/protocol"],
  ["settings", "#/settings"],
  ["settings-notifications", "#/settings/notifications"],
  ["settings-assistants", "#/settings/assistants"],
  ["settings-data", "#/settings/data"],
  ["world", "#/world"],
  ["world-campus", "#/world", label("Comet-Mail")],
  ["world-key", "#/world", `[...document.querySelectorAll("summary")].find((s) => s.textContent.startsWith("What am I looking at"))?.click()`],
  // Zoomed in a little more once it has turned to the dish, so no campus's label is left half hidden by the key at the edge.
  ["world-watcher", "#/world", `(async () => { ${label("The watcher")}; await new Promise((r) => setTimeout(r, 1500)); for (let i = 0; i < 2; i++) { [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "+")?.click(); await new Promise((r) => setTimeout(r, 400)); } })()`],
];

async function shots(theme: Theme) {
  const W = 1440, H = 900, Z = 2;
  const win = await newWindow(theme, W, H, Z, true);
  win.webContents.setFrameRate(10);
  for (const [name, route, act] of SHOTS.filter(([n]) => n.startsWith(ONLY))) {
    // Away and back, so the same page opens afresh.
    if (act) await open(win, "#/");
    await open(win, route);
    if (act) {
      await win.webContents.executeJavaScript(act);
      await wait(3500);
    }
    const wrong = (await win.webContents.executeJavaScript(CHECK)) as string[];
    if (wrong.length) problems.push(`${name}-${theme}: ${wrong.join(", ")}`);
    writeFileSync(path.join(OUT, `${name}-${theme}.png`), (await win.webContents.capturePage()).toPNG());
    // The whole page, when there's more of it than the window shows.
    const tall = (await win.webContents.executeJavaScript(
      "Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll('*')].filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY)).map((el) => el.scrollHeight + el.getBoundingClientRect().top))",
    )) as number;
    // Not the World: its map fills the window whatever is open over it.
    if (tall > H + 40 && route !== "#/world") {
      win.setContentSize(W * Z, Math.ceil(tall) * Z);
      await wait(900);
      writeFileSync(path.join(OUT, `${name}-${theme}-full.png`), (await win.webContents.capturePage()).toPNG());
      win.setContentSize(W * Z, H * Z);
      await wait(400);
    }
    console.log(`${name}-${theme}`);
  }
  win.destroy();
}

// ── The video ───────────────────────────────────────────────────────────

async function video(theme: Theme) {
  const W = 1280, H = 800, Z = 1.5, FPS = 30;
  const win = await newWindow(theme, W, H, Z, true);
  win.webContents.setFrameRate(FPS);
  let frame: Buffer | undefined;
  win.webContents.on("paint", (_e, _dirty, image) => {
    frame = image.toJPEG(92);
  });
  win.webContents.invalidate();
  await win.webContents.executeJavaScript(PAGE_HELPERS);
  // Paths and the version, kept up as the walk moves from page to page.
  await win.webContents.executeJavaScript(MASK);
  await wait(500);
  const wrong = (await win.webContents.executeJavaScript(CHECK)) as string[];
  if (wrong.length) problems.push(`walkthrough-${theme}: ${wrong.join(", ")}`);

  const file = path.join(OUT, `walkthrough-${theme}.mp4`);
  const ffmpeg = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-preset", "slow", "-movflags", "+faststart", file], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((r) => ffmpeg.on("close", r));
  // A steady 30 fps whatever the page paints: the newest frame, as often
  // as the clock says.
  const t0 = Date.now();
  let written = 0;
  const pump = setInterval(() => {
    const due = Math.floor(((Date.now() - t0) / 1000) * FPS);
    while (frame && written < due) {
      ffmpeg.stdin.write(frame);
      written++;
    }
  }, 10);

  const js = (code: string) => win.webContents.executeJavaScript(code);
  const click = (text: string, within?: string, ms = 800) => js(`__demo.click(${JSON.stringify(text)}, ${JSON.stringify(within ?? null)} ?? undefined, ${ms})`);
  const hover = (text: string, within?: string, ms = 800) => js(`__demo.moveTo(${JSON.stringify(text)}, ${JSON.stringify(within ?? null)} ?? undefined, ${ms}).then(() => true)`);
  const scroll = (dy: number, ms: number) => js(`__demo.scroll(${dy}, ${ms})`);

  await wait(1800);
  await hover("Nova-Shop", "a, td, div, span", 900);
  await wait(500);
  await hover("Comet-Mail", "a, td, div, span", 700);
  await wait(700);
  await click("Comet-Mail", "a, td, div, span", 400);
  await wait(2600);
  await scroll(360, 1600);
  await wait(1400);
  await click("Configuration", "a, button, [role=tab]");
  await wait(2800);
  await click("Apps", "nav a");
  await wait(1400);
  await click("Nova-Shop", "a, td, div, span");
  await wait(2000);
  await click("Deploys", "a, button, [role=tab]");
  await wait(2600);
  await click("Traffic", "a, button, [role=tab]");
  await wait(2000);
  await scroll(520, 2200);
  await wait(1600);
  await scroll(-520, 1000);
  await click("Configuration", "a, button, [role=tab]");
  await wait(3000);
  await click("Status", "nav a");
  await wait(2600);
  await click("Accounts", "nav a");
  await wait(2600);
  await click("Apps", "nav a");
  await wait(2200);

  clearInterval(pump);
  ffmpeg.stdin.end();
  await done;
  win.destroy();
  console.log(`walkthrough-${theme}.mp4 (${(written / FPS).toFixed(1)} s)`);
}

// Each theme closes its window before the next one opens: that's not the end.
app.on("window-all-closed", () => {});

// A fresh demo for this run, in its own folder and on its own port; resolves
// once it's serving.
function startDemo(): Promise<ChildProcess> {
  const demo = spawn("node", [path.join(ROOT, "scripts", "demo.ts"), "--fresh", "--port", String(PORT), "--dir", path.relative(ROOT, DEMO)], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The demo didn't start in 60 s")), 60_000);
    demo.on("exit", (code) => reject(new Error(`The demo stopped (exit ${code}) before it was serving`)));
    demo.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("Demo Periskopos at")) {
        clearTimeout(timer);
        resolve(demo);
      }
    });
  });
}

app.whenReady().then(async () => {
  let demo: ChildProcess | undefined;
  try {
    if (OWN) demo = await startDemo();
    KEY = readFileSync(path.join(DEMO, "session-key"), "utf8").trim();
    mkdirSync(OUT, { recursive: true });
    await session.defaultSession.cookies.set({ url: ORIGIN, name: "periskopos_session", value: KEY, httpOnly: true, sameSite: "strict" });
    for (const theme of THEMES) {
      if (MODE !== "video") await shots(theme);
      if (MODE !== "shots") await video(theme);
    }
    console.log(`Saved in ${OUT}`);
    if (problems.length) {
      console.error(`\nNot right, so not for use (${problems.length}):\n  ${problems.join("\n  ")}`);
      process.exitCode = 1;
    } else console.log("Every shot checked: the right version, and nothing late, failed or loading.");
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  }
  demo?.kill();
  app.quit();
});
