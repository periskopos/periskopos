import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text } from "./dom-helpers.ts";
import type { App, Incident } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import { agentMayCall } from "../server/security.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { incidentCounts, incidentList } from "../web/src/views/app/incidents.ts";
import { tempDir } from "./tmp.ts";

// Marking an incident a false alarm (PRD §12: no false "down"
// notifications in a normal week): the app was fine, the check wasn't. So
// it no longer counts against uptime, History counts how many there were,
// and only I can mark one, on screen.

const TOKEN = "t".repeat(43);
const BASE = "http://localhost:4100";
const HOUR = 3_600_000;
const NOW = Date.now();

let db: DatabaseSync;
let gc: ReturnType<typeof createApp>;
let app: App;
let outage: Incident;

beforeEach(() => {
  db = openDb(":memory:");
  const user = store.createUser(db, "Me");
  app = store.createApp(db, user.id, { name: "Star-Map", url: "https://example.org/" });
  const site = app.connections.find((c) => c.type === "site")!;
  // Watched for the last 10 hours, down for one of them.
  db.prepare("UPDATE apps SET created_at = ? WHERE id = ?").run(new Date(NOW - 11 * HOUR).toISOString(), app.id);
  history.heartbeat(db, history.startPeriod(db, NOW - 10 * HOUR), NOW);
  outage = history.openIncident(db, { appId: app.id, connectionId: site.id, kind: "outage", startedAt: new Date(NOW - 3 * HOUR).toISOString(), reason: "Site is down: timed out" });
  history.closeIncident(db, outage.id, new Date(NOW - 2 * HOUR).toISOString());
  const dist = tempDir("periskopos-web-");
  writeFileSync(path.join(dist, "index.html"), "");
  gc = createApp({ db, token: TOKEN, port: 4100, distDir: dist, watcher: new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true }) });
});

async function mark(slug: string, id: string, body: unknown) {
  const res = await gc.request(`${BASE}/api/apps/${slug}/incidents/${id}`, { method: "PATCH", headers: { "x-periskopos-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { incident?: Incident; error?: string } };
}

describe("a false alarm", () => {
  test("is marked, and the mark can be taken back", async () => {
    const on = await mark(app.slug, outage.id, { falseAlarm: true });
    assert.equal(on.status, 200);
    assert.equal(on.body.incident?.falseAlarm, true);
    assert.equal(history.appHistory(db, app.id, NOW).incidents[0]?.falseAlarm, true);

    const off = await mark(app.slug, outage.id, { falseAlarm: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.incident?.falseAlarm, undefined);
    assert.equal(history.appHistory(db, app.id, NOW).incidents[0]?.falseAlarm, undefined);
  });

  test("no longer counts against uptime, nor as an incident on its day", () => {
    const before = history.appHistory(db, app.id, NOW);
    assert.equal(before.uptimePct, 90);
    assert.equal(before.days.reduce((n, d) => n + d.incidents, 0), 1);

    history.setFalseAlarm(db, app.id, outage.id, true);
    const after = history.appHistory(db, app.id, NOW);
    assert.equal(after.uptimePct, 100);
    assert.equal(after.days.reduce((n, d) => n + d.incidents, 0), 0);
    assert.equal(after.incidents.length, 1, "still listed, marked");
    assert.equal(history.uptime(db, app.id, NOW - 10 * HOUR, NOW, NOW).uptimePct, 100, "the Fleet's figure too");
  });

  test("only on the app the incident belongs to", async () => {
    const other = store.createApp(db, app.ownerId, { name: "Moon-Base", url: "https://example.net/" });
    const res = await mark(other.slug, outage.id, { falseAlarm: true });
    assert.equal(res.status, 404);
    assert.equal(history.appHistory(db, app.id, NOW).incidents[0]?.falseAlarm, undefined);
    assert.equal((await mark(app.slug, "i_nope", { falseAlarm: true })).status, 404);
  });

  test("needs a yes or no", async () => {
    for (const body of [{}, { falseAlarm: "yes" }, { falseAlarm: 1 }]) {
      const res = await mark(app.slug, outage.id, body);
      assert.equal(res.status, 400);
      assert.match(res.body.error ?? "", /falseAlarm must be true or false/);
    }
  });

  test("is marked on screen only: an agent can't", () => {
    assert.equal(agentMayCall("PATCH", `/api/apps/${app.slug}/incidents/${outage.id}`), false);
  });
});

describe("on screen", () => {
  const incident = (over: Partial<Incident> = {}): Incident => ({
    id: "i_1", appId: "a_1", kind: "outage", startedAt: new Date(NOW - 2 * HOUR).toISOString(), endedAt: new Date(NOW - HOUR).toISOString(), reason: "Site is down", ...over,
  });

  test("History counts incidents and false alarms", () => {
    assert.equal(incidentCounts([incident()]), "1 incident · no false alarms");
    assert.equal(incidentCounts([incident({ falseAlarm: true }), incident(), incident(), incident()]), "4 incidents · 1 false alarm (25%)");
    assert.equal(incidentCounts([incident({ falseAlarm: true }), incident({ falseAlarm: true })]), "2 incidents · 2 false alarms (100%)");
  });

  test("a marked incident says so, and its button takes the mark back", async () => {
    const calls: [string, boolean][] = [];
    const list = incidentList([incident({ falseAlarm: true }), incident({ id: "i_2" })], async (i, on) => {
      calls.push([i.id, on]);
    });
    const [marked, plain] = [...list.querySelectorAll("li")];
    assert.match(text(marked), /False alarm/);
    assert.equal(marked?.querySelector("button")?.textContent, "Not a false alarm");
    assert.equal(plain?.querySelector("button")?.textContent, "False alarm");
    marked?.querySelector("button")?.click();
    plain?.querySelector("button")?.click();
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(calls, [["i_1", false], ["i_2", true]]);
  });

  test("without a way to mark (Overview), there are no buttons", () => {
    const list = incidentList([incident({ falseAlarm: true })]);
    assert.equal(list.querySelector("button") === null, true); // a node never goes to assert: printing one on failure hangs the run
    assert.match(text(list), /False alarm/);
  });
});
