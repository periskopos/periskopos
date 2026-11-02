import { updateView } from "../../shared/desktop.ts";
import type { UpdateSnapshot, UpdateState } from "../../shared/desktop.ts";
import { desktopBridge } from "./desktop.ts";
import type { DesktopBridge } from "./desktop.ts";
import { h, mount } from "./dom.ts";
import { popover } from "./popover.ts";
import { ago } from "./format.ts";

// The title bar's update button: the version running and where its updates
// stand, in a small panel, with the one thing to do (check, restart to
// update, download). A dot on the button when an update is waiting. The
// updater itself is the shell's (desktop/updater.ts); this only shows it.
//
// Built once and moved into each new top bar, like the window controls:
// the preload can't remove a listener, so one per page would pile up.

let built: HTMLElement | null | undefined;

export function updateButton(): HTMLElement | null {
  if (built === undefined) built = buildUpdateButton(desktopBridge());
  return built;
}

// The shape the shell sends, checked: the page acts on nothing else.
export function parseSnapshot(raw: unknown): UpdateSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { version, state } = raw as { version?: unknown; state?: unknown };
  if (typeof version !== "string" || typeof state !== "object" || state === null) return undefined;
  const kind = (state as { kind?: unknown }).kind;
  if (!["idle", "checking", "downloading", "ready", "available", "unavailable"].includes(String(kind))) return undefined;
  return { version, state: state as UpdateState };
}

export function buildUpdateButton(bridge: DesktopBridge | null): HTMLElement | null {
  if (!bridge?.onUpdateState || !bridge.updateAction) return null;
  const act = bridge.updateAction;

  const dot = h("span", { class: "update-dot", hidden: true });
  const button = h(
    "button",
    { type: "button", class: "update-btn", "aria-haspopup": "dialog", title: "Updates", "aria-label": "Updates" },
    arrowIcon(),
    dot,
  );
  const panel = h("div", { class: "update-panel", id: "update-panel", role: "dialog", "aria-label": "Updates" });
  const root = h("div", { class: "update" }, button, panel);

  let snapshot: UpdateSnapshot | undefined;

  const draw = () => {
    if (!snapshot) return;
    const view = updateView(snapshot);
    dot.hidden = !view.attention;
    button.setAttribute("aria-label", view.attention ? `Updates: ${view.status}` : "Updates");
    button.title = view.attention ? view.status : "Updates";
    mount(
      panel,
      h("p", { class: "update-version" }, `Periskopos ${snapshot.version}`),
      h(
        "p",
        { class: `update-status${view.attention ? " update-status--ready" : ""}`, role: "status" },
        view.busy && h("span", { class: "update-spinner", "aria-hidden": "true" }),
        view.status,
        view.checkedAt && h("span", { class: "meta" }, ` · checked ${ago(view.checkedAt)}`),
      ),
      view.detail && h("p", { class: "update-detail meta" }, view.detail),
      view.action &&
        h(
          "button",
          {
            type: "button",
            class: `btn btn--sm${view.action.kind === "check" ? "" : " btn--primary"}`,
            onclick: () => {
              const kind = view.action!.kind;
              act(kind);
              // Restarting or downloading takes over from here.
              if (kind !== "check") pop.close();
            },
          },
          view.action.label,
        ),
    );
  };

  const pop = popover(root, button, panel, draw);

  bridge.onUpdateState((raw) => {
    const next = parseSnapshot(raw);
    if (!next) return;
    snapshot = next;
    draw();
  });
  return root;
}

// An arrow down to a line: "get the new version".
function arrowIcon(): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 10 10");
  el.setAttribute("width", "12");
  el.setAttribute("height", "12");
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");
  for (const d of ["M5 1 V6.5", "M2.5 4.5 5 7 7.5 4.5", "M1.5 9 H8.5"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    el.append(path);
  }
  return el;
}
