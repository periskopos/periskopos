import type { NotificationItem, ProviderStatus } from "../../../shared/types.ts";
import { h } from "../dom.ts";
import { STATE_LABEL } from "../format.ts";
import { ext, lamp, section, timeAgo } from "../ui.ts";
import { isNotable, providerLamp } from "./providers.ts";

// Needs attention (Apps): what wants looking at, wherever it comes from, so
// the first page answers "is anything wrong?" without a visit to each tab:
// the title bar's notifications (an app's open problem, an account's
// failing or expiring key) and a provider's trouble in the parts my apps
// use. Nothing wrong: nothing drawn (the page's header says so).
export function attentionCount(items: NotificationItem[], providers: ProviderStatus[]) {
  return items.length + providers.filter(isNotable).length;
}

export function attentionSection(items: NotificationItem[], providers: ProviderStatus[]) {
  const notable = providers.filter(isNotable);
  if (items.length + notable.length === 0) return null;
  return section("Needs attention", {
    list: h("ul", { class: "list attention-list" }, items.map(problemItem), notable.map(providerItem)),
  });
}

// An app or an account: what's wrong, linked to where it's fixed.
function problemItem(n: NotificationItem) {
  return h(
    "li",
    { class: "item" },
    lamp(n.state, { label: STATE_LABEL[n.state] }),
    h("div", { class: "item-main" }, h("span", { class: "item-title" }, h("a", { href: n.href }, n.title)), h("span", { class: `reason reason--${n.state}` }, n.text)),
    n.since && h("div", { class: "item-end meta" }, timeAgo(n.since, "started ")),
  );
}

// A provider: its incident (or what its page says), the apps it touches,
// and its status page.
function providerItem(p: ProviderStatus) {
  const incident = p.incidents.find((i) => i.affectsYou);
  const names = p.apps.map((a) => a.name).join(", ");
  return h(
    "li",
    { class: "item" },
    lamp(providerLamp(p), { label: p.relevantIndicator === "maintenance" ? "Maintenance" : "Provider trouble" }),
    h(
      "div",
      { class: "item-main" },
      h("span", { class: "item-title" }, h("a", { href: "#/status" }, p.label)),
      h("span", { class: "secondary" }, incident?.name ?? p.description, names && h("span", { class: "meta" }, ` · affects ${names}`)),
    ),
    h("div", { class: "item-end meta" }, ext(incident?.url ?? p.pageUrl, "status page")),
  );
}
