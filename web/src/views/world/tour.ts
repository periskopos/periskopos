import type { Plot } from "../../../../shared/world.ts";
import { mount } from "../../dom.ts";
import { STATE_RANK } from "../../format.ts";

// The tour: round every campus, whatever most needs looking at first. Any touch ends it,
// leaving the view where it is. Its own button also goes back to the whole map.

const STOP_MS = 7_000;

export type TourDeps = {
  button: HTMLElement;
  plots(): Plot[];
  visit(slug: string): void;
  ended(): void;
  stopped(): void;
};

export function createTour({ button, plots, visit, ended, stopped }: TourDeps) {
  let timer: ReturnType<typeof setInterval> | undefined;

  function end() {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    mount(button, "Tour");
    ended();
  }

  return {
    running: () => timer !== undefined,
    end,
    toggle() {
      if (timer) {
        end();
        stopped();
        return;
      }
      let next = 0;
      const step = () => {
        const stops = [...plots()].sort((a, b) => STATE_RANK[a.state] - STATE_RANK[b.state]);
        const stop = stops[next++ % Math.max(1, stops.length)];
        if (stop) visit(stop.slug);
      };
      step();
      timer = setInterval(step, STOP_MS);
      mount(button, "Stop tour");
    },
    destroy() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
