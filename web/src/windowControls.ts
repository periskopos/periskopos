import { desktopBridge } from "./desktop.ts";
import { h } from "./dom.ts";

// Reload / minimize / maximize / close for the app's frameless window. Windows
// and Linux have no native title bar in the desktop app, so these have nowhere
// else to live; a Mac keeps its own traffic lights and a browser tab has none,
// so this renders nothing there.

const svg = (viewBox: string, ...paths: string[]) => {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("viewBox", viewBox);
  el.setAttribute("width", "12");
  el.setAttribute("height", "12");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("fill", "none");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    el.append(path);
  }
  return el;
};

const ICONS = {
  menu: () => svg("0 0 10 10", "M1 2.5 H9", "M1 5 H9", "M1 7.5 H9"),
  reload: () => svg("0 0 10 10", "M8.5 1.5 A4 4 0 0 0 2.5 2.5", "M6.5 1.5 H8.5 V3.5", "M1.5 8.5 A4 4 0 0 0 7.5 7.5", "M3.5 8.5 H1.5 V6.5"),
  minimize: () => svg("0 0 10 10", "M0.5 5 H9.5"),
  maximize: () => svg("0 0 10 10", "M1 1 H9 V9 H1 Z"),
  restore: () => svg("0 0 10 10", "M2.5 1 H9 V7.5 H2.5 Z", "M0.8 2.8 V9.2 H7.2"),
  close: () => svg("0 0 10 10", "M0.7 0.7 9.3 9.3", "M9.3 0.7 0.7 9.3"),
};

// Built once and moved into each new top bar, like the fleet pill in ui.ts:
// shell() runs on every navigation, and the preload has no way to remove an
// onMaximizedChange listener, so building them per page would pile up one
// listener (and one detached button) per page visited.
let built: HTMLElement | null | undefined;

export function windowControls(): HTMLElement | null {
  if (built === undefined) built = buildWindowControls();
  return built;
}

function buildWindowControls(): HTMLElement | null {
  const bridge = desktopBridge();
  if (!bridge || bridge.platform === "darwin") return null;
  if (!bridge.minimizeWindow || !bridge.toggleMaximizeWindow || !bridge.closeWindow) return null;
  const { minimizeWindow, toggleMaximizeWindow, closeWindow, hardReloadWindow } = bridge;

  const maximizeIcon = h("span", { class: "window-controls-icon" }, ICONS.maximize());
  const maximizeButton = h("button", { type: "button", class: "window-controls-btn", title: "Maximize", "aria-label": "Maximize window", onclick: () => toggleMaximizeWindow() }, maximizeIcon);
  const showMaximized = (maximized: boolean) => {
    maximizeIcon.replaceChildren(maximized ? ICONS.restore() : ICONS.maximize());
    maximizeButton.title = maximized ? "Restore" : "Maximize";
    maximizeButton.setAttribute("aria-label", maximized ? "Restore window" : "Maximize window");
  };
  bridge.getMaximized?.(showMaximized);
  bridge.onMaximizedChange?.(showMaximized);

  const button = (label: string, icon: SVGElement, onclick: () => void, extra = "") =>
    h("button", { type: "button", class: `window-controls-btn${extra}`, title: label, "aria-label": `${label} window`, onclick }, icon);

  // No native title bar means no menu bar (File, View, Help): this opens the
  // same menu under the button, and so does a tap of Alt, as a menu bar would.
  const { showMenu } = bridge;
  let menuButton: HTMLButtonElement | null = null;
  if (showMenu) {
    const open = () => {
      const r = menuButton!.getBoundingClientRect();
      showMenu(r.left, r.bottom);
    };
    menuButton = h("button", { type: "button", class: "window-controls-btn", title: "Menu (Alt)", "aria-label": "Open the menu", "aria-haspopup": "menu", onclick: open }, ICONS.menu()) as HTMLButtonElement;
    let altAlone = false;
    window.addEventListener("keydown", (e) => {
      altAlone = e.key === "Alt" && !e.repeat && !e.ctrlKey && !e.shiftKey && !e.metaKey;
    });
    window.addEventListener("keyup", (e) => {
      if (e.key === "Alt" && altAlone && menuButton!.isConnected) {
        e.preventDefault();
        open();
      }
      altAlone = false;
    });
    window.addEventListener("blur", () => (altAlone = false));
  }

  return h(
    "div",
    { class: "window-controls" },
    hardReloadWindow && button("Reload", ICONS.reload(), () => hardReloadWindow()),
    menuButton,
    button("Minimize", ICONS.minimize(), () => minimizeWindow()),
    maximizeButton,
    button("Close", ICONS.close(), () => closeWindow(), " window-controls-btn--close"),
  );
}
