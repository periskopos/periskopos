import { addToTally, cleanGpuName, newTally, tallyAt, tallyOver } from "../../../../shared/world-perf.ts";
import type { WorldPerf } from "../../../../shared/world-perf.ts";
import { api } from "../../api.ts";

// Keeps count of how the World runs and tells this computer's own server, so a bug
// report can say (server/diagnostics.ts). It goes no further on its own. Across
// visits, since the slow one may not be the last.

const SEND_EVERY_MS = 30_000;
const SKIP_GAP_MS = 2000; // asleep, or the window hidden: not a slow frame

const frames = newTally();
const draws = newTally();
let visits = 0;
let countedMs = 0;
let firstFrameMs = 0;
let lostGraphics = 0;
let detail = 0;
let lowestDetail = 0;
let last: PictureSize = { drawCalls: 0, triangles: 0, pixelRatio: 1, megapixels: 0 };
let readSize: (() => PictureSize) | null = null;
let gpu = "unknown";
let sentFrames = -1;

type PictureSize = Pick<WorldPerf, "drawCalls" | "triangles" | "pixelRatio" | "megapixels">;

const half = (value: number) => Math.round(value * 2) / 2;

// What the renderer last drew, as the report says it: rounded, so it tells a small picture
// from a large one without giving a window's exact size.
export const pictureSize = (drawCalls: number, triangles: number, pixelRatio: number, widthPx: number, heightPx: number): PictureSize => ({
  drawCalls,
  triangles,
  pixelRatio: half(pixelRatio),
  megapixels: half((widthPx * heightPx * pixelRatio * pixelRatio) / 1_000_000),
});

export function worldPerfSoFar(): WorldPerf {
  if (readSize) last = readSize();
  const over50 = tallyOver(frames, 50);
  return {
    visits,
    minutes: Math.round(countedMs / 60_000),
    frames: frames.total,
    typicalMs: tallyAt(frames, 0.5),
    slow95Ms: tallyAt(frames, 0.95),
    slow99Ms: tallyAt(frames, 0.99),
    worstMs: frames.worst,
    overHalfSecond: tallyOver(frames, 500),
    over50MsPercent: frames.total ? Math.round((over50 / frames.total) * 100) : 0,
    drawTypicalMs: tallyAt(draws, 0.5),
    drawSlow95Ms: tallyAt(draws, 0.95),
    firstFrameMs,
    detail,
    lowestDetail,
    lostGraphics,
    ...last,
    gpu,
  };
}

// Only when there's something new, so a World left idle or behind other windows sends nothing.
export async function sendWorldPerf(): Promise<void> {
  if (visits === 0 || frames.total === sentFrames) return;
  sentFrames = frames.total;
  // A report without these still has everything else, so a failure here says nothing.
  await api("POST", "/diagnostics/world", worldPerfSoFar()).catch(() => {});
}

// One visit to the World, from its renderer being made to its being taken down.
export function watchWorldPerf(context: WebGLRenderingContext | WebGL2RenderingContext, size: () => PictureSize) {
  visits += 1;
  detail = 0;
  readSize = size;
  const openedAt = performance.now();
  let drawn = false;
  const info = context.getExtension("WEBGL_debug_renderer_info");
  gpu = cleanGpuName(info ? context.getParameter(info.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER));
  const timer = setInterval(() => void sendWorldPerf(), SEND_EVERY_MS);

  return {
    pictured() {
      if (drawn) return;
      drawn = true;
      firstFrameMs = Math.round(performance.now() - openedAt);
    },
    // `meant` is whether this frame was trying to keep up: the World draws slowly on
    // purpose when nothing's moving or it isn't in front, and that's not a slow computer.
    frame(gapMs: number, drawMs: number, meant: boolean) {
      if (!meant || gapMs > SKIP_GAP_MS) return;
      addToTally(frames, gapMs);
      addToTally(draws, drawMs);
      countedMs += gapMs;
    },
    level(now: number) {
      detail = now;
      if (now > lowestDetail) lowestDetail = now;
    },
    lost() {
      lostGraphics += 1;
    },
    stop() {
      clearInterval(timer);
      void sendWorldPerf(); // reads the renderer once more, so before it's taken down
      readSize = null;
    },
  };
}
