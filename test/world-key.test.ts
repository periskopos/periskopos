import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { WorldState, UtilityLook } from "../shared/world.ts";
import { KEY_GROUPS, keyGroups, nextPlace, plotSays, STATUSES, statusesOnMap, statusTitle, utilitySays, watcherSays } from "../web/src/views/world/looks.ts";

type P = { name: string; state: WorldState; work?: "deploying" | "waiting" | null };
const worldOf = (plots: P[], utilities: [string, UtilityLook][] = [], watcher = { stopped: false, watching: true }) => ({
  plots: plots.map((p) => ({ slug: p.name, work: null, ...p })),
  utilities: utilities.map(([label, look]) => ({ label, look })),
  ...watcher,
}) as unknown as Parameters<typeof statusesOnMap>[0];

describe("the key to the map", () => {
  const ids = (world: Parameters<typeof statusesOnMap>[0]) => statusesOnMap(world).map((s) => s.id);

  test("a service in trouble is in the key, however well the apps are", () => {
    assert.deepEqual(ids(worldOf([{ name: "a", state: "up" }], [["Cloudflare", "trouble"], ["GitHub", "ok"]])), ["trouble", "up"]);
  });

  test("so is a deploy, a push that isn't live, and a watcher that's stopped", () => {
    const world = worldOf([{ name: "a", state: "up", work: "deploying" }, { name: "b", state: "up", work: "waiting" }], [], { stopped: true, watching: false });
    assert.deepEqual(ids(world), ["push", "stopped", "deploying"]);
  });

  test("worst first, whatever order things come in", () => {
    assert.deepEqual(ids(worldOf([{ name: "a", state: "prelaunch" }, { name: "b", state: "up" }, { name: "c", state: "down" }])), ["down", "prelaunch", "up"]);
  });

  test("a replay's services claim nothing", () => {
    assert.deepEqual(ids(worldOf([{ name: "a", state: "up" }], [["GitHub", "past"]])), ["up"]);
  });

  test("the watcher not known to be watching isn't called up", () => {
    assert.deepEqual(ids(worldOf([], [], { stopped: false, watching: false })), ["unknown"]);
  });

  test("everything a label can say is in the key", () => {
    const words = new Set(STATUSES.map((s) => s.word));
    const states: WorldState[] = ["up", "down", "attention", "unknown", "stale", "none", "prelaunch", "checking"];
    const notes = [
      ...states.flatMap((state) => [null, "deploying", "waiting"].map((work) => plotSays({ state, work: work as "deploying" | "waiting" | null }))),
      ...(["ok", "trouble", "maintenance", "unknown", "past"] as const).map((look) => utilitySays({ look })),
      ...[true, false].flatMap((stopped) => [true, false].map((watching) => watcherSays({ stopped, watching }))),
    ];
    for (const says of notes) {
      if (says.note) assert.ok(words.has(says.note), says.note);
      if (says.note) assert.ok(says.status, `"${says.note}" has a status`);
    }
  });

  test("hovering says what it looks like and what has it", () => {
    const [trouble] = statusesOnMap(worldOf([], [["Cloudflare", "trouble"]]));
    assert.match(statusTitle(trouble!), /^Having trouble: .*\. Cloudflare\. Click to go to it\.$/);
    const [up] = statusesOnMap(worldOf(["a", "b", "c"].map((name) => ({ name, state: "up" as const }))));
    assert.match(statusTitle(up!, 2), /a, b and 2 more\. Click to go to each in turn\.$/, "the watcher counts too");
  });
});

describe("the key, grouped", () => {
  test("every status is in exactly one group", () => {
    const grouped = KEY_GROUPS.flatMap((g) => g.ids);
    assert.equal(new Set(grouped).size, grouped.length);
    assert.deepEqual([...grouped].sort(), STATUSES.map((s) => s.id).sort());
  });

  test("what needs a look comes first, and what's fine last", () => {
    assert.equal(KEY_GROUPS[0]!.title, "Needs a look");
    assert.ok(KEY_GROUPS[0]!.ids.includes("down"));
    assert.ok(KEY_GROUPS.at(-1)!.ids.includes("up"));
  });

  test("each row says what has it on the map now", () => {
    const groups = keyGroups(statusesOnMap(worldOf([{ name: "a", state: "down" }, { name: "b", state: "up" }])));
    const row = (id: string) => groups.flatMap((g) => g.rows).find((r) => r.id === id)!;
    assert.deepEqual(row("down").places.map((p) => p.id), ["a"]);
    assert.equal(row("up").places.length, 2, "b and the watcher");
    assert.equal(row("stale").places.length, 0);
  });
});

describe("clicking the key", () => {
  const places = (...ids: string[]) => ids.map((id) => ({ kind: "app" as const, id, name: id }));

  test("knows where each thing is: apps, services and the watcher", () => {
    const [down, trouble, up] = statusesOnMap(worldOf([{ name: "a", state: "down" }], [["Cloudflare", "trouble"]]));
    assert.deepEqual(down!.places, [{ kind: "app", id: "a", name: "a" }]);
    assert.equal(trouble!.places[0]!.kind, "provider");
    assert.deepEqual(up!.places, [{ kind: "tower", id: "watcher", name: "The watcher" }]);
  });

  test("goes to the first, then each in turn, then round again", () => {
    const all = places("a", "b", "c");
    assert.equal(nextPlace(all, undefined)?.id, "a");
    assert.equal(nextPlace(all, "app:a")?.id, "b");
    assert.equal(nextPlace(all, "app:c")?.id, "a");
  });

  test("starts again from the first when the last has moved on", () => {
    assert.equal(nextPlace(places("b", "c"), "app:a")?.id, "b");
  });

  test("nothing to go to, nowhere to go", () => {
    assert.equal(nextPlace([], "app:a"), undefined);
  });
});
