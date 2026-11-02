import assert from "node:assert/strict";
import { test } from "node:test";
// First: it puts the DOM in place, which the page's modules need as they load.
import { dom } from "./dom-helpers.ts";
import { windowControls } from "../web/src/windowControls.ts";

// The frameless window's own title bar on Windows and Linux. With no native
// title bar there's no menu bar, so the menu (File, View, Help → Report an
// issue) has to be reachable from here: a button, and a tap of Alt.

test("the menu opens from its button and from a tap of Alt, and Alt as a modifier leaves it shut", () => {
  const asked: [number, number][] = [];
  const noop = () => {};
  (globalThis as { periskoposShell?: unknown }).periskoposShell = {
    platform: "win32",
    onNavigate: noop,
    minimizeWindow: noop,
    toggleMaximizeWindow: noop,
    closeWindow: noop,
    hardReloadWindow: noop,
    showMenu: (x: number, y: number) => asked.push([x, y]),
  };
  try {
    const controls = windowControls()!;
    assert.equal(controls === null, false, "drawn on Windows");
    document.body.append(controls);
    const menu = controls.querySelector<HTMLButtonElement>('button[aria-label="Open the menu"]');
    const order = [...controls.querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    assert.deepEqual(order, ["Reload window", "Open the menu", "Minimize window", "Maximize window", "Close window"], "after Reload, before Minimize");

    menu!.click();
    assert.equal(asked.length, 1, "the button opens it");
    assert.equal(asked[0]!.every((n) => typeof n === "number" && Number.isFinite(n)), true, "at a point in the page");

    const key = (type: string, init: Record<string, unknown>) => dom.dispatchEvent(new dom.KeyboardEvent(type, init));
    key("keydown", { key: "Alt" });
    key("keyup", { key: "Alt" });
    assert.equal(asked.length, 2, "a tap of Alt opens it");

    key("keydown", { key: "Alt" });
    key("keydown", { key: "Tab", altKey: true });
    key("keyup", { key: "Tab", altKey: true });
    key("keyup", { key: "Alt" });
    assert.equal(asked.length, 2, "Alt+Tab doesn't");

    key("keydown", { key: "Control", ctrlKey: true });
    key("keydown", { key: "Alt", ctrlKey: true });
    key("keyup", { key: "Alt", ctrlKey: true });
    assert.equal(asked.length, 2, "nor Ctrl+Alt");
  } finally {
    delete (globalThis as { periskoposShell?: unknown }).periskoposShell;
  }
});
