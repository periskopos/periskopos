import type { AppState, CheckResult, Connection } from "../shared/types.ts";
import { integrations } from "./integrations/index.ts";
import type { ServiceAuth } from "./integrations/types.ts";

// Runs one integration's check, caching the result for a short time (FR-I2)
// and sharing a check that's already in flight. The watcher calls it; it
// records nothing itself.
export class StatusService {
  #ttlMs: number;
  #cache = new Map<string, { result: CheckResult; storedAt: number }>();
  #inFlight = new Map<string, Promise<CheckResult>>();

  constructor(ttlMs = 60_000) {
    this.#ttlMs = ttlMs;
  }

  async check(conn: Connection, refresh = false, auth?: ServiceAuth): Promise<CheckResult | undefined> {
    const integration = integrations[conn.type];
    if (!integration?.check) return undefined;

    // Keyed on the resource too, so editing a URL never shows the old result.
    const key = `${conn.id} ${conn.resource}`;
    const hit = this.#cache.get(key);
    if (!refresh && hit && Date.now() - hit.storedAt < this.#ttlMs) return hit.result;

    let pending = this.#inFlight.get(key);
    if (!pending) {
      // An integration failing is a fact about the check, not a server error
      // (FR-I1): the rest of the page still renders.
      pending = integration
        .check(conn, auth)
        .catch((err): CheckResult => ({
          state: "unknown",
          at: new Date().toISOString(),
          detail: `Check failed: ${(err as Error)?.message ?? err}`,
        }))
        .finally(() => this.#inFlight.delete(key));
      this.#inFlight.set(key, pending);
    }
    const result = await pending;
    this.#cache.set(key, { result, storedAt: Date.now() });
    return result;
  }
}

// The checks that say something about an app: all of them, except that a
// not-live app has no site to check, so what was recorded for it earlier
// doesn't count.
export function relevantChecks<T extends { conn: Connection }>(checks: T[], live: boolean): T[] {
  return live ? checks : checks.filter((c) => !integrations[c.conn.type]?.needsLiveApp);
}

// The app's state from its latest checks: down only if the app itself is
// (an outage check), "attention" if something around it failed. A not-live
// app is "prelaunch" unless something else about it needs attention.
export function overallState(all: { conn: Connection; result: CheckResult }[], live = true): AppState {
  const checks = relevantChecks(all, live);
  if (!live) {
    return checks.some((c) => c.result.state === "down") ? "attention" : "prelaunch";
  }
  if (checks.length === 0) return "none";
  const outage = (c: { conn: Connection }) => (integrations[c.conn.type]?.incidentKind ?? "outage") === "outage";
  if (checks.some((c) => outage(c) && c.result.state === "down")) return "down";
  if (checks.some((c) => !outage(c) && c.result.state === "down")) return "attention";
  // A check that can't tell (offline, a domain ending with no expiry lookup)
  // makes the app "unknown" only when it's the one saying whether the app is
  // up, or when no check can tell: an unknown expiry date mustn't hide a site
  // that answers.
  const unknown = checks.filter((c) => c.result.state === "unknown");
  if (unknown.some(outage) || unknown.length === checks.length) return "unknown";
  return "up";
}
