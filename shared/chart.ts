// The arithmetic behind the app's charts, apart from the drawing so Node can test it.

// A y-axis that ends on a round number just above the data: whole counts only, since
// these charts count things, and about three steps so the grid stays quiet.
export function niceScale(max: number, steps = 3): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 1, ticks: [0, 1] };
  const raw = max / steps;
  const size = 10 ** Math.floor(Math.log10(raw));
  const step = Math.max(1, [1, 2, 2.5, 5, 10].map((k) => k * size).find((s) => s >= raw) ?? 10 * size);
  // 2.5 of a small unit isn't a whole count.
  const whole = Number.isInteger(step) ? step : Math.ceil(step);
  const top = Math.ceil(max / whole) * whole;
  const ticks: number[] = [];
  for (let at = 0; at <= top; at += whole) ticks.push(at);
  return { top, ticks };
}

// A smooth line through evenly spaced points that never overshoots them, so it can't
// draw a peak higher, or a dip lower, than the data has: a monotone cubic. One "C"
// command for each gap between points, so the caller can treat the last one apart.
export function monotoneSegments(points: readonly (readonly [number, number])[]): string[] {
  if (points.length < 2) return [];
  const slopes: number[] = [];
  for (let i = 0; i < points.length - 1; i++) slopes.push((points[i + 1]![1] - points[i]![1]) / (points[i + 1]![0] - points[i]![0]));
  const tangents = points.map((_, i) => {
    if (i === 0) return slopes[0]!;
    if (i === points.length - 1) return slopes[i - 1]!;
    const a = slopes[i - 1]!;
    const b = slopes[i]!;
    // Flat at a peak or a dip, which is what keeps the curve inside the data.
    return a * b <= 0 ? 0 : (2 * a * b) / (a + b);
  });
  return slopes.map((_, i) => {
    const [x0, y0] = points[i]!;
    const [x1, y1] = points[i + 1]!;
    const third = (x1 - x0) / 3;
    const round = (n: number) => Number(n.toFixed(2));
    return `C ${round(x0 + third)} ${round(y0 + tangents[i]! * third)} ${round(x1 - third)} ${round(y1 - tangents[i + 1]! * third)} ${round(x1)} ${round(y1)}`;
  });
}

// Which points get a label on the x-axis: evenly spread, first and last always.
export function axisPicks(count: number, labels = 5): number[] {
  if (count <= 0) return [];
  if (count <= 8) return Array.from({ length: count }, (_, i) => i);
  return [...new Set(Array.from({ length: labels }, (_, i) => Math.round((i * (count - 1)) / (labels - 1))))];
}
