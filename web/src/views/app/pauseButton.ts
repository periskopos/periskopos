import type { AppPause } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h, mount } from "../../dom.ts";
import { dayTime } from "../../format.ts";
import { popover } from "../../popover.ts";
import { busyButton, lamp, toast } from "../../ui.ts";
import { LENGTHS } from "../alertPause.ts";
import type { AppPage } from "./page.ts";

// Pausing this app's alerts from its own page. The same pause as in Settings →
// Notifications, always for a set time.

const isRunning = (until?: string) => until !== undefined && Date.parse(until) > Date.now();

async function setPause(page: AppPage, until: string) {
  page.pauseEdits++;
  page.pause = await api<AppPause>("POST", `${page.apiBase}/pause`, { until });
  page.pauseEdits++; // a read that began while this was on its way is old too
  page.drawPause();
}

// Made once, like the Check now button: it stays open across the page's redraws.
export function pauseControl(page: AppPage) {
  const button = h("button", { type: "button", class: "btn" }, "Pause alerts") as HTMLButtonElement;
  const panel = h("div", { class: "pause-panel", id: "app-pause-panel" });
  const root = h("div", { class: "pause-control" }, button, panel);

  mount(
    panel,
    h("p", { class: "secondary" }, "Pause this app's alerts"),
    LENGTHS.map((length) =>
      h(
        "button",
        {
          type: "button",
          class: "btn btn--sm",
          onclick: async () => {
            try {
              await setPause(page, length.until(new Date()).toISOString());
              toast("Paused");
              pop.close(true);
            } catch (err) {
              toast((err as Error).message, "down");
            }
          },
        },
        length.label,
      ),
    ),
    h("p", { class: "meta" }, "Periskopos keeps checking, and the bell keeps showing every problem. When the pause ends, one message says what you missed. This covers everything about this app, including its certificate and domain. Alerts about providers and your accounts' keys still arrive."),
  );
  const pop = popover(root, button, panel);
  return { root, destroy: pop.destroy };
}

// Says so while a pause is on, on every tab, with the way out beside it.
export function pauseBanners(page: AppPage) {
  const a = page.app;
  const pause = page.pause;
  if (!a || !pause) return [];
  return [
    isRunning(pause.all) &&
      h(
        "div",
        { class: "banner banner--attention pause-line", role: "status" },
        h("span", { class: "key-line" }, lamp("attention"), `All alerts are paused until ${dayTime(pause.all!)}`),
        h("a", { class: "btn btn--sm", href: "#/settings/notifications" }, "Change"),
      ),
    isRunning(pause.app) &&
      h(
        "div",
        { class: "banner banner--attention pause-line", role: "status" },
        h("span", { class: "key-line" }, lamp("attention"), `${a.name}'s alerts are paused until ${dayTime(pause.app!)}`),
        busyButton(
          "Resume",
          "Resuming…",
          async () => {
            try {
              await setPause(page, "");
              toast("Alerts are back on");
            } catch (err) {
              toast((err as Error).message, "down");
            }
          },
          "btn btn--sm",
        ),
      ),
  ];
}
