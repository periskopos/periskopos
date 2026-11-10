import { hourStyle } from "../../prefs.ts";
import type { WatcherLog } from "../../../../shared/types.ts";
import { radarBlips } from "../../../../shared/world.ts";
import type { RadarBlip, RadarTone, World } from "../../../../shared/world.ts";
import { h, mount } from "../../dom.ts";
import { lamp, timeAgo } from "../../ui.ts";
import type { Selection, WorldScene } from "./scene/types.ts";

// The watcher's panel: a radar that turns with the dish, and its own log of what it
// checked. The vans on the road are the same log.

const COLORS: Record<RadarTone, string> = { up: "#5ad98d", attention: "#f4bb44", down: "#ff6a5f", info: "#6fb4ff", unknown: "#8f9ba8" };
const HINT = "Everything on the map, where it stands from the dish.";
const WAKE = 14;
const PICK_REACH_PX = 13;

export type WatcherPanelDeps = {
  world(): World | undefined;
  scene(): WorldScene | null;
  isOpen(): boolean;
  isReplay(): boolean;
  choose(next: Selection): void;
  closeButton(): Node;
};

export function createWatcherPanel({ world, scene, isOpen, isReplay, choose, closeButton }: WatcherPanelDeps) {
  const note = h("p", { class: "meta world-radar-note" }, HINT);
  const radar = h("canvas", { class: "world-radar", role: "img", onclick: onClick, onmousemove: onHover, onmouseleave: () => mount(note, HINT) }) as HTMLCanvasElement;
  const logBody = h("div", { class: "world-log" });
  const head = h("div", { class: "world-tower-state" });
  let log: WatcherLog | undefined;
  let failed = false;
  let spots: { blip: RadarBlip; x: number; y: number }[] = [];

  function blipAt(event: MouseEvent) {
    const box = radar.getBoundingClientRect();
    let best: RadarBlip | undefined;
    let nearest = PICK_REACH_PX;
    for (const spot of spots) {
      const d = Math.hypot(spot.x - (event.clientX - box.left), spot.y - (event.clientY - box.top));
      if (d < nearest) {
        nearest = d;
        best = spot.blip;
      }
    }
    return best;
  }
  function onClick(event: MouseEvent) {
    const blip = blipAt(event);
    if (!blip) return;
    // The panel changes under the pointer, and no mouseleave will come to say so.
    mount(note, HINT);
    radar.classList.remove("is-pointing");
    choose({ kind: blip.kind, id: blip.id });
  }
  function onHover(event: MouseEvent) {
    const blip = blipAt(event);
    radar.classList.toggle("is-pointing", Boolean(blip));
    mount(note, blip ? blip.name : HINT);
  }

  // Drawn with each frame of the picture, so it stops whenever that does. The arm is the
  // dish itself: while nothing's being checked it doesn't turn, so there's no arm.
  function drawRadar() {
    const now = world();
    const view = scene();
    if (!isOpen() || !now || !view || !radar.isConnected) return;
    const size = radar.clientWidth;
    if (!size) return;
    const pixels = Math.min(window.devicePixelRatio || 1, 2);
    if (radar.width !== Math.round(size * pixels)) radar.width = radar.height = Math.round(size * pixels);
    const c = radar.getContext("2d");
    if (!c) return;
    const { right, forward, beam } = view.radarView();
    const mid = size / 2;
    const reach = mid - 3;
    c.setTransform(pixels, 0, 0, pixels, 0, 0);
    c.clearRect(0, 0, size, size);
    c.fillStyle = "#07191a";
    c.beginPath();
    c.arc(mid, mid, reach, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.clip();
    c.strokeStyle = "rgba(112, 226, 170, 0.2)";
    c.lineWidth = 1;
    for (const part of [0.3, 0.6, 0.9]) {
      c.beginPath();
      c.arc(mid, mid, reach * part, 0, Math.PI * 2);
      c.stroke();
    }
    c.beginPath();
    c.moveTo(mid - reach, mid);
    c.lineTo(mid + reach, mid);
    c.moveTo(mid, mid - reach);
    c.lineTo(mid, mid + reach);
    c.stroke();
    const onScreen = (x: number, z: number) => [mid + (x * right[0] + z * right[1]) * reach, mid - (x * forward[0] + z * forward[1]) * reach] as const;
    const towards = (angle: number) => onScreen(Math.sin(angle), Math.cos(angle));
    if (beam !== null) {
      for (let i = 0; i < WAKE; i++) {
        const [ax, ay] = towards(beam - i * 0.075);
        const [bx, by] = towards(beam - (i + 1) * 0.075);
        c.fillStyle = `rgba(112, 226, 170, ${0.2 * (1 - i / WAKE)})`;
        c.beginPath();
        c.moveTo(mid, mid);
        c.lineTo(ax, ay);
        c.lineTo(bx, by);
        c.closePath();
        c.fill();
      }
      const [tx, ty] = towards(beam);
      c.strokeStyle = "rgba(150, 245, 195, 0.75)";
      c.lineWidth = 1.2;
      c.beginPath();
      c.moveTo(mid, mid);
      c.lineTo(tx, ty);
      c.stroke();
    }
    spots = [];
    for (const blip of radarBlips(now)) {
      const length = Math.hypot(blip.x, blip.z) || 1;
      const [x, y] = onScreen((blip.x / length) * blip.reach, (blip.z / length) * blip.reach);
      spots.push({ blip, x, y });
      // Brighter just after the arm has passed it.
      const bearing = Math.atan2(blip.x, blip.z);
      const since = beam === null ? Math.PI * 2 : (((beam - bearing) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const passed = Math.max(0, 1 - since / 1.3);
      const trouble = blip.tone === "down" || blip.tone === "attention";
      c.globalAlpha = 0.72 + passed * 0.28;
      c.fillStyle = COLORS[blip.tone];
      // Services are squares, apps are round; trouble is larger, not only redder.
      const r = trouble ? 4.6 : 3.1;
      c.beginPath();
      if (blip.kind === "provider") c.rect(x - r, y - r, r * 2, r * 2);
      else c.arc(x, y, r, 0, Math.PI * 2);
      c.fill();
      if (trouble || passed > 0) {
        c.globalAlpha = trouble ? 0.75 : passed * 0.5;
        c.strokeStyle = COLORS[blip.tone];
        c.lineWidth = 1;
        c.beginPath();
        c.arc(x, y, r + 3.5 + passed * 2, 0, Math.PI * 2);
        c.stroke();
      }
      c.globalAlpha = 1;
    }
    // The dish, in the middle of it all.
    c.fillStyle = "#f2e8c9";
    c.beginPath();
    c.arc(mid, mid, 2.6, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  function drawLog() {
    const rows = log?.checks ?? [];
    const time = (at: string) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", ...hourStyle() });
    const result = (row: WatcherLog["checks"][number]) => [row.httpStatus && row.httpStatus >= 400 ? `HTTP ${row.httpStatus}` : "", row.ms !== undefined ? `${row.ms} ms` : "", row.state !== "up" ? (row.detail ?? "") : ""].filter(Boolean).join(" · ");
    mount(
      logBody,
      failed && h("p", { class: "meta" }, log ? "Couldn't read the log just now. This is what it said last." : "Couldn't read the log just now."),
      !failed && log && rows.length === 0 && h("p", { class: "meta" }, "Nothing checked yet."),
      rows.length > 0 &&
        h(
          "ol",
          { class: "world-log-list" },
          rows.map((row) =>
            h(
              "li",
              null,
              lamp(row.state),
              h("a", { class: "world-log-row", href: `#/apps/${encodeURIComponent(row.slug)}/history` }, h("span", { class: "world-log-name" }, row.app, h("span", { class: "world-log-what" }, row.what)), result(row) && h("span", { class: "world-log-result" }, result(row))),
              h("time", { class: "world-log-time mono", datetime: row.at }, time(row.at)),
            ),
          ),
        ),
    );
    if (isOpen()) drawHead();
  }

  // The words at the top depend on the log, so they follow it.
  function drawHead() {
    const now = world();
    if (!now) return;
    const latest = log?.checks[0];
    const word = now.failed ? "Can't tell" : log?.off ? "Turned off" : now.watching ? "Watching" : now.stopped ? "Not checking" : now.plots.length > 0 ? "Not known yet" : "Nothing to watch yet";
    const tone = now.failed || log?.off ? "unknown" : now.watching ? "up" : now.stopped ? "attention" : "unknown";
    const line = now.failed
      ? "The last read of your apps failed, so this can't say what the watcher is doing."
      : log?.off
        ? "Checks are turned off in Settings, so nothing here is being kept up to date."
        : log?.stoppedSince
          ? ["It stopped ", timeAgo(log.stoppedSince), "."]
          : latest
            ? ["Last check ", timeAgo(latest.at), "."]
            : null;
    const count = now.plots.length;
    mount(
      head,
      h("div", { class: "world-tower-word" }, lamp(tone), word),
      line && h("div", { class: "meta" }, ...(Array.isArray(line) ? line : [line])),
      h("div", { class: "meta" }, `${count} app${count === 1 ? "" : "s"} and ${now.utilities.length} service${now.utilities.length === 1 ? "" : "s"} on the map.`),
    );
  }

  return {
    // What the panel and the vans read; what was read stays on screen, and says so.
    setLog(next: WatcherLog | undefined) {
      failed = next === undefined;
      if (next) log = next;
      drawLog();
    },
    checks: () => (failed ? [] : (log?.checks ?? [])),
    read: () => !failed && Boolean(log),
    off: () => log?.off === true,
    stopped: () => !failed && Boolean(log?.stoppedSince),
    drawRadar,
    detail() {
      const now = world();
      const down = now ? radarBlips(now).filter((b) => b.tone === "down").length : 0;
      radar.setAttribute("aria-label", `Radar of ${now?.plots.length ?? 0} apps and ${now?.utilities.length ?? 0} services, ${down} of them down.`);
      drawHead();
      return [
        h("div", { class: "world-detail-head" }, h("h2", null, "The watcher"), closeButton()),
        head,
        isReplay() && h("p", { class: "meta" }, "A replay can't show the watcher then: this is now."),
        radar,
        note,
        h("h3", { class: "world-log-title" }, "Its latest checks"),
        logBody,
      ];
    },
  };
}
