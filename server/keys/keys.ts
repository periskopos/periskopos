import type { Service } from "../../shared/types.ts";
import { ProviderError } from "../http.ts";
import { SERVICE_TYPES } from "../integrations/index.ts";
import { authFor } from "./secrets.ts";

// Testing an account's key (FR-S2): one read call with it. Test on the
// Accounts page and the watcher's daily check both come here, and both
// store what it found as the account's lastTest.

export type KeyResult = NonNullable<Service["lastTest"]>;

export async function testKey(service: Service, now = Date.now()): Promise<{ result: KeyResult; transient: boolean }> {
  const at = new Date(now).toISOString();
  try {
    const { message, expiresAt } = await SERVICE_TYPES[service.type].testService!(authFor(service));
    return { result: { ok: true, message, at, ...(expiresAt ? { expiresAt } : {}) }, transient: false };
  } catch (err) {
    // No answer, a rate limit (429), or the provider itself failing (5xx)
    // says nothing about the key: the watcher keeps its last verdict and
    // asks again later.
    const transient = err instanceof ProviderError && (err.status === 0 || err.status === 429 || err.status >= 500);
    return { result: { ok: false, message: (err as Error).message, at }, transient };
  }
}
