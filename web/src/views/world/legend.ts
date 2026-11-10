import type { WorldStage } from "../../../../shared/world.ts";
import { h, mount } from "../../dom.ts";
import { lamp } from "../../ui.ts";
import { keyGroups, type KeyRow, nextPlace, type OnMap, type Place, placeKey, type StatusId, statusesOnMap, statusTitle } from "./looks.ts";

// The words that explain the map: what each look means, and what stage the land is at.

export const STAGE_WORDS: Record<WorldStage, string> = {
  orchards: "It's a small valley for now, with a few campuses by the road. At 4 apps the floor widens, and at 10 it widens again.",
  town: "The valley floor has widened to make room for your apps. At 10 apps it widens once more.",
  valley: "The valley floor now runs from one range of hills to the other.",
};

export const STAGE_NEWS: Record<WorldStage, [string, string]> = {
  orchards: ["", ""],
  town: ["Your valley has widened", "You have 4 or more apps, so the valley floor has widened round your campuses."],
  valley: ["Your valley is at full width", "You have 10 or more apps, so the valley floor now runs from one range of hills to the other."],
};

type World = Parameters<typeof statusesOnMap>[0];

// Going to what has a status, the next one at each click: from what's open, if it has that
// status, otherwise from the last one shown. One for the key row and the legend both, so
// they carry on from each other.
export function createStepper({ goTo, current }: { goTo: (place: Place) => void; current: () => { kind: string; id: string } | null }) {
  const lastShown = new Map<StatusId, string>();
  return (status: Pick<OnMap, "id" | "places">) => {
    const open = current();
    const from = open && status.places.some((p) => placeKey(p) === placeKey(open)) ? placeKey(open) : lastShown.get(status.id);
    const place = nextPlace(status.places, from);
    if (!place) return;
    lastShown.set(status.id, placeKey(place));
    goTo(place);
  };
}
export type Step = ReturnType<typeof createStepper>;

// The key to the map, kept in sight: the long words stay in the legend. Each status
// takes you to what has it, the next one at each click, so one problem in a big valley is found.
export function createLookKey({ step }: { step: Step }) {
  const row = h("ul", { class: "world-card world-key", "aria-label": "Every status on the map now: each goes to what has it", hidden: true });
  let shown = "";
  return {
    el: row,
    // null: nothing on the map to be a key to.
    draw(world: World | null) {
      const statuses = world ? statusesOnMap(world) : [];
      const next = JSON.stringify(statuses.map((s) => [s.id, s.places.map(placeKey), s.names]));
      if (next === shown) return; // redrawn every few seconds: a tooltip being read stays put
      shown = next;
      row.hidden = statuses.length === 0;
      mount(
        row,
        statuses.map((status) => {
          const count = status.places.length > 1 ? h("span", { class: "world-key-count", "aria-hidden": "true" }, String(status.places.length)) : null;
          // Pointed at, it says what it means in the tooltip; reached by keyboard, in a bubble
          // over the key and to a screen reader, which a tooltip never reaches.
          const tip = statusTitle(status);
          // Named, so focus stays on it when its count changes.
          return h("li", null, h("button", { type: "button", name: `key:${status.id}`, title: tip, "data-tip": tip, "aria-description": tip, onclick: () => step(status) }, lamp(status.lamp), h("span", null, status.word), count));
        }),
      );
    },
  };
}

