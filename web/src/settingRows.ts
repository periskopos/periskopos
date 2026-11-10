import { h } from "./dom.ts";
import type { Child } from "./dom.ts";

// A settings page's parts: one setting on one line, what it is on the left and
// its control on the right. A switch saves as soon as it's flipped; a choice
// among a few short words shows them all (a longer list stays a dropdown). A
// choice that waits for a button further on stays a checkbox (ui.ts).

export type RowOptions = { sub?: boolean };

const rowClass = (sub?: boolean, extra = "") => `setting-row${sub ? " setting-row--sub" : ""}${extra}`;

// What's inside a row, for a row that redraws itself (Updates).
export function rowParts(title: Child, hint: Child, control?: Child): Child[] {
  return [
    h("div", { class: "setting-row-label" }, h("span", { class: "field-label" }, title), hint && h("span", { class: "field-hint" }, hint)),
    control && h("div", { class: "setting-row-control" }, control),
  ];
}

export function settingRow(title: Child, hint: Child, control?: Child, { sub }: RowOptions = {}) {
  return h("div", { class: rowClass(sub) }, rowParts(title, hint, control));
}

// A row around one input or dropdown. The title is its name and the hint its
// description, so a screen reader says each once. `extra` sits beside it (a Save button).
export function inputRow(title: string, hint: Child, input: HTMLInputElement | HTMLSelectElement, extra?: Child) {
  input.id = `set-${input.name}`;
  const hintId = `${input.id}-hint`;
  if (hint) input.setAttribute("aria-describedby", hintId);
  return h(
    "div",
    { class: rowClass() },
    h("div", { class: "setting-row-label" }, h("label", { class: "field-label", for: input.id }, title), hint && h("span", { class: "field-hint", id: hintId }, hint)),
    h("div", { class: "setting-row-control" }, input, extra),
  );
}

// The whole row is the switch's label, so it can be clicked anywhere. Off and
// greyed out, the hint stays readable: it's where a row says why.
export function toggleRow(name: string, title: string, hint: string, checked: boolean, onchange: (on: boolean) => void, { disabled = false, sub }: RowOptions & { disabled?: boolean } = {}) {
  const hintId = `set-${name}-hint`;
  return h(
    "label",
    { class: rowClass(sub, " setting-row--toggle") },
    h("span", { class: "setting-row-label" }, h("span", { class: "field-label" }, title), h("span", { class: "field-hint", id: hintId }, hint)),
    h(
      "span",
      { class: "toggle" },
      h("input", {
        type: "checkbox",
        role: "switch",
        name,
        checked,
        disabled,
        "aria-label": title,
        "aria-describedby": hintId,
        onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
      }),
      h("span", { class: "toggle-track", "aria-hidden": "true" }),
    ),
  );
}

// Real radio buttons under the look, so the arrow keys and screen readers work
// as they always do, and a redraw keeps focus on the one chosen (dom.ts).
export function segmented<T extends string>(name: string, label: string, options: { value: T; label: string }[], current: T, onchange: (value: T) => void) {
  return h(
    "div",
    { class: "segmented", role: "radiogroup", "aria-label": label },
    options.map((o) =>
      h(
        "label",
        { class: "segmented-option" },
        h("input", { type: "radio", name, value: o.value, checked: o.value === current, onchange: () => onchange(o.value) }),
        h("span", null, o.label),
      ),
    ),
  );
}
