import { mainSite } from "../../../../shared/catalog.ts";
import { duration } from "../../../../shared/format.ts";
import type { App } from "../../../../shared/types.ts";
import { h, safeHref } from "../../dom.ts";
import { clock, hostOf } from "../../format.ts";
import { appIcon, ext, lamp, status } from "../../ui.ts";
import { KIND } from "./incidents.ts";
import { tabsOf } from "./tabs.ts";
import type { AppPage, AppTab } from "./page.ts";

const RECOVERED_SHOWN_MS = 30 * 60_000;

// The incident's kind ("CI", "Expiry"), unless its reason already says it:
// "CI failing on main" needs no "· CI" after it.
function kindUnlessSaid(kind: string, reason: string): string | undefined {
  const label = KIND[kind] ?? kind;
  return new RegExp(`\\b${label}\\b`, "i").test(reason) ? undefined : label;
}

// What every tab starts with: the app's name and state, the tabs, and an
// open incident or a recent recovery.

export function header(page: AppPage, a: App, checkNow: HTMLElement) {
  const site = mainSite(a);
  const ms = site ? page.status?.checks[site.id]?.ms : undefined;
  return h(
    "div",
    { class: "page-header" },
    h(
      "div",
      null,
      h("a", { class: "btn btn--sm back-button", href: "#/" }, h("span", { "aria-hidden": "true" }, "←"), "All apps"),
      h("div", { class: "app-title" }, appIcon(a, { large: true }), h("h1", null, a.name), status(page.status?.state ?? "checking", { ms })),
      h("span", { class: "app-url" }, ext(safeHref(a.url), hostOf(a.url))),
    ),
    h("div", { class: "actions" }, checkNow),
  );
}

export function tabs(page: AppPage, a: App) {
  const link = (key: AppTab, text: string) =>
    h("a", { href: key === "overview" ? page.base : `${page.base}/${key}`, ...(page.tab === key ? { "aria-current": "page" } : {}) }, text);
  return h("nav", { class: "tabs", "aria-label": "App sections" }, tabsOf(page, a).map((t) => link(t.key, t.label)));
}

export function banner(page: AppPage) {
  const open = page.status?.incident;
  if (open) {
    const outage = open.kind === "outage";
    return h(
      "div",
      { class: `banner banner--${outage ? "down" : "attention"}`, role: "status" },
      lamp(outage ? "down" : "attention"),
      h("strong", null, outage ? `Down: ${open.reason}` : open.reason),
      h("span", { class: "meta" }, [`for ${duration(Date.now() - Date.parse(open.startedAt))}`, `since ${clock(open.startedAt)}`, kindUnlessSaid(open.kind, open.reason)].filter(Boolean).join(" · ")),
    );
  }
  // (An app that isn't live yet didn't recover from anything.)
  const last = page.app?.live ? page.hist?.incidents.find((i) => i.endedAt) : undefined;
  if (last?.endedAt && Date.now() - Date.parse(last.endedAt) < RECOVERED_SHOWN_MS) {
    return h(
      "div",
      { class: "banner banner--up", role: "status" },
      lamp("up"),
      h("strong", null, `Recovered after ${duration(Date.parse(last.endedAt) - Date.parse(last.startedAt))}`),
      h("span", { class: "meta" }, `at ${clock(last.endedAt)} · ${last.reason}`),
    );
  }
  return null;
}
