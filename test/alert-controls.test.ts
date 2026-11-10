import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alertKindOf, heldDue, heldSummary, pauseProblem, pausedUntil, wanted } from "../server/alerts/rules.ts";
import { DEFAULT_SETTINGS } from "../server/settings.ts";
import type { IncidentKind, Settings } from "../shared/types.ts";

const NOW = Date.parse("2026-11-06T12:00:00Z");
const at = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();
const settings = (patch: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...patch });

describe("which kind an alert is", () => {
  test("every kind of incident belongs to a switch, and an unknown one counts as an outage", () => {
    const kinds: Record<IncidentKind, string> = { outage: "outages", slow: "outages", deploy: "deploys", ci: "deploys", expiry: "accounts", dependency: "warnings", search: "warnings", errors: "warnings", security: "warnings", payments: "warnings", traffic: "warnings", spend: "warnings" };
    for (const [incident, kind] of Object.entries(kinds)) assert.equal(alertKindOf(incident as IncidentKind), kind, incident);
    assert.equal(alertKindOf(undefined), "outages");
  });

  test("everything is wanted until switched off, one kind at a time", () => {
    for (const kind of ["outages", "deploys", "accounts", "providers", "warnings"] as const) assert.equal(wanted(settings(), kind), true, kind);
    const off = settings({ alertDeploys: false });
    assert.equal(wanted(off, "deploys"), false);
    assert.equal(wanted(off, "outages"), true);
  });
});

describe("what's paused", () => {
  test("nothing by default, and a pause that's over is no pause", () => {
    assert.equal(pausedUntil(settings(), "a", NOW), undefined);
    assert.equal(pausedUntil(settings({ alertsPausedUntil: at(-1) }), "a", NOW), undefined);
    assert.equal(pausedUntil(settings({ appPauses: { a: at(-1) } }), "a", NOW), undefined);
  });

  test("all alerts covers every app and the alerts about no app", () => {
    const s = settings({ alertsPausedUntil: at(60) });
    assert.equal(pausedUntil(s, "a", NOW), at(60));
    assert.equal(pausedUntil(s, undefined, NOW), at(60));
  });

  test("one app's pause covers only that app", () => {
    const s = settings({ appPauses: { a: at(60) } });
    assert.equal(pausedUntil(s, "a", NOW), at(60));
    assert.equal(pausedUntil(s, "b", NOW), undefined);
    assert.equal(pausedUntil(s, undefined, NOW), undefined);
  });

  test("with both, it lasts until the later one", () => {
    assert.equal(pausedUntil(settings({ alertsPausedUntil: at(30), appPauses: { a: at(60) } }), "a", NOW), at(60));
    assert.equal(pausedUntil(settings({ alertsPausedUntil: at(90), appPauses: { a: at(60) } }), "a", NOW), at(90));
  });

  test("a pause has to end, and soon", () => {
    assert.equal(pauseProblem("", NOW), undefined, "no pause is fine");
    assert.equal(pauseProblem(at(60), NOW), undefined);
    assert.ok(pauseProblem(at(-1), NOW));
    assert.ok(pauseProblem(at(49 * 60), NOW));
    assert.ok(pauseProblem("soon", NOW));
    assert.ok(pauseProblem(3, NOW));
  });
});

describe("what was missed", () => {
  test("only what's no longer paused comes out", () => {
    const held = [{ title: "A is down", appId: "a" }, { title: "B is down", appId: "b" }, { title: "Key failed" }];
    const { due, kept } = heldDue(settings({ appPauses: { a: at(60) } }), held, NOW);
    assert.deepEqual(due.map((x) => x.title), ["B is down", "Key failed"]);
    assert.deepEqual(kept.map((x) => x.title), ["A is down"]);
  });

  test("one alert says itself, several say how many and the latest", () => {
    assert.deepEqual(heldSummary([{ title: "A is down" }]), { title: "A is down", body: "This happened while alerts were paused." });
    const many = heldSummary(["one", "two", "three", "four", "five"].map((title) => ({ title })));
    assert.equal(many.title, "5 alerts while paused");
    assert.equal(many.body, "three. four. five. And 2 more.");
    assert.equal(heldSummary([{ title: "a" }, { title: "b" }]).body, "a. b.");
  });
});
