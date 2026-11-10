import assert from "node:assert/strict";
import { describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text, until } from "./dom-helpers.ts";
import { mount } from "../web/src/dom.ts";
import { compactCount } from "../web/src/views/app/chart.ts";
import { pauseBanners } from "../web/src/views/app/pauseButton.ts";
import type { AppPage } from "../web/src/views/app/page.ts";
import { pauseSection } from "../web/src/views/alertPause.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import type { App, Settings } from "../shared/types.ts";

const apps = [{ id: "a1", slug: "one", name: "One" }, { id: "a2", slug: "two", name: "Two" }] as App[];

describe("counts", () => {
  test("never say 1000k", () => {
    assert.equal(compactCount(999), "999");
    assert.equal(compactCount(999_499), "999k");
    assert.equal(compactCount(999_500), "1M");
    assert.equal(compactCount(1_500_000), "1.5M");
  });
});

describe("pausing in Settings", () => {
  const draw = (settings: Settings, choice: { value: string }, saved: unknown[]) => {
    const el = document.createElement("div");
    mount(
      el,
      pauseSection(settings, 0, apps, async (patch) => void saved.push(["all", patch]), async (app, at) => void saved.push([app.slug, at]), choice),
    );
    return el;
  };
  const button = (el: Element, label: string) => [...el.querySelectorAll("button")].find((b) => b.textContent === label)!;
  const selectedText = (el: Element) => text(el.querySelector("select[name=pauseWhat] option[selected]"));

  test("the app you chose is still chosen after a redraw", () => {
    const choice = { value: "" };
    const el = draw(DEFAULT_SETTINGS, choice, []);
    const select = el.querySelector("select[name=pauseWhat]") as HTMLSelectElement;
    select.value = "a2";
    select.dispatchEvent(new Event("change"));
    assert.equal(choice.value, "a2");
    assert.equal(selectedText(draw(DEFAULT_SETTINGS, choice, [])), "Two");
  });

  test("one app's pause goes on its own, never the whole list from an old copy", async () => {
    const saved: unknown[][] = [];
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const el = draw({ ...DEFAULT_SETTINGS, appPauses: { a2: later } }, { value: "a1" }, saved);
    const select = el.querySelector("select[name=pauseWhat]") as HTMLSelectElement;
    select.value = "a1";
    button(el, "For 1 hour").click();
    await until(() => saved.length === 1);
    assert.equal(saved[0]![0], "one");
    button(el, "Resume").click();
    await until(() => saved.length === 2);
    assert.deepEqual(saved[1], ["two", ""]);
  });

  test("All alerts still pauses all alerts", async () => {
    const saved: unknown[][] = [];
    const el = draw(DEFAULT_SETTINGS, { value: "" }, saved);
    button(el, "For 1 hour").click();
    await until(() => saved.length === 1);
    assert.equal(saved[0]![0], "all");
    assert.ok((saved[0]![1] as Partial<Settings>).alertsPausedUntil);
  });
});

describe("the pause banner", () => {
  test("Resume says what happened even when the page's own redraw is held back", async () => {
    const real = globalThis.fetch;
    globalThis.fetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    try {
      let drawn = 0;
      const page = {
        app: apps[0],
        apiBase: "/apps/one",
        pause: { app: new Date(Date.now() + 3_600_000).toISOString() },
        pauseEdits: 0,
        draw: () => assert.fail("the page's redraw can be held back, so it can't be relied on"),
        drawPause: () => drawn++,
      } as unknown as AppPage;
      const el = document.createElement("div");
      mount(el, pauseBanners(page));
      [...el.querySelectorAll("button")].find((b) => b.textContent === "Resume")!.click();
      await until(() => drawn === 1);
      assert.deepEqual(page.pause, {});
      assert.ok(page.pauseEdits > 0, "so an older answer can't undo it");
    } finally {
      globalThis.fetch = real;
    }
  });
});
