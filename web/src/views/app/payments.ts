import type { PaymentsDetails, PaymentsRevenue } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, figure, section } from "../../ui.ts";
import { detailsError } from "./details.ts";

// ── Payments: what a payment provider (Stripe, Paddle…) says ───────────
// One panel for every provider: revenue, failed payments, webhooks. What a
// provider can't say is left out, never shown as zero.

// An amount in a currency's smallest unit (cents), in that currency.
export function money(minor: number, currency: string): string {
  try {
    const fmt = new Intl.NumberFormat(undefined, { style: "currency", currency, notation: Math.abs(minor) >= 10_000_000 ? "compact" : "standard" });
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return fmt.format(minor / 10 ** digits);
  } catch {
    return `${(minor / 100).toFixed(2)} ${currency}`;
  }
}

// "+12% on the week before"
function weekChange(r: PaymentsRevenue): string {
  if (r.prev7d === 0) return r.last7d ? "none the week before" : "nothing this week";
  const pct = Math.round((r.last7d / r.prev7d - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}% on the week before`;
}

export function paymentsSection(d: PaymentsDetails | Error | undefined) {
  const loaded = d && !(d instanceof Error) ? d : undefined;
  const main = loaded?.revenue[0];
  const others = loaded?.revenue.slice(1) ?? [];
  const floor = loaded?.partial ? "at least " : "";
  return section("Payments", {
    action: loaded ? ext(loaded.link.url, loaded.link.label) : undefined,
    list:
      d instanceof Error
        ? detailsError(d)
        : !loaded
          ? empty("Loading…")
          : h(
              "div",
              { class: "section-body" },
              h(
                "div",
                { class: "figures", role: "group", "aria-label": `Payments in ${loaded.provider}${loaded.mode === "test" ? ", test mode" : ""}` },
                figure("Revenue · 7 days", main ? `${floor}${money(main.last7d, main.currency)}` : "—", main ? weekChange(main) : "no payments yet", !main),
                figure("Revenue · 30 days", main ? `${floor}${money(main.last30d, main.currency)}` : "—", loaded.payments7d !== undefined ? `${loaded.payments7d.toLocaleString()} payments this week` : undefined, !main),
                figure("Failed · 24 h", String(loaded.failed.last24h), `${loaded.failed.prev7d} in the 7 days before`),
                loaded.webhooks
                  ? figure("Webhooks", loaded.webhooks.disabledEndpoints ? "Disabled" : loaded.webhooks.failing24h ? `${loaded.webhooks.failing24h} pending` : "Delivered", loaded.webhooks.disabledEndpoints ? `${loaded.webhooks.disabledEndpoints} endpoint${loaded.webhooks.disabledEndpoints === 1 ? "" : "s"} switched off` : "undelivered after an hour, last 24 h")
                  : loaded.pastDue !== undefined
                    ? figure("Past due", String(loaded.pastDue), "subscriptions whose payment failed")
                    : undefined,
              ),
              (others.length > 0 || loaded.mode === "test" || loaded.partial || (loaded.webhooks && loaded.pastDue !== undefined)) &&
                h(
                  "p",
                  { class: "secondary" },
                  [
                    loaded.mode === "test" ? "Test mode: no real money." : undefined,
                    loaded.webhooks && loaded.pastDue !== undefined ? `${loaded.pastDue} subscription${loaded.pastDue === 1 ? "" : "s"} past due.` : undefined,
                    others.length ? `Also, last 30 days: ${others.map((r) => money(r.last30d, r.currency)).join(", ")}.` : undefined,
                    loaded.partial ? "More payments than were read: revenue is a floor." : undefined,
                  ]
                    .filter(Boolean)
                    .join(" "),
                ),
            ),
  });
}
