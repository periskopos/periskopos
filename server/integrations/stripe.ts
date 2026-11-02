import type { CheckResult, PaymentsDetails } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson } from "../http.ts";
import { requiredText } from "../validate.ts";
import { DAY_MS, paymentsHealth, paymentsNotice, revenueOf } from "./payments.ts";
import type { Paid } from "./payments.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// Stripe as a payment provider: one account per key (a restricted key that
// only reads). Revenue from its charges, failed payments from its search,
// and webhooks from the events it hasn't managed to deliver.

const API = "https://api.stripe.com/v1";
// Pages of 100 charges read for 30 days' revenue; past that it's a floor.
const CHARGE_PAGES = 10;

type List<T> = { data: T[]; has_more: boolean };
type Charge = { id: string; amount: number; amount_refunded?: number; currency: string; created: number; status: string; paid?: boolean; livemode?: boolean };

const qs = (params: Record<string, string | number>) => Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");

async function api<T>(auth: ServiceAuth, path: string, params: Record<string, string | number> = {}, ttlMs?: number): Promise<T> {
  const q = qs(params);
  return getJson<T>(`${API}${path}${q ? `?${q}` : ""}`, { token: await auth.token(), provider: "Stripe", ...(ttlMs !== undefined ? { ttlMs } : {}) });
}

// A key says its own mode: sk_test_/rk_test_ are test keys.
const modeOf = async (auth: ServiceAuth): Promise<"live" | "test"> => (/^(sk|rk)_test_/.test(await auth.token()) ? "test" : "live");
const sec = (ms: number) => Math.floor(ms / 1000);

// How many charges a search finds, up to 100 (then it says 100).
async function countFailed(auth: ServiceAuth, fromMs: number, toMs: number): Promise<number> {
  const r = await api<List<Charge>>(auth, "/charges/search", { query: `status:'failed' AND created>${sec(fromMs)} AND created<=${sec(toMs)}`, limit: 100 });
  return r.data.length;
}

// Events still undelivered to a webhook after an hour: Stripe keeps
// retrying, but the app hasn't heard. The last hour is left out, so a
// delivery still on its first tries isn't counted.
async function webhooks(auth: ServiceAuth, now: number): Promise<NonNullable<PaymentsDetails["webhooks"]>> {
  const [events, endpoints] = await Promise.all([
    api<List<{ id: string }>>(auth, "/events", { delivery_success: "false", "created[gte]": sec(now - DAY_MS), "created[lte]": sec(now - 3_600_000), limit: 100 }),
    api<List<{ id: string; status: string }>>(auth, "/webhook_endpoints", { limit: 100 }),
  ]);
  const disabled = endpoints.data.filter((e) => e.status === "disabled").length;
  return { failing24h: events.data.length, ...(disabled ? { disabledEndpoints: disabled } : {}) };
}

async function signals(auth: ServiceAuth, now = Date.now()) {
  const [last24h, prev7d, hooks, mode] = await Promise.all([countFailed(auth, now - DAY_MS, now), countFailed(auth, now - 8 * DAY_MS, now - DAY_MS), webhooks(auth, now), modeOf(auth)]);
  return { provider: "Stripe", mode, failed: { last24h, prev7d }, webhooks: hooks };
}

// Successful charges in the last 30 days, less what was refunded.
async function paid(auth: ServiceAuth, now: number): Promise<{ paid: Paid[]; partial: boolean }> {
  const out: Paid[] = [];
  let after: string | undefined;
  for (let page = 0; page < CHARGE_PAGES; page++) {
    const r = await api<List<Charge>>(auth, "/charges", { limit: 100, "created[gte]": sec(now - 30 * DAY_MS), ...(after ? { starting_after: after } : {}) });
    for (const c of r.data) if (c.status === "succeeded" && c.paid !== false) out.push({ at: c.created * 1000, amount: c.amount - (c.amount_refunded ?? 0), currency: c.currency });
    if (!r.has_more || !r.data.length) return { paid: out, partial: false };
    after = r.data.at(-1)!.id;
  }
  return { paid: out, partial: true };
}

export const stripe: Integration = {
  ...described("stripe"),

  parse({ resource, settings }) {
    const id = requiredText(resource, "Stripe account", 100);
    if (!/^(acct_[A-Za-z0-9]+|account)$/.test(id)) throw badRequest("Pick the account from the list");
    const s = (settings ?? {}) as Record<string, unknown>;
    return { resource: id, settings: typeof s.name === "string" ? { name: s.name.slice(0, 100) } : {} };
  },

  async testService(auth) {
    const balance = await api<{ livemode?: boolean }>(auth, "/balance", {}, 0);
    return { message: `Connected to Stripe (${balance.livemode === false ? "test mode" : "live"})` };
  },

  // A key is one account. Its name, when the key may read it.
  async listResources(auth) {
    const mode = await modeOf(auth);
    const account = await api<{ id?: string; settings?: { dashboard?: { display_name?: string } }; business_profile?: { name?: string } }>(auth, "/account").catch(() => undefined);
    const name = account?.settings?.dashboard?.display_name ?? account?.business_profile?.name ?? "Stripe account";
    return [{ id: account?.id ?? "account", label: name, detail: mode === "test" ? "test mode" : "live", settings: { name } }];
  },

  async check(_conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No Stripe account connected" };
    try {
      return paymentsHealth(await signals(auth), at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(_conn, auth): Promise<PaymentsDetails> {
    const now = Date.now();
    const [s, charges] = await Promise.all([signals(auth, now), paid(auth, now)]);
    return {
      shape: "payments",
      ...s,
      revenue: revenueOf(charges.paid, now),
      payments7d: charges.paid.filter((p) => now - p.at < 7 * DAY_MS).length,
      ...(charges.partial ? { partial: true } : {}),
      link: { url: `https://dashboard.stripe.com/${s.mode === "test" ? "test/" : ""}payments`, label: "All in Stripe" },
    };
  },

  notice: paymentsNotice,
};
