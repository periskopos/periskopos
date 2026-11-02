import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eachLimited } from "../server/watcher.ts";

describe("checks a few at a time per provider", () => {
  it("never runs more than the limit for one key, and runs the keys side by side", async () => {
    const running = new Map<string, number>();
    const most = new Map<string, number>();
    const done: string[] = [];
    let together = false; // both keys running at one moment
    const items = [...Array.from({ length: 9 }, (_, i) => ["vercel", i] as const), ...Array.from({ length: 3 }, (_, i) => ["render", i] as const)];
    await eachLimited(items, ([key]) => key, 4, async ([key, i]) => {
      running.set(key, (running.get(key) ?? 0) + 1);
      most.set(key, Math.max(most.get(key) ?? 0, running.get(key)!));
      if ((running.get("vercel") ?? 0) > 0 && (running.get("render") ?? 0) > 0) together = true;
      await new Promise((r) => setTimeout(r, 5));
      running.set(key, running.get(key)! - 1);
      done.push(`${key}${i}`);
    });
    assert.equal(done.length, 12);
    assert.equal(most.get("vercel"), 4);
    assert.equal(most.get("render"), 3);
    assert.equal(together, true, "one provider's queue doesn't wait for another's");
  });

  it("does nothing with nothing due", async () => {
    await eachLimited([], () => "x", 4, async () => assert.fail("called"));
  });
});
