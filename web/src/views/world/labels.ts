import { chooseLabels, nudgeLabels } from "../../../../shared/world.ts";
import type { LabelBox, World } from "../../../../shared/world.ts";
import { h, mount } from "../../dom.ts";
import { STATE_RANK } from "../../format.ts";
import { lamp } from "../../ui.ts";
import { plotSays, utilitySays, watcherSays } from "./looks.ts";
import type { Selection, Standing, WorldScene } from "./scene/types.ts";

// Names over the picture: real text, so it's sharp and it can be read out. Problems and
// what's being pointed at always show; everything else gets a place only if it's free.

type Label = { el: HTMLButtonElement; kind: Standing; id: string; rank: number; always: boolean; w: number; h: number; shown: boolean; changed: boolean; x: number; y: number };

export type LabelDeps = {
  layer: HTMLElement;
  stage: HTMLElement;
  world(): World | undefined;
  scene(): WorldScene | null;
  pointedAt(kind: string, id: string): boolean;
  changedUntil: Map<string, number>;
  choose(next: Selection): void;
};

const CROWDED_FROM = 16;
const NEAR_ENOUGH_ZOOM = 1.8;

export function createLabels({ layer, stage, world, scene, pointedAt, changedUntil, choose }: LabelDeps) {
  const labels = new Map<string, Label>();
  let dirty = true;
  let dense = false;

  function labelFor(key: string, kind: Standing, id: string): Label {
    let label = labels.get(key);
    if (!label) {
      const el = h("button", { type: "button", class: "world-label", tabindex: "-1", onclick: () => choose({ kind, id }) }) as HTMLButtonElement;
      layer.appendChild(el);
      label = { el, kind, id, rank: 0, always: false, w: 0, h: 0, shown: false, changed: false, x: -1, y: -1 };
      labels.set(key, label);
    }
    return label;
  }

  function draw() {
    const now = world();
    if (!now) return;
    const wanted = new Set<string>();
    const describe = (key: string, kind: Standing, id: string, name: string, note: string, tone: string, state: Parameters<typeof lamp>[0], rank: number, always: boolean) => {
      wanted.add(key);
      const label = labelFor(key, kind, id);
      label.rank = rank;
      label.always = always;
      const changed = (changedUntil.get(key) ?? 0) > Date.now();
      label.el.className = `world-label world-label--${tone}${pointedAt(kind, id) ? " is-pointed-at" : ""}${label.shown ? " is-shown" : ""}${changed ? " is-changed" : ""}`;
      label.changed = changed;
      mount(label.el, lamp(state), h("span", { class: "world-label-text" }, h("span", { class: "world-label-name" }, name), note && h("span", { class: "world-label-note" }, note)));
      label.w = label.el.offsetWidth;
      label.h = label.el.offsetHeight;
    };
    for (const p of now.plots) {
      const says = plotSays(p);
      describe(`app:${p.slug}`, "app", p.slug, p.name, says.note, says.tone, says.lamp, STATE_RANK[p.state], p.state === "down" || (p.state === "attention" && !dense));
    }
    // On a phone a calm provider has no label: there's no room, and nothing to say.
    const narrow = stage.clientWidth < 600;
    for (const u of now.utilities) {
      if (narrow && (u.look === "ok" || u.look === "past") && !pointedAt("provider", u.id)) continue;
      const says = utilitySays(u);
      describe(`provider:${u.id}`, "provider", u.id, u.label, says.note, `${says.tone} world-label--provider`, says.lamp, u.look === "ok" || u.look === "past" ? 20 : 1, u.look === "trouble");
    }
    // The dish has a label like anything else, and insists only when it isn't watching.
    const stopped = now.stopped;
    if (!narrow || stopped || pointedAt("tower", "watcher")) {
      const says = watcherSays(now);
      describe("tower:watcher", "tower", "watcher", "The watcher", says.note, `${says.tone} world-label--provider`, says.lamp, stopped ? 1 : 20, stopped);
    }
    for (const [key, label] of labels) {
      if (wanted.has(key)) continue;
      label.el.remove();
      labels.delete(key);
    }
    dirty = false;
  }

  return {
    invalidate() {
      dirty = true;
    },
    place() {
      const view = scene();
      if (!view) return;
      // A crowded valley, seen from far off: names only, and only what's down insists.
      const crowded = (world()?.plots.length ?? 0) >= CROWDED_FROM && view.zoomLevel() < NEAR_ENOUGH_ZOOM;
      if (crowded !== dense) {
        dense = crowded;
        layer.classList.toggle("is-dense", dense);
        dirty = true;
      }
      if (dirty) draw();
      const boxes: LabelBox[] = [];
      for (const [key, label] of labels) {
        const at = view.anchor(label.kind, label.id);
        if (at) boxes.push({ id: key, x: at.x - label.w / 2, y: at.y - label.h, w: label.w, h: label.h, rank: label.rank, always: label.always || label.changed || pointedAt(label.kind, label.id) });
      }
      const settled = nudgeLabels(boxes);
      const shown = chooseLabels(settled);
      const where = new Map(settled.map((b) => [b.id, b]));
      for (const [key, label] of labels) {
        const at = where.get(key);
        const show = Boolean(at) && shown.has(key);
        if (show !== label.shown) {
          label.shown = show;
          label.el.classList.toggle("is-shown", show);
        }
        if (at && (Math.abs(at.x - label.x) > 0.3 || Math.abs(at.y - label.y) > 0.3)) {
          label.x = at.x;
          label.y = at.y;
          label.el.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y)}px)`;
        }
      }
    },
  };
}
