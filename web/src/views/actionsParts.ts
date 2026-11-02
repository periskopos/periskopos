import type { ActionDef, ActionResult, ActivityEntry, App, BlockedAction } from "../../../shared/types.ts";
import { h } from "../dom.ts";
import { errorBox, field, lamp, section, timeAgo } from "../ui.ts";

// The actions panel (PRD §7.8): what can be done to an app, behind a
// confirmation, with a record of everything that was.

export type ActionsList = { actions: ActionDef[]; blocked: BlockedAction[] };
export type ActionOutcome = ActionResult & { label: string };

// ── The confirmation (FR-X2) ────────────────────────────────────────────

let dialogs = 0;

// A native <dialog>: focus stays inside it, Escape closes it, and screen
// readers announce it. Cancel is focused first, so Enter never runs
// anything by accident; a dangerous action instead asks for the app's name.
// `run` does the work; if it throws, the error shows here and the dialog
// stays open.
export function openActionDialog(app: App, action: ActionDef, run: (confirmName: string | undefined) => Promise<void>) {
  const id = `action-dialog-${++dialogs}`;
  const dialog = h("dialog", { class: "dialog", "aria-labelledby": `${id}-title`, "aria-describedby": `${id}-text` });
  const errors = h("div");
  const nameMatches = (value: string) => value.trim().toLowerCase() === app.name.trim().toLowerCase();

  const name = action.danger
    ? h("input", { name: "confirmName", autocomplete: "off", spellcheck: false, autofocus: true, placeholder: app.name, "aria-required": "true" })
    : undefined;
  const confirm = h("button", { type: "submit", class: action.danger ? "btn btn--danger-solid" : "btn btn--primary", disabled: action.danger }, action.label);
  const cancel = h("button", { type: "button", class: "btn", autofocus: !action.danger, onclick: () => dialog.close() }, "Cancel");
  let busy = false;

  name?.addEventListener("input", () => {
    confirm.disabled = !nameMatches(name.value);
  });

  const form = h(
    "form",
    { class: "form", novalidate: true },
    h("h2", { id: `${id}-title` }, `Run “${action.label}” on ${app.name}?`),
    h(
      "div",
      { id: `${id}-text`, class: "stack-sm" },
      action.description ? h("p", { class: "secondary" }, action.description) : null,
      h("p", { class: "meta" }, `Done through ${action.service}. It changes the live app, and is recorded in the activity log.`),
      action.danger ? h("p", { class: "reason reason--down" }, "This action is marked dangerous.") : null,
    ),
    name && field(`Type ${app.name} to confirm`, name),
    errors,
    h("div", { class: "actions actions--end" }, cancel, confirm),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (busy || (name && !nameMatches(name.value))) return;
    busy = true;
    errors.replaceChildren();
    confirm.disabled = true;
    cancel.disabled = true;
    confirm.setAttribute("aria-busy", "true");
    confirm.textContent = "Running…";
    try {
      await run(name?.value);
      dialog.close();
    } catch (err) {
      errors.replaceChildren(errorBox(err));
      confirm.removeAttribute("aria-busy");
      confirm.textContent = action.label;
      confirm.disabled = name ? !nameMatches(name.value) : false;
      cancel.disabled = false;
      busy = false;
    }
  });

  // Escape can't abandon an action that's already running.
  dialog.addEventListener("cancel", (event) => {
    if (busy) event.preventDefault();
  });
  dialog.addEventListener("close", () => dialog.remove());

  dialog.append(form);
  document.body.append(dialog);
  dialog.showModal();
}

// ── On the Overview ─────────────────────────────────────────────────────

export function actionsSection(
  list: ActionsList | undefined,
  outcome: ActionOutcome | undefined,
  activity: ActivityEntry[],
  links: { history?: string; services: string },
  hooks: { open: (action: ActionDef) => void; dismiss: () => void },
) {
  // An app with nothing to do (no host, no protocol) shows no panel at all.
  if (!list || (list.actions.length === 0 && list.blocked.length === 0)) return null;

  const rows = [
    ...list.actions.map((a) =>
      h(
        "li",
        { class: "item" },
        h(
          "div",
          { class: "item-main" },
          h("span", { class: "item-title" }, h("strong", null, a.label), a.danger && h("span", { class: "tag" }, "danger")),
          a.description && h("span", { class: "meta" }, a.description),
          h("span", { class: "meta" }, `via ${a.service}`),
        ),
        h("div", { class: "item-end" }, h("button", { type: "button", class: "btn", onclick: () => hooks.open(a), "aria-haspopup": "dialog" }, `${a.label}…`)),
      ),
    ),
    ...list.blocked.map((b) =>
      h(
        "li",
        { class: "item" },
        lamp("none"),
        h("div", { class: "item-main" }, h("span", { class: "item-title secondary" }, b.label), h("span", { class: "meta" }, b.reason)),
        h("div", { class: "item-end" }, h("a", { href: links.services }, "Accounts")),
      ),
    ),
  ];

  return [
    outcome &&
      h(
        "div",
        { class: `banner banner--${outcome.ok ? "up" : "attention"}`, role: "status" },
        lamp(outcome.ok ? "up" : "attention"),
        h("strong", null, `${outcome.label}: ${outcome.ok ? "done" : "didn't go through"}`),
        h("span", { class: "meta banner-text" }, outcome.message),
        h("button", { type: "button", class: "btn btn--ghost btn--sm", onclick: hooks.dismiss }, "Dismiss"),
      ),
    section("Actions", {
      list: h("ul", { class: "list" }, rows),
      foot: links.history && activity.length > 0 ? h("a", { href: links.history }, `Recent: ${activity[0].label} ${activity[0].ok ? "worked" : "failed"} · all activity`) : undefined,
    }),
  ];
}

// ── The record (FR-X3) ──────────────────────────────────────────────────

export function activityList(entries: ActivityEntry[]) {
  return h(
    "ul",
    { class: "list" },
    entries.map((e) =>
      h(
        "li",
        { class: "item" },
        lamp(e.ok ? "up" : "down", { label: e.ok ? "worked" : "failed" }),
        h(
          "div",
          { class: "item-main" },
          h("span", { class: "item-title" }, h("strong", null, e.label), h("span", { class: "tag" }, e.source === "mcp" ? (e.agent ?? "AI assistant") : "You")),
          h("span", { class: e.ok ? "meta" : "reason reason--down" }, e.message),
        ),
        h("span", { class: "item-end meta" }, timeAgo(e.at)),
      ),
    ),
  );
}
