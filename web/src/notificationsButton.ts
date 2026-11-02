import { duration } from "../../shared/format.ts";
import type { NotificationItem, NotificationsView, RecoveredItem } from "../../shared/types.ts";
import { h, mount } from "./dom.ts";
import { ago } from "./format.ts";
import { popover } from "./popover.ts";
import type { Popover } from "./popover.ts";

// The title bar's notifications: a bell, with a count in the worst state's
// colour when something needs looking at, and a panel of what's wrong now
// (apps, and accounts whose key is failing or expiring) and what recovered
// in the last day. Each line opens where to look.
//
// Built once and moved into each new top bar, like the other title-bar
// buttons. The page fills it with show() and fail(); ui.ts does the asking.

export type NotificationsButton = { root: HTMLElement; show: (view: NotificationsView) => void; fail: (message: string) => void };

// "1 down · 2 need attention", or "All normal".
export function summaryOf(now: NotificationItem[]): string {
  const down = now.filter((n) => n.state === "down").length;
  const attention = now.length - down;
  const parts = [down && `${down} down`, attention && `${attention} need${attention === 1 ? "s" : ""} attention`].filter(Boolean);
  return parts.length ? parts.join(" · ") : "All normal";
}

export function buildNotificationsButton(): NotificationsButton {
  const badge = h("span", { class: "notify-badge", hidden: true });
  const button = h("button", { type: "button", class: "notify-btn", "aria-haspopup": "dialog", title: "Notifications", "aria-label": "Notifications" }, bellIcon(), badge);
  const panel = h("div", { class: "notify-panel", id: "notify-panel", role: "dialog", "aria-label": "Notifications" });
  const root = h("div", { class: "notify" }, button, panel);
  let pop: Popover | undefined;

  const item = (n: NotificationItem) =>
    h(
      "li",
      null,
      h(
        "a",
        { class: "notify-item", href: n.href, onclick: () => pop?.close() },
        h("span", { class: `lamp lamp--${n.state}`, "aria-hidden": "true" }),
        h(
          "span",
          { class: "notify-item-main" },
          // Spaces between the parts: the link's name reads as words, not "Moon-BaseCI failing".
          h("span", { class: "notify-item-title" }, n.title),
          " ",
          h("span", { class: `notify-item-text reason reason--${n.state}` }, n.text),
          n.since && [" ", h("span", { class: "meta" }, `for ${duration(Date.now() - Date.parse(n.since))}`)],
        ),
      ),
    );
  const recovered = (r: RecoveredItem) =>
    h(
      "li",
      null,
      h(
        "a",
        { class: "notify-item", href: r.href, onclick: () => pop?.close() },
        h("span", { class: "lamp lamp--up", "aria-hidden": "true" }),
        h(
          "span",
          { class: "notify-item-main" },
          h("span", { class: "notify-item-title" }, r.title),
          " ",
          h("span", { class: "notify-item-text" }, r.text),
          " ",
          h("span", { class: "meta" }, `recovered ${ago(r.endedAt)} after ${duration(Date.parse(r.endedAt) - Date.parse(r.startedAt))}`),
        ),
      ),
    );

  const show = (view: NotificationsView) => {
    const summary = summaryOf(view.now);
    const down = view.now.some((n) => n.state === "down");
    badge.hidden = view.now.length === 0;
    badge.textContent = String(view.now.length);
    badge.className = `notify-badge${down ? " notify-badge--down" : ""}`;
    button.setAttribute("aria-label", `Notifications: ${summary}`);
    button.title = summary;
    mount(
      panel,
      h("p", { class: "notify-head" }, summary),
      view.now.length > 0 && h("ul", { class: "notify-list" }, view.now.map(item)),
      view.now.length === 0 && h("p", { class: "meta notify-calm" }, "Nothing needs looking at."),
      view.earlier.length > 0 && [h("h2", { class: "label notify-subhead" }, "Recovered in the last day"), h("ul", { class: "notify-list" }, view.earlier.map(recovered))],
      h("a", { class: "notify-all", href: "#/", onclick: () => pop?.close() }, "All apps"),
    );
  };
  const fail = (message: string) => {
    badge.hidden = false;
    badge.textContent = "!";
    badge.className = "notify-badge notify-badge--unknown";
    button.setAttribute("aria-label", `Notifications: ${message}`);
    button.title = message;
    mount(panel, h("p", { class: "notify-head" }, message), h("a", { class: "notify-all", href: "#/", onclick: () => pop?.close() }, "All apps"));
  };

  pop = popover(root, button, panel);
  show({ now: [], earlier: [] });
  return { root, show, fail };
}

function bellIcon(): SVGElement {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", "0 0 12 12");
  el.setAttribute("width", "14");
  el.setAttribute("height", "14");
  el.setAttribute("fill", "none");
  el.setAttribute("aria-hidden", "true");
  for (const d of ["M3 8.5 V5.5 A3 3 0 0 1 9 5.5 V8.5 L10 9.5 H2 Z", "M5 10.5 A1 1 0 0 0 7 10.5"]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.1");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-linecap", "round");
    el.append(path);
  }
  return el;
}
