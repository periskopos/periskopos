import { h } from "../../dom.ts";
import { popover } from "../../popover.ts";
import type { Sky } from "./scene/types.ts";

// The map's own settings, behind the gear at the end of its controls.

const SKIES: { value: Sky; label: string; hint: string }[] = [
  { value: "clock", label: "Follows your clock", hint: "Dusk from 6 pm to 7 am, day the rest of the time." },
  { value: "theme", label: "Follows your theme", hint: "Dusk in dark mode, day in light mode." },
];

export type WorldSettingsDeps = {
  sky: Sky;
  onSky(sky: Sky): void;
};

export function createWorldSettings({ sky, onSky }: WorldSettingsDeps) {
  const button = h("button", { type: "button", class: "btn world-settings-button", "aria-haspopup": "dialog", "aria-label": "World settings", title: "World settings" }, gearIcon());
  const panel = h(
    "div",
    { class: "world-card world-settings-panel", id: "world-settings-panel", role: "dialog", "aria-label": "World settings" },
    h("div", { class: "world-settings-title" }, "World settings"),
    h(
      "fieldset",
      null,
      h("legend", null, "Sky"),
      SKIES.map(({ value, label, hint }) =>
        h(
          "label",
          { class: "world-settings-choice" },
          h("input", { type: "radio", name: "world-sky", value, checked: value === sky, onchange: () => onSky(value) }),
          h("span", null, h("span", { class: "world-settings-label" }, label), h("span", { class: "meta" }, hint)),
        ),
      ),
    ),
  );
  const root = h("div", { class: "world-settings" }, button, panel);
  const pop = popover(root, button, panel, () => panel.querySelector<HTMLElement>("input:checked")?.focus());
  return { root, isOpen: pop.isOpen, destroy: pop.destroy };
}

function gearIcon(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const el = document.createElementNS(NS, "svg");
  for (const [name, value] of Object.entries({ viewBox: "0 0 16 16", width: "16", height: "16", fill: "none", stroke: "currentColor", "stroke-width": "1.3", "stroke-linejoin": "round", "aria-hidden": "true" })) el.setAttribute(name, value);
  const corner = (angle: number, radius: number) => `${(8 + Math.cos(angle) * radius).toFixed(2)} ${(8 + Math.sin(angle) * radius).toFixed(2)}`;
  const teeth = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return [corner(a - 0.3, 5), corner(a - 0.17, 6.9), corner(a + 0.17, 6.9), corner(a + 0.3, 5)].join(" L ");
  });
  const outline = document.createElementNS(NS, "path");
  outline.setAttribute("d", `M ${teeth.join(" L ")} Z`);
  const middle = document.createElementNS(NS, "circle");
  for (const [name, value] of [["cx", "8"], ["cy", "8"], ["r", "2.1"]] as const) middle.setAttribute(name, value);
  el.append(outline, middle);
  return el;
}
