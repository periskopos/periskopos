import type { App, AppHistory } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h, mount } from "../../dom.ts";
import { hourStyle } from "../../prefs.ts";

// Replay: the last day, from the record. Nothing in it moves or claims to be current.

const SPAN = 24 * 60 * 60_000;
const STEP = 5 * 60_000;
const PLAY_STEP = 6 * 60_000; // a day in 24 seconds
const PLAY_EVERY_MS = 100;

export const moment = (at: number) => new Date(at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit", ...hourStyle() });

export type ReplayDeps = {
  bar: HTMLElement;
  button: HTMLElement;
  apps(): App[] | undefined;
  left(): boolean;
  onError(err: unknown): void;
  // Something's changed about the moment shown. jump: the view moved, nothing happened.
  onChange(jump: boolean): void;
};

export function createReplay({ bar, button, apps, left, onError, onChange }: ReplayDeps) {
  let histories: Map<string, AppHistory> | undefined;
  let at: number | null = null;
  let from = 0;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopPlaying = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  function marks() {
    if (!histories) return [];
    const to = from + SPAN;
    const mark = (start: number, until: number, tone: string, title: string) => {
      const a = Math.max(from, start);
      const b = Math.min(to, until);
      if (b <= a) return [];
      const el = h("span", { class: `world-replay-mark world-replay-mark--${tone}`, title });
      el.style.left = `${((a - from) / SPAN) * 100}%`;
      el.style.width = `${Math.max(0.6, ((b - a) / SPAN) * 100)}%`;
      return [el];
    };
    const all = [...histories.values()];
    // Stretches nobody was watching go underneath: an incident open across one is still
    // shown, and the picture says "no data" for that stretch.
    return [
      ...all.flatMap((history) => history.gaps.flatMap((g) => mark(Date.parse(g.from), Date.parse(g.to), "gap", "Periskopos wasn't watching"))),
      ...all.flatMap((history) => history.incidents.filter((i) => !i.falseAlarm).flatMap((i) => mark(Date.parse(i.startedAt), i.endedAt ? Date.parse(i.endedAt) : to, i.kind === "outage" ? "down" : "attention", i.reason))),
    ];
  }

  function end() {
    stopPlaying();
    at = null;
    bar.hidden = true;
    mount(bar);
    onChange(true);
  }

  function drawBar() {
    const when = h("span", { class: "world-replay-when" }, moment(at ?? from));
    const moveTo = (next: number, jump: boolean) => {
      at = next;
      slider.value = String(next);
      mount(when, moment(next));
      onChange(jump);
    };
    const slider = h("input", {
      type: "range",
      class: "world-replay-slider",
      min: String(from),
      max: String(from + SPAN),
      step: String(STEP),
      value: String(at ?? from),
      "aria-label": "Moment to show",
      oninput: () => {
        stopPlaying();
        mount(play, "Play");
        moveTo(Number(slider.value), true); // dragging through time isn't something happening
      },
    }) as HTMLInputElement;
    const play: HTMLButtonElement = h(
      "button",
      {
        type: "button",
        class: "btn",
        onclick: () => {
          if (timer) {
            stopPlaying();
            mount(play, "Play");
            return;
          }
          mount(play, "Pause");
          if ((at ?? 0) >= from + SPAN) moveTo(from, true);
          timer = setInterval(() => {
            const next = (at ?? from) + PLAY_STEP;
            if (next >= from + SPAN) {
              stopPlaying();
              mount(play, "Play");
            }
            moveTo(Math.min(next, from + SPAN), false);
          }, PLAY_EVERY_MS);
        },
      },
      "Play",
    ) as HTMLButtonElement;
    bar.hidden = false;
    mount(bar, play, h("div", { class: "world-replay-track" }, h("div", { class: "world-replay-marks", "aria-hidden": "true" }, marks()), slider), when, h("button", { type: "button", class: "btn btn--primary", onclick: end }, "Back to now"));
  }

  return {
    at: () => at,
    histories: () => histories,
    async start() {
      const list = apps();
      if (!list || list.length === 0) return;
      button.setAttribute("disabled", "");
      button.textContent = "Loading…";
      try {
        const read = await Promise.all(list.map((a) => api<{ history: AppHistory }>("GET", `/apps/${encodeURIComponent(a.slug)}/history`).then((r) => [a.slug, r.history] as const)));
        if (left()) return;
        histories = new Map(read);
        from = Date.now() - SPAN;
        at = from;
        drawBar();
        onChange(true);
      } catch (err) {
        onError(err);
      } finally {
        button.removeAttribute("disabled");
        button.textContent = "Replay";
      }
    },
    stop: stopPlaying,
    end,
  };
}
