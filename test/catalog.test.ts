import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ACCOUNTS, ACCOUNT_KINDS, CONNECTIONS, checkEvery, kindLabel, connectionLabel, hostLabel, isHostType, isOutageType } from "../shared/catalog.ts";
import { SERVICE_TYPES, integrations } from "../server/integrations/index.ts";

// The catalog describes every kind of account and connection; the
// integrations do the work. A provider is added in both or neither.

describe("the catalog and the integrations agree", () => {
  test("every integration is described, and every description has an integration", () => {
    assert.deepEqual(Object.keys(integrations).sort(), Object.keys(CONNECTIONS).sort());
  });

  test("an integration carries its description: name, account, incident kind, role", () => {
    for (const [type, integration] of Object.entries(integrations)) {
      const info = CONNECTIONS[type]!;
      assert.equal(integration.label, info.label, type);
      assert.equal(integration.serviceType, info.account, type);
      assert.equal(integration.needsService, info.account !== undefined, type);
      assert.equal(integration.incidentKind, info.incidentKind, type);
      assert.equal(integration.role, info.role, type);
    }
  });

  test("a connection shows details exactly when the catalog says it does", () => {
    for (const [type, integration] of Object.entries(integrations)) {
      assert.equal(Boolean(integration.details), CONNECTIONS[type]!.shows !== undefined, type);
    }
  });

  test("an account offers only connections made through it, each saying what it gives", () => {
    for (const [type, account] of Object.entries(ACCOUNTS)) {
      assert.ok(account.offers.length > 0, type);
      for (const kind of account.offers) {
        assert.equal(CONNECTIONS[kind]?.account, type, `${type} offers ${kind}`);
        assert.ok(CONNECTIONS[kind]?.offer, `${kind} says what it gives`);
        assert.ok(integrations[kind]?.listResources, `${kind} can list what the account holds`);
      }
      assert.equal(SERVICE_TYPES[type as keyof typeof SERVICE_TYPES].serviceType, type);
    }
  });
});

describe("kinds of account", () => {
  test("each account says what it's for, from the kinds there are, and every kind but Domains lists one first", () => {
    const kinds = new Set(ACCOUNT_KINDS.map((k) => k.key));
    for (const [type, account] of Object.entries(ACCOUNTS)) {
      for (const k of account.kinds) assert.ok(kinds.has(k), `${type}: ${k}`);
      assert.equal(new Set(account.kinds).size, account.kinds.length, `${type} names a kind once`);
    }
    const first = new Set(Object.values(ACCOUNTS).map((a) => a.kinds[0]));
    assert.deepEqual(ACCOUNT_KINDS.filter((k) => !first.has(k.key)).map((k) => k.key), ["domains"], "Cloudflare's domains are listed under Hosting");
    assert.equal(kindLabel("payments"), "Payments");
  });
});

describe("what the catalog answers", () => {
  test("names: a Cloudflare connection is a Worker or Pages; others by their type", () => {
    assert.equal(connectionLabel({ type: "cloudflare", settings: { kind: "worker" } }), "Cloudflare Worker");
    assert.equal(connectionLabel({ type: "cloudflare", settings: {} }), "Cloudflare Pages");
    assert.equal(connectionLabel({ type: "ssl" }), "SSL certificate");
    assert.equal(connectionLabel({ type: "made-up" }), "made-up");
    assert.equal(connectionLabel({ type: "site", settings: { label: "Docs" } }), "Docs", "an extra site goes by the name given it");
  });

  test("how often each is checked: expiry dates daily, the rest on the app's interval", () => {
    assert.equal(checkEvery("ssl", 5), "daily");
    assert.equal(checkEvery("domain", 5), "daily");
    // Slower providers on their own clock, in hours when whole.
    assert.equal(checkEvery("openai", 5), "every 1 h");
    assert.equal(checkEvery("search-console", 5), "every 6 h");
    assert.equal(checkEvery("stripe", 5), "every 15 min");
    assert.equal(checkEvery("site", 5), "every 5 min");
    assert.equal(checkEvery("github", 15), "every 15 min");
    assert.equal(integrations.ssl!.everyMs, 86_400_000, "the watcher reads the same interval");
  });

  test("hosts, and what's an outage", () => {
    assert.deepEqual(["render", "cloudflare", "github", "site"].map(isHostType), [true, true, false, false]);
    assert.equal(hostLabel("cloudflare"), "Cloudflare");
    assert.equal(hostLabel("render"), "Render");
    assert.deepEqual(["site", "github", "ssl", "cloudflare-zone", "made-up"].map(isOutageType), [true, false, false, false, true]);
  });
});
