import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { openDb } from "../server/db.ts";
import { agentMayCall } from "../server/security.ts";
import { DEFAULT_SETTINGS, getSettings, updateSettings } from "../server/settings.ts";
import { applyImport, planImport } from "../server/setup-import.ts";
import * as store from "../server/store.ts";
import type { Settings } from "../shared/types.ts";

const setup = (over: Record<string, unknown> = {}) => ({
  periskopos: "9.9.9",
  exportedAt: "2026-11-01T10:00:00.000Z",
  apps: [
    {
      name: "Shop",
      url: "https://shop.example.org",
      notes: "The shop",
      live: false,
      checkIntervalMin: 15,
      connections: [
        { type: "site", resource: "https://shop.example.org", settings: { expectText: "Welcome" } },
        { type: "domain", resource: "shop.example.org" },
        { type: "site", resource: "https://shop.example.org/health", settings: { label: "/health" } },
        { type: "link", resource: "https://docs.example.org", settings: { label: "Docs" } },
        { type: "github", resource: "me/shop", settings: {}, account: "Work" },
      ],
    },
  ],
  accounts: [{ type: "github", name: "Work" }],
  settings: DEFAULT_SETTINGS,
  ...over,
});

describe("importing a setup", () => {
  let db: ReturnType<typeof openDb>;
  let me: string;
  const plan = (file: unknown) => planImport(db, me, getSettings(db, me), file);
  const run = (file: unknown, useSettings = false) => applyImport(db, me, plan(file), useSettings);
  const shop = () => store.listApps(db, me).find((a) => a.name === "Shop")!;

  beforeEach(() => {
    db = openDb(":memory:");
    me = store.createUser(db, "Me").id;
  });

  test("something that isn't a setup file is refused", () => {
    for (const bad of [null, 3, [], {}, { apps: [] }, { periskopos: "1", apps: "x" }]) assert.throws(() => plan(bad), /isn't a setup file/);
  });

  test("the preview changes nothing", () => {
    const { plan: seen } = plan(setup());
    assert.deepEqual(seen.newApps.map((a) => a.name), ["Shop"]);
    assert.equal(store.listApps(db, me).length, 0);
  });

  test("an app comes back as it was, with what it kept and how it was set up", () => {
    const [added] = run(setup());
    assert.equal(added!.notes, "The shop");
    assert.equal(added!.live, false);
    assert.equal(added!.checkIntervalMin, 15);
    const app = shop();
    const sites = app.connections.filter((c) => c.type === "site");
    assert.equal(sites.length, 2, "the app's own check isn't added twice");
    assert.equal(sites.find((c) => !c.resource.endsWith("/health"))!.settings?.expectText, "Welcome");
    assert.equal(app.connections.filter((c) => c.type === "domain").length, 1);
    assert.equal(app.connections.find((c) => c.type === "link")!.settings?.label, "Docs");
  });

  test("a check the file doesn't have stays removed", () => {
    run(setup());
    assert.equal(shop().connections.some((c) => c.type === "ssl"), false, "the certificate check was removed before the export");
  });

  test("a connection that needs an account waits for one, and the account has to be added by hand", () => {
    const { plan: seen } = plan(setup());
    assert.deepEqual(seen.newApps[0]!.waiting, ["GitHub me/shop"]);
    assert.deepEqual(seen.accounts.map((a) => a.name), ["Work"]);
    run(setup());
    assert.equal(shop().connections.some((c) => c.type === "github"), false);
    assert.equal(store.listServices(db, me).length, 0, "an account with no key is never made");
  });

  test("importing again once the account is here connects it, and adds nothing else", () => {
    run(setup());
    const before = shop().connections.length;
    const work = store.createService(db, me, { type: "github", name: "Work", canWrite: false });
    store.createService(db, me, { type: "github", name: "Home", canWrite: false });
    const again = plan(setup());
    assert.deepEqual(again.plan.newApps, []);
    assert.deepEqual(again.plan.existing, [{ name: "Shop", connections: ["GitHub me/shop (through Work)"], waiting: [] }]);
    assert.deepEqual(again.plan.accounts, [], "that account is here now");
    run(setup());
    const app = shop();
    assert.equal(app.connections.length, before + 1);
    assert.equal(app.connections.find((c) => c.type === "github")!.serviceId, work.id, "the account it used, by name");
    assert.deepEqual(plan(setup()).plan.existing, [{ name: "Shop", connections: [], waiting: [] }], "a third time does nothing");
  });

  test("with several accounts and no name to go by, it doesn't guess", () => {
    store.createService(db, me, { type: "github", name: "One", canWrite: false });
    store.createService(db, me, { type: "github", name: "Two", canWrite: false });
    const file = setup({ apps: [{ name: "Shop", url: "https://shop.example.org", connections: [{ type: "github", resource: "me/shop", settings: {} }] }] });
    assert.deepEqual(plan(file).plan.newApps[0]!.waiting, ["GitHub me/shop"]);
  });

  test("an app already here is left alone, however its URL is written", () => {
    const mine = store.createApp(db, me, { name: "My shop", url: "https://shop.example.org/", notes: "Mine", checkIntervalMin: 1 });
    const count = mine.connections.length;
    const [added] = [run(setup())];
    assert.deepEqual(added, []);
    const app = store.listApps(db, me)[0]!;
    assert.deepEqual([app.name, app.notes, app.checkIntervalMin, app.connections.length], ["My shop", "Mine", 1, count]);
  });

  test("a bad line is reported, and the rest still comes", () => {
    const { plan: seen, add } = plan(
      setup({
        apps: [
          { name: "No address", url: "javascript:alert(1)" },
          { url: "https://nameless.example.org" },
          "nonsense",
          {
            name: "Good",
            url: "https://good.example.org",
            connections: [
              { type: "constructor", resource: "x" },
              { type: "from-the-future", resource: "x" },
              { type: "link", resource: "javascript:alert(1)", settings: { label: "Bad" } },
              { type: "site", resource: "https://good.example.org" },
              7,
            ],
          },
        ],
      }),
    );
    assert.equal(seen.refused.length, 3);
    assert.equal(seen.refused[0]!.name, "No address");
    assert.deepEqual(add.map((a) => a.name), ["Good"]);
    assert.equal(seen.newApps[0]!.unread.length, 4);
  });

  test("an interval that isn't on offer falls back to the default", () => {
    const [added] = run(setup({ apps: [{ name: "Odd", url: "https://odd.example.org", checkIntervalMin: 3 }] }));
    assert.equal(added!.checkIntervalMin, 5);
  });

  test("a file's own endpoint is said to need connecting, never set", () => {
    const file = setup({ apps: [{ name: "Own", url: "https://own.example.org", endpoint: "https://evil.example.org/hook" }] });
    assert.equal(plan(file).plan.newApps[0]!.endpoint, true);
    assert.equal(run(file)[0]!.protocol, undefined);
  });

  describe("its settings", () => {
    const dangerous: Partial<Settings> = {
      agentAccess: true,
      watcherEnabled: false,
      checksKeptDays: 7,
      phoneChannel: "email",
      emailTo: "someone@else.example",
      ntfyServer: "https://else.example",
      telegramChatId: "42",
      alertsPausedUntil: "2099-01-01T00:00:00.000Z",
      appPauses: { a: "2099-01-01T00:00:00.000Z" },
    };

    test("only the listed ones are even offered", () => {
      const file = setup({ settings: { ...DEFAULT_SETTINGS, ...dangerous, alertDeploys: false, defaultCheckIntervalMin: 30 } });
      assert.deepEqual(plan(file).plan.settings.map((s) => [s.key, s.from, s.to]), [["alertDeploys", true, false], ["defaultCheckIntervalMin", 5, 30]]);
    });

    test("nothing changes unless asked, and asked, only those do", () => {
      const before = getSettings(db, me);
      const file = setup({ settings: { ...DEFAULT_SETTINGS, ...dangerous, alertDeploys: false } });
      run(file);
      assert.deepEqual(getSettings(db, me), before);
      run(file, true);
      assert.deepEqual(getSettings(db, me), { ...before, alertDeploys: false });
    });

    test("a nonsense value is ignored", () => {
      const file = setup({ settings: { alertDeploys: "no", defaultCheckIntervalMin: 3, notificationsEnabled: 1 } });
      assert.deepEqual(plan(file).plan.settings, []);
    });

    test("one already the same isn't listed", () => {
      updateSettings(db, me, { alertDeploys: false });
      assert.deepEqual(plan(setup({ settings: { alertDeploys: false } })).plan.settings, []);
    });
  });

  test("assistants can't import, or pause", () => {
    assert.equal(agentMayCall("POST", "/api/settings/import"), false);
    assert.equal(agentMayCall("POST", "/api/settings/import/preview"), false);
    assert.equal(agentMayCall("POST", "/api/apps/shop/pause"), false);
  });
});
