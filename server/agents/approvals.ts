import { randomBytes } from "node:crypto";
import type { Approval } from "../../shared/types.ts";

// Agent actions wait here for me (docs/AGENT-SAFETY.md §4.2). The server
// itself asks, on screen, so the approval holds whichever agent calls and
// however its client is set up. Pending requests live only in memory: a
// restart drops them, and the agent is told nothing ran.

export type Decision = "approved" | "declined" | "expired";

export const APPROVAL_TIMEOUT_MS = 2 * 60_000;

type Pending = { approval: Approval; settle: (d: Decision) => void };

export class Approvals {
  #pending = new Map<string, Pending>();
  #listeners: ((a: Approval) => void)[] = [];
  #timeoutMs: number;

  constructor({ timeoutMs = APPROVAL_TIMEOUT_MS }: { timeoutMs?: number } = {}) {
    this.#timeoutMs = timeoutMs;
  }

  // Called for each new request (to notify me, or by tests to answer it).
  onRequest(listener: (a: Approval) => void) {
    this.#listeners.push(listener);
  }

  request(info: Omit<Approval, "id" | "requestedAt" | "expiresAt">, signal?: AbortSignal): Promise<Decision> {
    // The agent hung up before we got here (preparing an action can take a
    // while): an abort listener added now would never fire, so the question
    // would stay up and approving it would run something nobody waits for.
    if (signal?.aborted) return Promise.resolve("expired");
    const now = Date.now();
    const approval: Approval = {
      ...info,
      id: `ap_${randomBytes(8).toString("base64url")}`,
      requestedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.#timeoutMs).toISOString(),
    };
    return new Promise<Decision>((resolve) => {
      const timer = setTimeout(() => settle("expired"), this.#timeoutMs);
      const settle = (d: Decision) => {
        if (!this.#pending.delete(approval.id)) return;
        clearTimeout(timer);
        resolve(d);
      };
      // The agent hung up: there's no one left to tell, so stop asking.
      signal?.addEventListener("abort", () => settle("expired"), { once: true });
      this.#pending.set(approval.id, { approval, settle });
      for (const listener of this.#listeners) listener(approval);
    });
  }

  // Everything waiting is withdrawn: the agents are told nothing ran.
  cancelAll() {
    this.cancelWhere(() => true);
  }

  // What one assistant (say) is waiting on is withdrawn.
  cancelWhere(match: (a: Approval) => boolean) {
    for (const pending of [...this.#pending.values()]) if (match(pending.approval)) pending.settle("expired");
  }

  get(id: string): Approval | undefined {
    return this.#pending.get(id)?.approval;
  }

  list(): Approval[] {
    return [...this.#pending.values()].map((p) => p.approval);
  }

  // False when there's nothing (any more) to decide.
  decide(id: string, approved: boolean): boolean {
    const pending = this.#pending.get(id);
    if (!pending) return false;
    pending.settle(approved ? "approved" : "declined");
    return true;
  }
}
