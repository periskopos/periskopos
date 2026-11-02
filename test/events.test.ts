import assert from "node:assert/strict";
import { describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text, unnamed } from "./dom-helpers.ts";
import type { ProviderMaintenance } from "../shared/types.ts";
import { parseSummary } from "../server/providers.ts";
import { incidentCard, incidentRow, maintenanceRows } from "../web/src/views/events.ts";

// A provider's incidents and maintenance on the Status page (views/events.ts):
// a card for what affects my apps, quiet rows for the rest, maintenance by day.

const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString();
const draw = (node: Node) => {
  const root = document.createElement("div");
  root.append(node);
  return root;
};
const used = new Set(["Workers Builds", "Workers"]);

describe("an incident affecting my apps", () => {
  const incident = {
    name: "Workers Builds failing",
    impact: "major",
    status: "identified",
    url: "https://www.cloudflarestatus.com/incidents/x",
    startedAt: at(22),
    parts: ["Cloudflare Sites and Services", "Workers Builds"],
    update: { body: "We are working to mitigate the problem.", at: at(5) },
    affectsYou: true,
  };

  test("a card edged by its impact: its state, how long, the provider's latest word, my parts first, its page", () => {
    const card = draw(incidentCard(incident, used));
    assert.ok(card.querySelector(".incident-card--down"), "major is red");
    assert.equal(text(card.querySelector(".incident-head .tag")), "Identified");
    assert.match(text(card), /since .* · for 22 min/);
    assert.match(text(card.querySelector(".incident-update")), /We are working to mitigate the problem\. · updated 5 min ago/);
    assert.deepEqual([...card.querySelectorAll(".incident-parts .chip")].map((c) => [text(c), c.classList.contains("is-yours")]), [
      ["Workers Builds", true],
      ["Cloudflare Sites and Services", false],
    ]);
    assert.equal(card.querySelector("a")?.getAttribute("href"), incident.url);
    assert.deepEqual(unnamed(card), []);
  });

  test("a minor one is amber; without an update or parts it still reads", () => {
    const card = draw(incidentCard({ name: "Slow", impact: "minor" }, used));
    assert.ok(card.querySelector(".incident-card--attention"));
    assert.equal(card.querySelector(".incident-update") === null, true); // a node itself never goes to assert: printing one on failure hangs the run
  });

  test("one elsewhere is a quiet row that says so", () => {
    const row = draw(incidentRow({ name: "Ashburn network", impact: "minor", status: "monitoring", startedAt: at(90) }));
    assert.match(text(row), /Ashburn network\s*Monitoring · for 1 h 30 min\s*doesn't affect your apps/);
  });
});

describe("maintenance", () => {
  const day = (h: number, d = 0) => {
    const x = new Date();
    x.setDate(x.getDate() + 1 + d);
    x.setHours(h, 0, 0, 0);
    return x.toISOString();
  };
  const window = (name: string, h: number, extra: Partial<ProviderMaintenance> = {}): ProviderMaintenance => ({ name, status: "scheduled", scheduledFor: day(h), scheduledUntil: day(h + 2), parts: ["Europe"], ...extra });

  test("a day's routine windows are one row that opens to the list; what touches my parts is listed on its own, first", () => {
    const list = [window("PTY", 10), window("AUS", 11), window("DOH", 14), window("Storage", 12, { parts: ["Workers Builds"] }), window("Next day", 9, { scheduledFor: day(9, 1), scheduledUntil: day(10, 1) })];
    const root = draw(maintenanceRows(list, used));
    const rows = [...root.querySelectorAll(":scope > ul > li")];
    assert.equal(rows.length, 3, "storage, the grouped three, the next day's one");
    assert.match(text(rows[0]), /Storage.*touches Workers Builds, which your apps use.*your parts/);
    assert.ok(rows[0]!.classList.contains("is-yours"));
    assert.match(text(rows[1]!.querySelector("summary")), /^3 routine windows in parts your apps don't use$/);
    assert.equal(rows[1]!.querySelectorAll("details li").length, 3);
    assert.match(text(rows[2]), /Next day/);
    assert.deepEqual(unnamed(root), []);
  });

  test("two windows on a day stay as rows; one under way comes first", () => {
    const root = draw(maintenanceRows([window("A", 10), window("B", 11), { name: "Now", status: "in_progress", parts: ["Europe"] }], used));
    const rows = [...root.querySelectorAll(":scope > ul > li")].map(text);
    assert.equal(rows.length, 3);
    assert.match(rows[0]!, /^Under way\s*Now/);
    assert.equal(root.querySelector("details") === null, true);
  });
});

describe("what the status page says, as kept", () => {
  test("an incident keeps its latest update, cut when long; maintenance keeps when it ends, and more of it", () => {
    const long = "x".repeat(400);
    const when = at(3);
    const f = parseSummary({
      incidents: [{ name: "A", impact: "minor", incident_updates: [{ body: `  We are   investigating.  `, created_at: when }, { body: "older" }] }, { name: "B", impact: "minor", incident_updates: [{ body: long }] }],
      scheduled_maintenances: Array.from({ length: 30 }, (_, i) => ({ name: `W${i}`, status: "scheduled", scheduled_for: day0(i), scheduled_until: day0(i + 1) })),
    });
    assert.deepEqual(f.incidents[0]!.update, { body: "We are investigating.", at: when });
    assert.equal(f.incidents[1]!.update!.body.length, 280);
    assert.ok(f.incidents[1]!.update!.body.endsWith("…"));
    assert.equal(f.maintenance?.length, 25);
    assert.equal(f.maintenance?.[0]?.scheduledUntil, day0(1));
  });
});

function day0(h: number) {
  return new Date(Date.UTC(2026, 10, 1, h)).toISOString();
}
