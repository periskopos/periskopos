// How the World ran on this computer, for a bug report: frame times, how far it
// had to cut its detail, and what kind of graphics it ran on. Only numbers and
// the graphics card's name: nothing about what's in the World, and no window
// size or map. It stays on this computer until someone pastes it into a report.

export type WorldPerf = {
  visits: number; // times the World was opened in this window
  minutes: number; // time it spent drawing frames that count
  frames: number;
  typicalMs: number; // half of the frames took this long or less
  slow95Ms: number; // 95 in 100
  slow99Ms: number; // 99 in 100
  worstMs: number;
  overHalfSecond: number; // frames that froze the picture for that long
  over50MsPercent: number; // share of frames slower than 20 a second
  drawTypicalMs: number; // the page's own work on a frame, not the graphics card's
  drawSlow95Ms: number;
  firstFrameMs: number; // from opening the World to its first picture, on the last visit
  detail: number; // the level it's at now (0 is the most detail)
  lowestDetail: number; // the furthest it has had to cut
  lostGraphics: number; // times the graphics card took the picture away
  drawCalls: number; // on the last frame
  triangles: number;
  pixelRatio: number; // rounded to a half
  megapixels: number; // rounded to a half, which is enough to tell small from large
  gpu: string;
};

const LONGEST_FRAME_MS = 2000;
const NUMBERS: Record<Exclude<keyof WorldPerf, "gpu">, number> = {
  visits: 100_000,
  minutes: 10_000_000,
  frames: 1_000_000_000,
  typicalMs: LONGEST_FRAME_MS,
  slow95Ms: LONGEST_FRAME_MS,
  slow99Ms: LONGEST_FRAME_MS,
  worstMs: LONGEST_FRAME_MS,
  overHalfSecond: 1_000_000_000,
  over50MsPercent: 100,
  drawTypicalMs: LONGEST_FRAME_MS,
  drawSlow95Ms: LONGEST_FRAME_MS,
  firstFrameMs: 600_000,
  detail: 9,
  lowestDetail: 9,
  lostGraphics: 100_000,
  drawCalls: 10_000_000,
  triangles: 1_000_000_000,
  pixelRatio: 16,
  megapixels: 1000,
};

// The browser's name for the graphics card, without the device's own number, and
// only in the characters such a name has. The most anything can put in a report.
export function cleanGpuName(raw: unknown): string {
  if (typeof raw !== "string") return "unknown";
  const name = raw
    .replace(/\(?0x[0-9a-f]+\)?/gi, "")
    .replace(/[^A-Za-z0-9 .,()+/_-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return name || "unknown";
}

// What the page sends, checked: this ends up in a report that gets pasted somewhere public.
export function parseWorldPerf(raw: unknown): WorldPerf | null {
  if (typeof raw !== "object" || raw === null) return null;
  const given = raw as Record<string, unknown>;
  const out: Partial<WorldPerf> = { gpu: cleanGpuName(given.gpu) };
  for (const [key, most] of Object.entries(NUMBERS) as [Exclude<keyof WorldPerf, "gpu">, number][]) {
    const value = given[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > most) return null;
    out[key] = value;
  }
  return out as WorldPerf;
}

export function worldPerfLines(perf: WorldPerf | null): string[] {
  if (!perf) return ["World: not opened since Periskopos started"];
  const n = (value: number) => value.toLocaleString("en-US");
  return [
    `World: ${n(perf.visits)} visit${perf.visits === 1 ? "" : "s"} · ${n(perf.frames)} frame${perf.frames === 1 ? "" : "s"} over ${n(perf.minutes)} min · first picture in ${n(perf.firstFrameMs)} ms`,
    `  Frame time: typical ${perf.typicalMs} ms · 95% under ${perf.slow95Ms} ms · 99% under ${perf.slow99Ms} ms · worst ${perf.worstMs} ms · ${perf.over50MsPercent}% over 50 ms · ${n(perf.overHalfSecond)} over 500 ms`,
    `  Page's work per frame: typical ${perf.drawTypicalMs} ms · 95% under ${perf.drawSlow95Ms} ms`,
    `  Detail: level ${perf.detail} now, ${perf.lowestDetail} at its lowest (0 is the most) · graphics lost ${n(perf.lostGraphics)} time${perf.lostGraphics === 1 ? "" : "s"}`,
    `  Last frame: ${n(perf.drawCalls)} draw calls · ${n(perf.triangles)} triangles · ${perf.megapixels} MP · pixel ratio ${perf.pixelRatio}`,
    `  Graphics: ${perf.gpu}`,
  ];
}

// Frame times, one count per millisecond: a frame costs one addition, and there's nothing to clean up.
export type FrameTally = { counts: Uint32Array; total: number; worst: number };
export const newTally = (): FrameTally => ({ counts: new Uint32Array(LONGEST_FRAME_MS + 1), total: 0, worst: 0 });

export function addToTally(tally: FrameTally, ms: number): void {
  const at = Math.min(LONGEST_FRAME_MS, Math.max(0, Math.round(ms)));
  tally.counts[at]! += 1;
  tally.total += 1;
  if (at > tally.worst) tally.worst = at;
}

// The time `share` of the frames (0 to 1) took or came in under.
export function tallyAt(tally: FrameTally, share: number): number {
  const wanted = Math.ceil(tally.total * share);
  let seen = 0;
  for (let ms = 0; ms < tally.counts.length; ms++) {
    seen += tally.counts[ms]!;
    if (seen >= wanted && seen > 0) return ms;
  }
  return 0;
}

export function tallyOver(tally: FrameTally, ms: number): number {
  let over = 0;
  for (let at = ms + 1; at < tally.counts.length; at++) over += tally.counts[at]!;
  return over;
}
