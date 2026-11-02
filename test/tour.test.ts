import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { dom, text } from "./dom-helpers.ts";
import { queueTour, startQueuedTour, startTour } from "../web/src/tour.ts";

// The guided tour: it starts once after the first run, walks its stops,
// passes over a stop that isn't on screen, and ends by its buttons or Escape.

// It follows its stop frame by frame; here one frame is enough.
Object.assign(globalThis, { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {}, innerWidth: 1200, innerHeight: 800 });

const card = () => document.querySelector(".tour-card");
// Asserts get yes or no, never the element: a failing assert prints what it
// was given, and printing a node of the whole page never ends.
const open = () => card() !== null;
// Where it is: "2 of 4 · Apps".
const at = () => `${text(card()?.querySelector(".tour-step"))} · ${text(card()?.querySelector(".tour-title"))}`;
const press = (label: string) => [...(card()?.querySelectorAll("button") ?? [])].find((b) => text(b) === label)!.click();
const key = (k: string) => document.dispatchEvent(new dom.KeyboardEvent("keydown", { key: k }) as unknown as Event);

// happy-dom lays nothing out, so every stop with a target counts as off
// screen unless it's given a size.
function nav(...hrefs: string[]) {
  const bar = document.createElement("nav");
  bar.className = "nav";
  for (const href of hrefs) {
    const a = document.createElement("a");
    a.setAttribute("href", href);
    a.getBoundingClientRect = () => ({ left: 100, top: 10, right: 160, bottom: 40, width: 60, height: 30, x: 100, y: 10, toJSON() {} }) as DOMRect;
    bar.append(a);
  }
  document.body.append(bar);
}

beforeEach(() => {
  key("Escape"); // a tour a failed test left open
  document.body.querySelectorAll("nav").forEach((n) => n.remove());
  localStorage.clear();
});

describe("the guided tour", () => {
  test("starts once after the first run, and not again", () => {
    startQueuedTour();
    assert.equal(open(), false, "nothing queued: no tour");
    queueTour();
    startQueuedTour();
    assert.equal(open(), true);
    key("Escape");
    assert.equal(open(), false);
    startQueuedTour();
    assert.equal(open(), false, "seen: it doesn't come back");
  });

  test("walks only the stops on screen, Back and Next, then Done", () => {
    nav("#/", "#/settings");
    startTour();
    assert.equal(at(), "1 of 4 · A quick look around");
    assert.ok(document.activeElement === card()?.querySelector(".tour-next"), "Next has the focus");
    press("Next");
    assert.equal(at(), "2 of 4 · Apps");
    assert.equal(document.querySelector<HTMLElement>(".tour-spotlight")?.style.left, "96px");
    press("Back");
    assert.match(at(), /^1 of 4 ·/);
    key("ArrowRight");
    key("ArrowRight");
    assert.equal(at(), "3 of 4 · Settings");
    press("Next");
    assert.equal(at(), "4 of 4 · That's the tour");
    assert.ok(!text(card()).includes("Skip"), "the last stop only has Done");
    press("Done");
    assert.equal(document.querySelector(".tour") === null, true, "the tour is gone");
  });

  test("Skip ends it, and it can be taken again from Settings", () => {
    startTour();
    press("Skip");
    assert.equal(open(), false);
    startTour();
    assert.equal(open(), true);
  });
});
