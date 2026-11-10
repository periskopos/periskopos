import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { beforeEach, describe, test } from "node:test";
import { daysSummary, uptimeBand } from "../shared/fleet.ts";
import type { App, UptimeDay } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import * as history from "../server/history.ts";
import { silentNotifier } from "../server/alerts/notify.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { tempDir } from "./tmp.ts";

// The strip on the Apps page: one bar a day, and it must say exactly what the
// app's History says, with a day nobody watched left as a gap.

const TOKEN = "t".repeat(43);
const BASE = "http://localhost:4100";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.now();

let db: DatabaseSync;
let gc: ReturnType<typeof createApp>;
let app: App;
let userId: string;

beforeEach(() => {
  db = openDb(":memory:");
  userId = store.createUser(db, "Me").id;
  app = store.createApp(db, userId, { name: "Star-Map", url: "https://example.org/" });
  db.prepare("UPDATE apps SET created_at = ? WHERE id = ?").run(new Date(NOW - 3 * DAY).toISOString(), app.id);
  const dist = tempDir("periskopos-web-");
  writeFileSync(path.join(dist, "index.html"), "");
  gc = createApp({ db, token: TOKEN, port: 4100, distDir: dist, watcher: new Watcher({ db, notifier: silentNotifier, baseUrl: BASE, isOnline: async () => true }) });
});

const read = async () => (await (await gc.request(`${BASE}/api/status/days`, { headers: { "x-periskopos-token": TOKEN } })).json()) as { days: Record<string, UptimeDay[]> };

describe("an app's days", () => {
  test("are the same days as its history, oldest first, ending today", () => {
    history.heartbeat(db, history.startPeriod(db, NOW - 2 * DAY), NOW);
    const site = app.connections.find((c) => c.type === "site")!;
    const outage = history.openIncident(db, { appId: app.id, connectionId: site.id, kind: "outage", startedAt: new Date(NOW - 5 * HOUR).toISOString(), reason: "Site is down" });
    history.closeIncident(db, outage.id, new Date(NOW - 4 * HOUR).toISOString());

    const days = history.uptimeDays(db, app.id, NOW);
    const full = history.appHistory(db, app.id, NOW).days;
    assert.equal(days.length, 30);
    assert.deepEqual(
      days,
      full.map(({ day, uptimePct, watchedMin, incidents }) => ({ day, ...(uptimePct !== undefined ? { uptimePct } : {}), watchedMin, incidents })),
    );
    assert.ok(days.some((d) => d.incidents === 1 && d.uptimePct !== undefined && d.uptimePct < 100), "the outage shows on its day");
  });

  test("before it was watched are gaps, not good days", () => {
    history.heartbeat(db, history.startPeriod(db, NOW - HOUR), NOW);
    const days = history.uptimeDays(db, app.id, NOW);
    assert.equal(days[0]?.uptimePct, undefined);
    assert.equal(days[0]?.watchedMin, 0);
    assert.equal(uptimeBand(days[0]?.uptimePct), undefined);
    assert.equal(days.at(-1)?.uptimePct, 100);
  });
});

describe("GET /status/days", () => {
  test("has live apps only: one not live yet has no uptime to speak of", async () => {
    const soon = store.createApp(db, userId, { name: "Soon", url: "https://soon.example.org/", live: false });
    const { days } = await read();
    assert.equal(days[app.slug]?.length, 30);
    assert.equal(days[soon.slug], undefined);
  });
});

describe("how a day reads", () => {
  test("the bands are the History tab's", () => {
    assert.equal(uptimeBand(100), "up");
    assert.equal(uptimeBand(99.9), "up");
    assert.equal(uptimeBand(99.89), "warn");
    assert.equal(uptimeBand(99), "warn");
    assert.equal(uptimeBand(98.99), "down");
    assert.equal(uptimeBand(0), "down");
    assert.equal(uptimeBand(undefined), undefined);
  });

  const day = (uptimePct?: number): UptimeDay => ({ day: "2026-11-01", watchedMin: uptimePct === undefined ? 0 : 60, incidents: 0, ...(uptimePct !== undefined ? { uptimePct } : {}) });

  test("in words, gaps never count as good", () => {
    assert.equal(daysSummary([day(), day()]), "Not watched in the last 2 days. Open its history.");
    assert.equal(daysSummary([day(100), day(100)]), "Uptime, last 2 days: every day watched at 99.9% or better. Open its history.");
    assert.equal(daysSummary([day(), day(100), day(50)]), "Uptime, last 3 days: 1 day below 99.9%, 1 not watched. Open its history.");
    assert.equal(daysSummary([day(98), day(50)]), "Uptime, last 2 days: 2 days below 99.9%. Open its history.");
  });
});
