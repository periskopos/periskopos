import { duration } from "../../shared/format.ts";
import type { CheckResult, PaymentsDetails, PaymentsRevenue } from "../../shared/types.ts";
import type { Notice } from "./types.ts";

// What every payment provider shares (Stripe, Paddle…): each turns its own
// API's answers into PaymentsDetails, and this decides what they mean. A
// new provider is one file that fills the shape.

export const DAY_MS = 86_400_000;

// When failed payments count as a problem: at least this many in a day,
// and well over the usual (the week before's daily average).
export const FAILED_MIN = 5;
export const FAILED_TIMES_USUAL = 3;
// Webhooks: events left undelivered for over an hour (the provider is
// still retrying) mean the app isn't hearing about payments.
export const WEBHOOKS_FAILING_MIN = 3;

// One payment, as every provider has it, for adding up revenue.
export type Paid = { at: number; amount: number; currency: string };

// Revenue per currency over the last 7 days, the 7 before, and 30 days,
// biggest first.
export function revenueOf(paid: Paid[], now = Date.now()): PaymentsRevenue[] {
  const by = new Map<string, PaymentsRevenue>();
  for (const p of paid) {
    const age = now - p.at;
    if (age < 0 || age >= 30 * DAY_MS) continue;
    const currency = p.currency.toUpperCase();
    const r = by.get(currency) ?? { currency, last7d: 0, prev7d: 0, last30d: 0 };
    r.last30d += p.amount;
    if (age < 7 * DAY_MS) r.last7d += p.amount;
    else if (age < 14 * DAY_MS) r.prev7d += p.amount;
    by.set(currency, r);
  }
  return [...by.values()].sort((a, b) => b.last30d - a.last30d);
}

// Down (needs attention: the site still serves) when payments start
// failing far more than usual, a webhook endpoint was switched off, or
// events stop reaching the app.
export function paymentsHealth(d: Pick<PaymentsDetails, "provider" | "mode" | "failed" | "webhooks" | "pastDue">, at: string): CheckResult {
  const problems: string[] = [];
  const usualPerDay = d.failed.prev7d / 7;
  if (d.failed.last24h >= FAILED_MIN && d.failed.last24h > FAILED_TIMES_USUAL * usualPerDay) {
    problems.push(`${d.failed.last24h} failed payments in the last 24 h (usually ${usualPerDay < 1 ? "under 1" : Math.round(usualPerDay)} a day)`);
  }
  if (d.webhooks?.disabledEndpoints) problems.push(`${d.webhooks.disabledEndpoints === 1 ? "A webhook endpoint is" : `${d.webhooks.disabledEndpoints} webhook endpoints are`} disabled`);
  if (d.webhooks && d.webhooks.failing24h >= WEBHOOKS_FAILING_MIN) problems.push(`${d.webhooks.failing24h} events in the last 24 h haven't reached the app's webhook`);

  const summary = [
    d.mode === "test" ? "Test mode" : undefined,
    `${d.failed.last24h} failed in 24 h`,
    d.webhooks ? (d.webhooks.failing24h ? `${d.webhooks.failing24h} webhook deliveries pending` : "webhooks delivered") : undefined,
    d.pastDue ? `${d.pastDue} subscriptions past due` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return problems.length ? { state: "down", at, detail: problems.join(" · "), summary } : { state: "up", at, summary };
}

export function paymentsNotice(event: "down" | "up", app: string, reason: string, downForMs: number): Notice {
  if (event === "up") return { title: `${app}: payments are back to normal`, body: `After ${duration(downForMs)}.` };
  if (/webhook/i.test(reason) && !/failed payments/.test(reason)) return { title: `${app}: payment webhooks aren't arriving`, body: reason };
  return { title: `${app}: payments are failing`, body: reason };
}
