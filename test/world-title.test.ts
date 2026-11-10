import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ProviderStatus } from "../shared/types.ts";
import { overallLine, utilityLook } from "../shared/world.ts";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const service = (label: string, relevantIndicator: ProviderStatus["relevantIndicator"], apps = [{ slug: "a", name: "A" }], read = true) =>
  ({ id: label.toLowerCase(), label, pageUrl: "", indicator: relevantIndicator, relevantIndicator, description: "", incidents: [], apps, ...(read ? { checkedAt: new Date(NOW).toISOString() } : {}) }) as ProviderStatus;
const normal = { state: "up", text: "All normal" };

describe("the line at the top", () => {
  test("says all's normal only when the services are too", () => {
    assert.deepEqual(overallLine(normal, [], NOW), { state: "up", text: "All systems normal" });
    assert.deepEqual(overallLine(normal, [service("GitHub", "none")], NOW).text, "All systems normal");
  });

  test("names a service in trouble, in amber, as the apps are fine", () => {
    const providers = [service("Cloudflare", "major")];
    assert.equal(utilityLook(providers[0]!, NOW), "trouble", "the same test as its red label");
    assert.deepEqual(overallLine(normal, providers, NOW), { state: "attention", text: "Apps normal · Cloudflare having trouble" });
  });

  test("names two, then counts", () => {
    const line = (...names: string[]) => overallLine(normal, names.map((n) => service(n, "major")), NOW).text;
    assert.equal(line("A", "B"), "Apps normal · A and B having trouble");
    assert.equal(line("A", "B", "C"), "Apps normal · 3 services having trouble");
  });

  test("keeps what's wrong with the apps, and its colour", () => {
    assert.deepEqual(overallLine({ state: "down", text: "1 down" }, [service("Cloudflare", "major")], NOW), { state: "down", text: "1 down · Cloudflare having trouble" });
    assert.deepEqual(overallLine({ state: "down", text: "1 down" }, [], NOW), { state: "down", text: "1 down" });
  });

  test("a service nothing relies on, in maintenance or not read isn't called trouble", () => {
    assert.equal(overallLine(normal, [service("Unused", "major", [])], NOW).text, "All systems normal");
    assert.equal(overallLine(normal, [service("GitHub", "maintenance")], NOW).text, "All systems normal");
    assert.equal(overallLine(normal, [service("Unread", "major", undefined, false)], NOW).text, "All systems normal");
  });
});
