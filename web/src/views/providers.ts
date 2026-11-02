import type { ProviderIndicator, ProviderStatus } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { h } from "../dom.ts";
import { ext, lamp, timeAgo } from "../ui.ts";
import type { LampState } from "../ui.ts";

// Provider status pages (FR-I3): "is it them, or me?". My apps only hear
// about trouble in the parts of a provider they use (relevantIndicator);
// the Accounts page shows everything the provider reports.

const degraded = (i: ProviderIndicator) => i === "minor" || i === "major" || i === "critical";
export const isDegraded = (p: ProviderStatus) => degraded(p.relevantIndicator);
export const isNotable = (p: ProviderStatus) => isDegraded(p) || p.relevantIndicator === "maintenance";

export async function loadProviders(): Promise<ProviderStatus[]> {
  try {
    return (await api<{ providers: ProviderStatus[] }>("GET", "/providers")).providers;
  } catch {
    return []; // a status page being unreachable must never break a screen
  }
}

const lampFor = (i: ProviderIndicator): LampState =>
  i === "none" ? "up" : degraded(i) ? "attention" : i === "maintenance" ? "info" : "unknown";

// As far as my apps are concerned (banners, the Apps page).
export const providerLamp = (p: ProviderStatus): LampState => lampFor(p.relevantIndicator);

// One line per provider with something that touches my apps; `only` limits
// it to the providers one app uses.
export function providerBanners(list: ProviderStatus[], only?: string) {
  const shown = list.filter((p) => isNotable(p) && (!only || p.apps.some((a) => a.slug === only)));
  return shown.map((p) => {
    const names = p.apps.map((a) => a.name).join(", ");
    const incident = p.incidents.find((i) => i.affectsYou);
    return h(
      "div",
      { class: `banner banner--${isDegraded(p) ? "attention" : "info"}`, role: "status" },
      lamp(providerLamp(p)),
      h("strong", null, `${p.label}: ${incident?.name ?? p.description}`),
      h("span", { class: "meta" }, names && !only ? `affects ${names} · ` : "", ext(incident?.url ?? p.pageUrl, "status page")),
    );
  });
}


// The provider's state in a line, for its account's card: what its status
// page says overall, when that was read, and a link to the page.
export function providerStatusLine(p: ProviderStatus) {
  return h(
    "span",
    { class: "key-line" },
    lamp(lampFor(p.indicator)),
    h("span", { class: "secondary" }, p.description),
    p.checkedAt && h("span", { class: "meta" }, timeAgo(p.checkedAt, " · checked ")),
    h("span", { class: "meta" }, " · ", ext(p.pageUrl, "status page")),
  );
}
