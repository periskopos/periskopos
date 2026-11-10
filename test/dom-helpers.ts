import { readFileSync } from "node:fs";
import { Window } from "happy-dom";

// A DOM for the UI's tests (happy-dom), and what they check with it. Import
// this before any web/src module: ui.ts adds its toast area to the page as
// it loads.

export const dom = new Window({ url: "http://127.0.0.1:4101/" });
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  Node: dom.Node,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  SVGElement: dom.SVGElement,
  Event: dom.Event,
  KeyboardEvent: dom.KeyboardEvent,
  localStorage: dom.localStorage,
  // A form's own FormData: Node's can't read a happy-dom form.
  FormData: dom.FormData,
});

// What Vite fills in when it builds the page (web/vite.config.ts).
Object.assign(globalThis, {
  __APP_VERSION__: (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version,
});

// The pages refresh themselves on timers; in a test those mustn't keep the
// process alive once the tests are done.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = ((handler: () => void, ms?: number) => realSetInterval(handler, ms).unref()) as typeof setInterval;

export const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

// A section, found by its heading: section("Deploys") draws
// <section aria-labelledby="s-deploys">.
export const sectionOf = (root: ParentNode, title: string) => root.querySelector(`[aria-labelledby=s-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}]`);

// Lets the page's requests answer and its redraws run.
export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// Waits until the page shows something (its requests answered, its redraw
// run), instead of a fixed time a busy machine can overrun. Gives up after
// `ms` and lets the test's own assertion say what's missing.
export async function until(ready: () => unknown, ms = 2000) {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) await settle(10);
}

// Everything a keyboard or a screen reader can reach has a name: its text,
// an aria-label, a label wrapped around it, or (an image) alt text, empty
// when the image only decorates (WCAG 4.1.2, 1.1.1, 3.3.2). What's hidden
// from a screen reader doesn't count as a name.
export function unnamed(root: Element): string[] {
  const spoken = (el: Element | null | undefined): string => {
    if (!el) return "";
    const copy = el.cloneNode(true) as Element;
    for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) hidden.remove();
    return text(copy);
  };
  const nameOf = (el: Element): string => {
    const labelledBy = el.getAttribute("aria-labelledby");
    const byLabel = labelledBy ? spoken(root.ownerDocument.getElementById(labelledBy) ?? root.querySelector(`#${labelledBy}`)) : "";
    return (el.getAttribute("aria-label") ?? "").trim() || byLabel || (el.closest("label") ? spoken(el.closest("label")) : "") || (el.id ? spoken(root.querySelector(`label[for="${el.id}"]`)) : "") || el.getAttribute("title") || spoken(el);
  };
  const missing: string[] = [];
  for (const el of root.querySelectorAll("a[href], button, input, select, textarea, [tabindex], [role=img]")) {
    if (el.getAttribute("type") === "hidden" || el.closest("[aria-hidden=true]")) continue;
    if (!nameOf(el)) missing.push(el.outerHTML.slice(0, 120));
  }
  for (const img of root.querySelectorAll("img")) if (!img.hasAttribute("alt")) missing.push(img.outerHTML.slice(0, 120));
  return missing;
}
