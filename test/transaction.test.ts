import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDb, transaction } from "../server/db.ts";
import { applyImport, planImport } from "../server/setup-import.ts";
import * as store from "../server/store.ts";
import { getSettings } from "../server/settings.ts";

describe("transactions", () => {
  const count = (db: ReturnType<typeof openDb>) => (db.prepare("SELECT COUNT(*) AS n FROM apps").get() as { n: number }).n;

  test("one inside another is kept only if the outer one is", () => {
    const db = openDb(":memory:");
    const owner = store.createUser(db, "Me").id;
    transaction(db, () => {
      store.createApp(db, owner, { name: "One", url: "https://one.example.org" });
    });
    assert.equal(count(db), 1);
    assert.throws(() =>
      transaction(db, () => {
        store.createApp(db, owner, { name: "Two", url: "https://two.example.org" });
        throw new Error("the outer one fails");
      }),
    );
    assert.equal(count(db), 1, "the inner one went with it");
    assert.equal(db.isTransaction, false);
  });

  test("an inner one that fails leaves the outer one able to go on", () => {
    const db = openDb(":memory:");
    const owner = store.createUser(db, "Me").id;
    transaction(db, () => {
      assert.throws(() => transaction(db, () => { throw new Error("inner"); }));
      store.createApp(db, owner, { name: "Kept", url: "https://kept.example.org" });
    });
    assert.equal(count(db), 1);
  });

  test("an import that fails half way adds nothing", () => {
    const db = openDb(":memory:");
    const owner = store.createUser(db, "Me").id;
    const setup = { periskopos: "0", apps: [{ name: "A", url: "https://a.example.org", live: true, checkIntervalMin: 5, connections: [] }, { name: "B", url: "https://b.example.org", live: true, checkIntervalMin: 5, connections: [] }], accounts: [] };
    const work = planImport(db, owner, getSettings(db, owner), setup);
    assert.equal(work.add.length, 2);
    // The second app can't be added: the database refuses it.
    db.exec("CREATE TRIGGER refuse_b BEFORE INSERT ON apps WHEN NEW.name = 'B' BEGIN SELECT RAISE(ABORT, 'refused'); END");
    assert.throws(() => applyImport(db, owner, work, false));
    assert.equal(count(db), 0, "the first app was not kept");
  });
});