// "What am I looking at?": the key, in full, grouped, with what's on the map now lit up and
// taking you to it. How to read the map is a click away, in a window of its own: it's read
// once, and the key is what's looked back at.
export function createLegend({ step, stage }: { step: Step; stage: () => WorldStage | null }) {
  const body = h("div", { class: "world-legend-key" });
  let open: HTMLDialogElement | null = null;
  const about = h("button", { type: "button", class: "world-legend-about", "aria-label": "How to read the map", title: "How to read the map", onclick: () => (open = openAbout(stage())) }, "?");
  const el = h(
    "details",
    { class: "world-card world-legend" },
    h("summary", null, "What am I looking at?"),
    h("div", { class: "world-legend-head" }, h("p", { class: "world-legend-lead" }, "Your own Silicon Valley, drawn from your real data. It grows as your apps do."), about),
    body,
    // Read once, so it's last: why some rows are bright and that they can be clicked.
    h("p", { class: "meta world-legend-note" }, "Bright ones are on your map now. Click one to go to it."),
  );
  let shown = "";
  const row = (r: KeyRow) => {
    const here = r.places.length > 0;
    const count = here && h("span", { class: "world-legend-count" }, r.places.length === 1 ? r.places[0]!.name : String(r.places.length));
    const parts = [lamp(r.lamp), h("span", { class: "world-legend-text" }, h("span", { class: "world-legend-word" }, r.word), h("span", { class: "world-legend-seen" }, r.seen)), count];
    if (!here) return h("li", null, h("div", { class: "world-legend-row is-absent" }, parts));
    const tip = statusTitle({ ...r, names: r.places.map((p) => p.name) });
    return h("li", null, h("button", { type: "button", class: "world-legend-row", name: `legend:${r.id}`, title: tip, "aria-description": tip, onclick: () => step(r) }, parts));
  };
  return {
    el,
    // Leaving the page: a window left open would make the next page inert.
    destroy() {
      open?.close();
      open = null;
    },
    // null: nothing on the map, so nothing is lit up; the key still says what everything means.
    draw(world: World | null) {
      const groups = keyGroups(world ? statusesOnMap(world) : []);
      const next = JSON.stringify(groups.map((g) => g.rows.map((r) => [r.id, r.places.map(placeKey)])));
      if (next === shown) return; // redrawn often: a row being pointed at stays put
      shown = next;
      mount(body, groups.map((g) => h("section", { class: "world-legend-group" }, h("h3", null, g.title), h("ul", null, g.rows.map(row)))));
    },
  };
}

let abouts = 0;

// How to read the map, in a window: a native <dialog>, so focus stays in it, Escape closes
// it, and screen readers announce it. Each line checked against what the map draws
// (2026-11-07); what each look means is the key, from looks.ts, so it isn't said twice.
function openAbout(stage: WorldStage | null): HTMLDialogElement {
  const id = `world-about-${++abouts}`;
  const dialog = h("dialog", { class: "dialog world-about", "aria-labelledby": id });
  const close = h("button", { type: "button", class: "btn btn--primary", autofocus: true, onclick: () => dialog.close() }, "Got it");
  mount(
    dialog,
    h(
      "div",
      { class: "world-about-head" },
      h("h2", { id }, "How to read the map"),
      h("button", { type: "button", class: "world-close", "aria-label": "Close", title: "Close", onclick: () => dialog.close() }, "×"),
    ),
    stage && h("p", null, STAGE_WORDS[stage]),
    h("h3", null, "What's where"),
    h("p", null, "Your apps stand along the main road, the services they use behind them on higher ground, and the watcher's dish on the hill behind those. Each app has a floor for each thing watched, up to ten. Where its traffic can be read, more traffic means a bigger building, a fuller car park and more cars."),
    h("h3", null, "Lights and lines"),
    h("p", null, "The light on top of each sign and the screen behind its logo show how it is. Where that isn't known, neither says anything. A thin line from an app to a service means the app depends on it."),
    h("h3", null, "On the road"),
    h("p", null, "Everything on the road is real, and you can click it: a van is a check the watcher made, in the colour of its result, and a blue truck is a deploy under way. The dish turns while your apps are being checked; click it for its radar and log."),
    h("h3", null, "Moving round"),
    h("p", null, "Drag or use the arrow keys to move, scroll or + and − to zoom, Q and E or Turn to walk round it, and 0 to fit it. Tab goes through your apps, the watcher and your services, and Escape closes what's open."),
    h("div", { class: "actions actions--end" }, close),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  dialog.scrollTop = 0; // "Got it" takes focus, but the reading starts at the top
  return dialog;
}
