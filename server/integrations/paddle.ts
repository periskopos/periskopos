import type { CheckResult, PaymentsDetails } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { DAY_MS, paymentsHealth, paymentsNotice, revenueOf } from "./payments.ts";
import type { Paid } from "./payments.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Paddle Billing as a payment provider: one account per key. Revenue from
// its completed transactions, failed payments from past-due transactions,
// past-due subscriptions, and webhooks from the notifications it couldn't
// deliver. A sandbox key reads the sandbox.

// Pages of 30 transactions (Paddle's most per page) read for 30 days'
// revenue; past that it's a floor.
const TX_PAGES = 20;

type Page<T> = { data: T[]; meta?: { pagination?: { next?: string; has_more?: boolean; estimated_total?: number } } };
type Tx = { id: string; status: string; created_at: string; billed_at?: string | null; details?: { totals?: { total?: string; grand_total?: string; currency_code?: string } }; currency_code?: string };

const isSandbox = (token: string) => /^pdl_sdbx_/.test(token);
const baseOf = (token: string) => (isSandbox(token) ? "https://sandbox-api.paddle.com" : "https://api.paddle.com");

async function api<T>(auth: ServiceAuth, pathOrUrl: string, ttlMs?: number): Promise<T> {
  const token = await auth.token();
  const base = baseOf(token);
  // Paddle's "next page" is a whole URL; only ever follow one on its own API.
  const url = pathOrUrl.startsWith("https://") ? pathOrUrl : `${base}${pathOrUrl}`;
  if (!url.startsWith(`${base}/`)) throw new Error("Paddle pointed outside its API");
  return getJson<T>(url, { token, provider: "Paddle", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// How many a list holds, without reading it: one item, and Paddle's total.
async function count(auth: ServiceAuth, path: string): Promise<number> {
  const r = await api<Page<unknown>>(auth, `${path}${path.includes("?") ? "&" : "?"}per_page=1`);
  const total = r.meta?.pagination?.estimated_total;
  return typeof total === "number" && total >= 0 ? total : r.data.length;
}

async function signals(auth: ServiceAuth, now = Date.now()) {
  const [last24h, prev7d, failing24h, pastDue] = await Promise.all([
    count(auth, `/transactions?status=past_due&updated_at[GTE]=${iso(now - DAY_MS)}`),
    count(auth, `/transactions?status=past_due&updated_at[GTE]=${iso(now - 8 * DAY_MS)}&updated_at[LT]=${iso(now - DAY_MS)}`),
    count(auth, `/notifications?status=failed,needs_retry&from=${iso(now - DAY_MS)}&to=${iso(now - 3_600_000)}`),
    count(auth, "/subscriptions?status=past_due"),
  ]);
  return { provider: "Paddle", mode: isSandbox(await auth.token()) ? ("test" as const) : ("live" as const), failed: { last24h, prev7d }, webhooks: { failing24h }, pastDue };
}

// Completed (and paid) transactions in the last 30 days, at their total.
async function paid(auth: ServiceAuth, now: number): Promise<{ paid: Paid[]; partial: boolean }> {
  const out: Paid[] = [];
  let next: string | undefined = `/transactions?status=completed,paid&created_at[GTE]=${iso(now - 30 * DAY_MS)}&per_page=30`;
  for (let page = 0; page < TX_PAGES && next; page++) {
    const r: Page<Tx> = await api<Page<Tx>>(auth, next);
    for (const t of r.data) {
      const total = Number(t.details?.totals?.total ?? t.details?.totals?.grand_total);
      const currency = t.details?.totals?.currency_code ?? t.currency_code;
      if (Number.isFinite(total) && currency) out.push({ at: Date.parse(t.billed_at ?? t.created_at), amount: total, currency });
    }
    next = r.meta?.pagination?.has_more ? r.meta.pagination.next : undefined;
  }
  return { paid: out, partial: Boolean(next) };
}

export const paddle: Integration = {
  ...described("paddle"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Paddle account", 20);
    if (id !== "account") throw badRequest("Pick the account from the list");
    const s = (settings ?? {}) as Record<string, unknown>;
    return { resource: id, settings: typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {} };
  },

  async testService(auth) {
    await api<Page<unknown>>(auth, "/transactions?per_page=1", 0);
    return { message: `Connected to Paddle (${isSandbox(await auth.token()) ? "sandbox" : "live"})` };
  },

  // A key is one account.
  async listResources(auth) {
    const sandbox = isSandbox(await auth.token());
    return [{ id: "account", label: sandbox ? "Paddle sandbox" : "Paddle account", detail: sandbox ? "test mode" : "live", settings: { name: sandbox ? "Paddle sandbox" : "Paddle" } }];
  },

  async check(_conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Paddle account connected" };
    try {
      return paymentsHealth(await signals(auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(_conn, auth): Promise<PaymentsDetails> {
    const now = Date.now();
    const [s, tx] = await Promise.all([signals(auth, now), paid(auth, now)]);
    return {
      shape: "payments",
      ...s,
      revenue: revenueOf(tx.paid, now),
      payments7d: tx.paid.filter((p) => now - p.at < 7 * DAY_MS).length,
      ...(tx.partial ? { partial: true } : {}),
      link: { url: s.mode === "test" ? "https://sandbox-vendors.paddle.com/transactions-v2" : "https://vendors.paddle.com/transactions-v2", label: "All in Paddle" },
    };
  },

  notice: paymentsNotice,
};
