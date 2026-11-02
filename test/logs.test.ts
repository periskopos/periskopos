import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Connection, LogLine } from "../shared/types.ts";
import { SPIKE_MIN, errorSpike, fingerprint, groupLines, logsIntegration } from "../server/integrations/logs.ts";
import type { Integration, ServiceAuth } from "../server/integrations/types.ts";
import { appDetail } from "../mcp/shape.ts";

// Runtime errors from a host's logs (server/integrations/logs.ts): alike
// lines counted once, and an alert only when errors rise sharply. The host's
// reader is a stand-in here.

const NOW = Date.now();
const minAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const line = (m: number, message: string, level: LogLine["level"] = "error"): LogLine => ({ at: minAgo(m), level, message });

describe("logs: alike lines counted once", () => {
  test("numbers, ids and hashes don't make a different error", () => {
    assert.equal(fingerprint("User 123 not found (req 9f8e7d6c5b4a3f2e)"), fingerprint("User 98 not found (req 0011223344aabbcc)"));
    assert.equal(fingerprint("Timeout after 30s for 4c1f5f9a-1b2c-4d3e-8f90-123456789abc"), "Timeout after <n>s for <id>");
    assert.notEqual(fingerprint("Cannot read properties of undefined"), fingerprint("Database connection refused"));
  });

  test("grouped, most frequent first, each with its newest line and its span", () => {
    // "DB down" is the newest line, so only the count can put "not found" first.
    const groups = groupLines([line(50, "User 1 not found"), line(1, "DB down", "fatal"), line(10, "User 2 not found"), line(5, "User 3 not found")]);
    assert.deepEqual(groups.map((g) => [g.message, g.count, g.level]), [["User 3 not found", 3, "error"], ["DB down", 1, "fatal"]]);
    assert.equal(groups[0]!.firstAt, minAgo(50));
    assert.equal(groups[0]!.lastAt, minAgo(5));
    // A fatal line among errors makes the whole group fatal.
    assert.equal(groupLines([line(3, "Crash 1", "error"), line(2, "Crash 2", "fatal"), line(1, "Crash 3", "error")])[0]!.level, "fatal");
  });
});

describe("logs: a spike", () => {
  const recent = (n: number) => Array.from({ length: n }, (_, i) => line(i % 14, "boom"));
  const earlier = (n: number) => Array.from({ length: n }, (_, i) => line(16 + (i % 44), "boom"));

  test("many errors in the last 15 minutes, several times the usual: a spike", () => {
    assert.deepEqual(errorSpike([...recent(30), ...earlier(15)], NOW), { recent: 30, usual: 5, windowMin: 15 });
  });

  test("a steady trickle, or a handful, isn't", () => {
    assert.equal(errorSpike([...recent(30), ...earlier(90)], NOW), undefined, "30 against a usual 30");
    assert.equal(errorSpike(recent(SPIKE_MIN - 1), NOW), undefined, "too few to matter");
  });
});

describe("logs: a host's connection", () => {
  let lines: LogLine[] = [];
  const host = { parse: ({ resource }: { resource: unknown }) => ({ resource: String(resource) }), listResources: async () => [{ id: "p1", label: "star-map" }] } as unknown as Integration;
  const reader = {
    provider: "Testhost",
    readErrors: async (_c: Connection, _a: ServiceAuth, since: string) => ({ lines: lines.filter((l) => l.at >= since) }),
    dashboardUrl: () => "https://testhost.example/logs",
  };
  const conn: Connection = { id: "c", appId: "a", type: "render-logs", serviceId: "s", resource: "p1" };
  const auth = { service: { id: "s", ownerId: "u", type: "render", name: "R", canWrite: false }, token: async () => "t" } as ServiceAuth;

  test("quiet: up, with the count; a spike: down, saying how many and the most frequent", async () => {
    const integration = logsIntegration("render-logs", host, reader);
    lines = [line(30, "slow query")];
    const ok = await integration.check!({ ...conn, id: "c1" }, auth);
    assert.equal(ok.state, "up");
    assert.match(ok.summary!, /^1 error in the last 60 minutes/);

    lines = Array.from({ length: 25 }, (_, i) => line(i % 10, `TypeError: x is undefined at line ${i}`));
    const bad = await integration.check!({ ...conn, id: "c2" }, auth);
    assert.equal(bad.state, "down");
    assert.match(bad.detail!, /^25 errors in the last 15 minutes, against about 0 usually\. Most often: "TypeError: x is undefined at line \d+"/);
    assert.deepEqual(bad.link, { url: "https://testhost.example/logs", label: "Logs in Testhost" });

    const d = await integration.details!({ ...conn, id: "c2" }, auth);
    assert.equal(d.shape, "logs");
    const mcp = appDetail({ app: { id: "a", slug: "x", ownerId: "u", name: "X", url: "https://x.com", live: true, checkIntervalMin: 5, connections: [] }, status: undefined, history: undefined, details: [d], providers: [], activity: [], services: [] });
    assert.equal(mcp.logs?.lastHour, 25);
    assert.match(mcp.logs?.problem ?? "", /spiking: 25/);
  });

  test("a reader that fails: unknown, in its own words", async () => {
    const integration = logsIntegration("render-logs", host, { ...reader, readErrors: async () => Promise.reject(new Error("This key can't read logs")) });
    const r = await integration.check!({ ...conn, id: "c3" }, auth);
    assert.deepEqual([r.state, r.detail], ["unknown", "This key can't read logs"]);
  });
});
