import { duskAt } from "../../../../shared/world.ts";
import type { Sky } from "./scene/types.ts";

// Coming down through cloud while the World gets ready. It covers the page for as long as
// the page really needs and a moment more, so that the first look isn't a picture popping in.
// All of it moves by CSS, on transform and opacity alone: those keep going on the compositor
// while the page is stuck building the scene, which is exactly when they're looked at.

const LAYERS = 6;
const CANVAS_W = 960;
const CANVAS_H = 540;
const PUFF = 128;

export const FIRST_LOOK_MS = 1300; // the shortest time it stays, the first time in this window
export const LOOK_AGAIN_MS = 600; // and after that
export const GIVE_UP_MS = 8000; // however it's going, the page isn't held behind cloud any longer
const LIFT_MS = 1150; // keep in step with the longest transition on .is-lifting in world.css
const FRAMES_TO_SEE = 3; // the first frames are the slow ones: past them, the picture is really up

// Whether the clouds may go. Never before the shortest time, unless there's nothing to wait for
// and no picture coming: then they're only in the way of what the page says instead.
export function cloudsMayLift(at: { elapsedMs: number; shortestMs: number; pictureUp: boolean; noPicture: boolean }): boolean {
  if (at.elapsedMs >= GIVE_UP_MS) return true;
  if (at.noPicture) return true;
  return at.pictureUp && at.elapsedMs >= at.shortestMs;
}

const COLORS = {
  day: { lit: "255,255,255", shade: "188,206,226" },
  dusk: { lit: "246,206,190", shade: "150,126,160" },
};

function puff(rgb: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = PUFF;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const glow = context.createRadialGradient(PUFF / 2, PUFF / 2, 0, PUFF / 2, PUFF / 2, PUFF / 2);
  glow.addColorStop(0, `rgba(${rgb},0.95)`);
  glow.addColorStop(0.5, `rgba(${rgb},0.8)`);
  glow.addColorStop(1, `rgba(${rgb},0)`);
  context.fillStyle = glow;
  context.fillRect(0, 0, PUFF, PUFF);
  return canvas;
}

// The same clouds every time: a small seeded generator, as these are only looks.
function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

// Banks of cloud round the edge with a way through the middle, as you'd fly between them.
// Each is a cumulus: a flat base, the big puffs heaped highest in the middle, shade underneath
// and small lit puffs along the top. Faded out before the canvas ends, so it has no edge to see.
function layer(seed: number, lit: HTMLCanvasElement, shade: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.className = "world-clouds-layer";
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const context = canvas.getContext("2d");
  if (!context) return canvas;
  const random = seeded(seed);
  const banks = 5;
  for (let bank = 0; bank < banks; bank++) {
    const angle = ((bank + random() * 0.8) / banks) * Math.PI * 2 + seed;
    const reach = 0.42 + random() * 0.26;
    const x = CANVAS_W / 2 + Math.cos(angle) * reach * (CANVAS_W / 2);
    const base = CANVAS_H / 2 + Math.sin(angle) * reach * (CANVAS_H / 2) + 50;
    const span = 130 + random() * 130;
    const place = (image: HTMLCanvasElement, across: number, up: number, size: number) => context.drawImage(image, x + across - size / 2, base - up - size / 2, size, size);
    const heap = Array.from({ length: 16 }, () => {
      const across = (random() * 2 - 1) * span;
      const middle = 1 - Math.abs(across) / span; // tallest and biggest in the middle of the bank
      return { across, up: random() * 95 * middle, size: 60 + 110 * middle * (0.6 + random() * 0.4) };
    });
    context.globalAlpha = 0.7;
    for (const p of heap) place(shade, p.across, p.up - p.size * 0.2, p.size * 1.1);
    context.globalAlpha = 1;
    for (const p of heap) place(lit, p.across, p.up + p.size * 0.1, p.size);
    for (const p of heap) {
      for (let i = 0; i < 3; i++) {
        const turn = random() * Math.PI; // the top half of the puff: the lit side
        place(lit, p.across + Math.cos(turn) * p.size * 0.38, p.up + p.size * 0.1 + Math.sin(turn) * p.size * 0.38, p.size * (0.22 + random() * 0.2));
      }
    }
  }
  context.globalCompositeOperation = "destination-in";
  context.setTransform(CANVAS_W / CANVAS_H, 0, 0, 1, 0, 0);
  const middle = CANVAS_H / 2;
  const fade = context.createRadialGradient(middle, middle, middle * 0.62, middle, middle, middle * 0.98);
  fade.addColorStop(0, "rgba(0,0,0,1)");
  fade.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = fade;
  context.fillRect(0, 0, CANVAS_H, CANVAS_H);
  return canvas;
}

export type Clouds = {
  el: HTMLElement;
  // Resolves once the clouds are on the screen, so they're already moving when the page sticks.
  painted(): Promise<void>;
  pictured(): void; // a frame of the World has been drawn, with what's in it
  noPicture(): void;
  destroy(): void;
};

let seenThisWindow = false;

export function createClouds(sky: Sky, lifting: () => void): Clouds {
  const startedAt = performance.now();
  const shortestMs = seenThisWindow ? LOOK_AGAIN_MS : FIRST_LOOK_MS;
  seenThisWindow = true;
  const dusk = sky === "theme" ? matchMedia("(prefers-color-scheme: dark)").matches : duskAt(new Date().getHours());
  const colors = dusk ? COLORS.dusk : COLORS.day;

  const el = document.createElement("div");
  el.className = `world-clouds${dusk ? " is-dusk" : ""}`;
  el.setAttribute("aria-hidden", "true"); // the page's own "Loading…" says this to a screen reader
  const skyEl = document.createElement("div");
  skyEl.className = "world-clouds-sky";
  const layers = document.createElement("div");
  layers.className = "world-clouds-layers";
  const lit = puff(colors.lit);
  const shade = puff(colors.shade);
  for (let i = 0; i < LAYERS; i++) {
    const cloud = layer(i + 1, lit, shade);
    // All already on their way, so it opens in the middle of the flight rather than at the start.
    cloud.style.animationDelay = `${(-i * 4) / LAYERS}s`;
    layers.append(cloud);
  }
  const word = document.createElement("p");
  word.className = "world-clouds-word";
  word.textContent = "Loading the World…";
  el.append(skyEl, layers, word);

  let frames = 0;
  let none = false;
  let lifted = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const after = (ms: number, then: () => void) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      then();
    }, ms);
    timers.add(timer);
  };

  function check() {
    if (lifted) return;
    if (!cloudsMayLift({ elapsedMs: performance.now() - startedAt, shortestMs, pictureUp: frames >= FRAMES_TO_SEE, noPicture: none })) return;
    lifted = true;
    el.classList.add("is-lifting");
    lifting();
    after(LIFT_MS, () => el.remove());
  }
  after(shortestMs, check);
  after(GIVE_UP_MS, check);

  return {
    el,
    painted: () =>
      new Promise((resolve) => {
        // A window out of sight draws no frames: it mustn't wait for one.
        after(150, resolve);
        requestAnimationFrame(() => after(0, resolve));
      }),
    pictured() {
      if (lifted) return;
      frames += 1;
      check();
    },
    noPicture() {
      none = true;
      check();
    },
    destroy() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      lifted = true;
    },
  };
}
