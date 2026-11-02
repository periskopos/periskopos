// Time ranges in ms, [start, end). Used to measure watched time and the
// part of an incident that fell inside it.

export type Interval = [number, number];

export function merge(list: Interval[]): Interval[] {
  const sorted = list
    .filter(([a, b]) => b > a)
    .map(([a, b]): Interval => [a, b])
    .sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function clip(list: Interval[], from: number, to: number): Interval[] {
  return merge(list.map(([a, b]): Interval => [Math.max(a, from), Math.min(b, to)]));
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const x = merge(a);
  const y = merge(b);
  const out: Interval[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length && j < y.length) {
    const start = Math.max(x[i][0], y[j][0]);
    const end = Math.min(x[i][1], y[j][1]);
    if (end > start) out.push([start, end]);
    if (x[i][1] < y[j][1]) i++;
    else j++;
  }
  return out;
}

// The parts of [from, to) not covered by `list`.
export function complement(list: Interval[], from: number, to: number): Interval[] {
  const out: Interval[] = [];
  let cursor = from;
  for (const [a, b] of clip(list, from, to)) {
    if (a > cursor) out.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < to) out.push([cursor, to]);
  return out;
}

export const total = (list: Interval[]) =>
  merge(list).reduce((sum, [a, b]) => sum + (b - a), 0);
