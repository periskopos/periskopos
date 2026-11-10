// What the parts of the page round the map need to know about each other.

// Which parts have anything to do. The zoom buttons, the legend and the key are all about the
// map, so with no map (the apps couldn't be read, or this window can't draw it) they'd be
// buttons that do nothing and a key to nothing. A key or a tour needs something to be about.
export function hudParts({ appCount, picture, replaying }: { appCount: number | undefined; picture: boolean; replaying: boolean }) {
  const map = appCount !== undefined && picture;
  const anything = map && (appCount ?? 0) > 0;
  return { controls: map, legend: map, key: anything, walks: anything && !replaying };
}

type Figures = { running: number; total: number; notRunning: { state: string }[]; deploying: unknown[] };

// All's well: the title says so, nothing is being deployed, and anything not running is so on
// purpose (not live yet, or nothing to check). Then the figures step back, and come forward
// again the moment that changes: how much the screen says is itself a sign of how things are.
export function figuresCalm(stats: Figures, overall: string): boolean {
  return overall === "up" && stats.deploying.length === 0 && stats.notRunning.every((p) => p.state === "prelaunch" || p.state === "none");
}

// The figures in a line, for a window too narrow for the card: what's running, what's being
// deployed, and when the watcher last looked, or why it hasn't.
export function briefFigures(stats: Figures, lastCheck: { value: string }): string {
  const parts = [`${stats.running} of ${stats.total} running`];
  if (stats.deploying.length > 0) parts.push(`${stats.deploying.length} deploying`);
  const when = lastCheck.value;
  parts.push(/ago$|^just now$/i.test(when) ? `last check ${when.toLowerCase()}` : `checks: ${when.toLowerCase()}`);
  return parts.join(" · ");
}

// The cards are as big as what they're saying, so the corner is told how much room they leave
// rather than guessing: the figures wrap, and "Stop tour" is wider than "Tour".
export function watchHudRoom(root: HTMLElement, top: HTMLElement, controls: HTMLElement): () => void {
  const measure = () => {
    root.style.setProperty("--world-top-h", `${top.offsetHeight}px`);
    root.style.setProperty("--world-controls-w", `${controls.offsetWidth}px`);
  };
  const observer = new ResizeObserver(measure);
  observer.observe(top);
  observer.observe(controls);
  measure();
  return () => observer.disconnect();
}
