import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CheckResult, CheckState, Connection } from "../shared/types.ts";
import { openDb } from "../server/db.ts";
import { overallState } from "../server/status.ts";
import * as store from "../server/store.ts";

// What an app's checks add up to, and adding the same connection twice.

const AT = "2026-11-01T20:00:00.000Z";
const check = (type: string, state: CheckState): { conn: Connection; result: CheckResult } => ({
  conn: { id: `c_${type}`, appId: "a1", type, resource: "example.com" },
  result: { state, at: AT },
});

describe("an app's state", () => {
  test("a domain whose expiry can't be looked up doesn't hide a site that answers", () => {
    assert.equal(overallState([check("site", "up"), check("ssl", "up"), check("domain", "unknown")]), "up");
  });

  test("the site itself unknown (this PC offline) makes the app unknown", () => {
    assert.equal(overallState([check("site", "unknown"), check("domain", "up")]), "unknown");
  });

  test("with no check able to tell, it's unknown", () => {
    assert.equal(overallState([check("domain", "unknown"), check("ssl", "unknown")]), "unknown");
  });

  test("down and attention still win", () => {
    assert.equal(overallState([check("site", "down"), check("domain", "unknown")]), "down");
    assert.equal(overallState([check("site", "up"), check("ssl", "down")]), "attention");
  });
});

describe("adding a connection", () => {
  test("the same account and resource twice (a double click) is one connection", () => {
    const db = openDb(":memory:");
    const user = store.createUser(db, "Me");
    const service = store.createService(db, user.id, { type: "github", name: "My GitHub", canWrite: false });
    const app = store.createApp(db, user.id, { name: "Tuby", url: "https://tuby.example/" });
    const input = { type: "github", serviceId: service.id, resource: "me/tuby", settings: { branch: "main", paths: [] } };
    const first = store.addConnection(db, app, input);
    const second = store.addConnection(db, app, input);
    assert.equal(second.id, first.id);
    assert.equal(store.addConnection(db, app, { ...input, settings: { branch: "dev", paths: [] } }).id, first.id, "another branch is still the same repo");
    const other = store.addConnection(db, app, { ...input, settings: { branch: "main", paths: ["apps/web"] } });
    assert.notEqual(other.id, first.id, "another folder of the same repo is another connection");
    const github = store.getApp(db, user.id, app.slug)!.connections.filter((c) => c.type === "github");
    assert.equal(github.length, 2);
  });

  test("what counts as the same connection", () => {
    const db = openDb(":memory:");
    const user = store.createUser(db, "Me");
    const service = store.createService(db, user.id, { type: "github", name: "My GitHub", canWrite: false });
    const app = store.createApp(db, user.id, { name: "Tuby", url: "https://tuby.example/" });
    const input = { type: "github", serviceId: service.id, resource: "me/tuby", settings: { branch: "main", paths: [] } };
    store.addConnection(db, app, input);
    const now = store.getApp(db, user.id, app.slug)!;
    assert.ok(store.sameConnection(now, { ...input, settings: { branch: "main", paths: "" } }), "no folders, however it's written");
    assert.ok(store.sameConnection(now, { ...input, settings: { branch: "dev", paths: [] } }), "another branch");
    assert.equal(store.sameConnection(now, { ...input, resource: "me/tuby.com" }), undefined, "another repo");
    assert.equal(store.sameConnection(now, { ...input, settings: { branch: "main", paths: ["web"] } }), undefined, "other folders");
  });
});
