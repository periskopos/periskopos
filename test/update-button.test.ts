import assert from "node:assert/strict";
import { describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text, unnamed } from "./dom-helpers.ts";
import { updateView } from "../shared/desktop.ts";
import type { UpdateAction, UpdateState } from "../shared/desktop.ts";
import type { DesktopBridge } from "../web/src/desktop.ts";
import { buildUpdateButton, parseSnapshot } from "../web/src/updateButton.ts";

// The title bar's update button: what it says for each state of the
// updater, and that it asks the shell for exactly what was chosen.

const view = (state: UpdateState) => updateView({ version: "0.2.14", state });

describe("what the update panel says", () => {
  test("up to date, never checked, or why a check failed: always a way to check", () => {
    assert.deepEqual(view({ kind: "idle", checkedAt: "2026-10-18T19:00:00Z" }), { status: "Up to date", checkedAt: "2026-10-18T19:00:00Z", action: { kind: "check", label: "Check now" }, busy: false, attention: false });
    assert.equal(view({ kind: "idle" }).status, "Not checked yet");
    const failed = view({ kind: "idle", problem: "Log in with gh auth login" });
    assert.equal(failed.status, "Couldn't check for updates");
    assert.equal(failed.detail, "Log in with gh auth login");
    assert.equal(failed.action?.kind, "check");
  });

  test("busy: nothing to press", () => {
    assert.deepEqual([view({ kind: "checking" }), view({ kind: "downloading", version: "0.2.15" })].map((v) => [v.status, v.busy, v.action]), [
      ["Checking for updates…", true, undefined],
      ["Downloading 0.2.15…", true, undefined],
    ]);
  });

  test("an update waiting gets the dot and the one thing to do", () => {
    const ready = view({ kind: "ready", version: "0.2.15" });
    assert.equal(ready.status, "0.2.15 is ready");
    assert.deepEqual(ready.action, { kind: "install", label: "Restart to update" });
    assert.equal(ready.attention, true);
    assert.deepEqual(view({ kind: "available", version: "0.2.15" }).action, { kind: "download", label: "Download 0.2.15" });
    assert.equal(view({ kind: "unavailable", reason: "Only the installed app updates itself." }).action, undefined);
  });
});

// A shell bridge that records what the page asks for, and sends what a
// test tells it to.
function fakeBridge() {
  let send: (raw: unknown) => void = () => {};
  const asked: UpdateAction[] = [];
  const bridge: DesktopBridge = {
    platform: "win32",
    onNavigate: () => {},
    onUpdateState: (handler) => {
      send = handler;
    },
    updateAction: (action) => asked.push(action),
  };
  return { bridge, asked, send: (state: UpdateState) => send({ version: "0.2.14", state }) };
}

describe("the update button", () => {
  test("not in a browser tab, nor a shell without updates", () => {
    assert.equal(buildUpdateButton(null), null);
    assert.equal(buildUpdateButton({ platform: "win32", onNavigate: () => {} }), null);
  });

  test("opens on click, says where things stand, and does what's chosen", () => {
    const { bridge, asked, send } = fakeBridge();
    const root = buildUpdateButton(bridge)!;
    document.body.replaceChildren(root);
    const button = root.querySelector<HTMLButtonElement>(".update-btn")!;
    const panel = root.querySelector<HTMLElement>(".update-panel")!;

    send({ kind: "idle", checkedAt: new Date(Date.now() - 12 * 60_000).toISOString() });
    assert.equal(panel.hidden, true);
    assert.equal(root.querySelector<HTMLElement>(".update-dot")!.hidden, true, "nothing waiting: no dot");
    button.click();
    assert.equal(panel.hidden, false);
    assert.equal(button.getAttribute("aria-expanded"), "true");
    assert.match(text(panel), /Periskopos 0\.2\.14/);
    assert.match(text(panel), /Up to date · checked 12 min ago/);
    panel.querySelector<HTMLButtonElement>("button")!.click();
    assert.deepEqual(asked, ["check"]);
    assert.equal(panel.hidden, false, "checking keeps it open, to see what it finds");

    // An update arrives while it's open: the panel and the button follow.
    send({ kind: "ready", version: "0.2.15" });
    assert.equal(root.querySelector<HTMLElement>(".update-dot")!.hidden, false);
    assert.equal(button.getAttribute("aria-label"), "Updates: 0.2.15 is ready");
    const restart = [...panel.querySelectorAll("button")].find((b) => text(b) === "Restart to update")!;
    restart.click();
    assert.deepEqual(asked, ["check", "install"]);
    assert.equal(panel.hidden, true, "restarting takes over");
  });

  test("Escape and a click elsewhere close it; every control has a name", () => {
    const { bridge, send } = fakeBridge();
    const root = buildUpdateButton(bridge)!;
    document.body.replaceChildren(root);
    send({ kind: "unavailable", reason: "Only the installed app updates itself; this one runs from the project folder." });
    const button = root.querySelector<HTMLButtonElement>(".update-btn")!;
    const panel = root.querySelector<HTMLElement>(".update-panel")!;

    button.click();
    assert.match(text(panel), /Updates are off here.*project folder/);
    assert.deepEqual(unnamed(root), []);
    root.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.hidden, true);

    button.click();
    assert.equal(panel.hidden, false, "open again before the click elsewhere");
    document.body.click();
    assert.equal(panel.hidden, true);
  });

  test("anything but the updater's own shape is ignored", () => {
    assert.equal(parseSnapshot(null), undefined);
    assert.equal(parseSnapshot({ version: "0.2.14" }), undefined);
    assert.equal(parseSnapshot({ version: "0.2.14", state: { kind: "rm -rf" } }), undefined);
    assert.deepEqual(parseSnapshot({ version: "0.2.14", state: { kind: "checking" } }), { version: "0.2.14", state: { kind: "checking" } });
  });
});
