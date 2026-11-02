import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { App, Connection, Resource, Service } from "../shared/types.ts";
import { likelyMatches, obviousMatch, suggestionsFor } from "../server/suggestions.ts";

// "Get more from this app": what accounts could still add, and the one
// plain match to connect in a click.

const app = (connections: Partial<Connection>[] = [], url = "https://example.org/", slug = "star-map", name = "Star-Map") =>
  ({ id: "a", slug, name, url, ownerId: "u", live: true, checkIntervalMin: 5, connections: connections.map((c, i) => ({ id: `c${i}`, appId: "a", resource: "x", ...c })) }) as App;
const service = (type: Service["type"], id = type): Service => ({ id, ownerId: "u", type, name: `My ${type}`, canWrite: false });

const RESOURCES: Record<string, Resource[]> = {
  github: [
    { id: "acme/apps", label: "acme/apps", settings: { branch: "main", paths: [] } },
    { id: "acme/moon-base", label: "acme/moon-base", settings: { branch: "main", paths: [] } },
  ],
  cloudflare: [
    { id: "worker:star-map", label: "star-map", detail: "Worker · acme.com · example.org", settings: { kind: "worker", accountId: "acc", name: "star-map" } },
    { id: "worker:moon-base", label: "moon-base", detail: "Worker · acme.com · example.net", settings: { kind: "worker", accountId: "acc", name: "moon-base" } },
  ],
  "cloudflare-zone": [
    { id: "example.org", label: "example.org", settings: { zoneId: "z1", accountId: "acc" } },
    { id: "example.net", label: "example.net", settings: { zoneId: "z2", accountId: "acc" } },
  ],
};
const lister = async (_s: Service, kind: string) => RESOURCES[kind] ?? [];

describe("the obvious match", () => {
  test("a domain the address is on, a Worker serving it, a repo named like the app", () => {
    assert.equal(obviousMatch(app(), "cloudflare-zone", RESOURCES["cloudflare-zone"]!)?.id, "example.org");
    assert.equal(obviousMatch(app([], "https://www.example.net/", "moon-base", "Moon-Base"), "cloudflare-zone", RESOURCES["cloudflare-zone"]!)?.id, "example.net", "www is on the domain");
    assert.equal(obviousMatch(app([], "https://www.example.org/", "telescope", "Telescope"), "cloudflare", RESOURCES.cloudflare!)?.id, "worker:star-map", "a Worker serving the bare domain serves www too");
    assert.equal(obviousMatch(app(), "cloudflare", RESOURCES.cloudflare!)?.id, "worker:star-map");
    assert.equal(obviousMatch(app([], "https://example.net/", "moon-base", "Moon-Base"), "github", RESOURCES.github!)?.id, "acme/moon-base");
  });

  test("nothing plainly the app's means no guess", () => {
    assert.equal(obviousMatch(app(), "github", RESOURCES.github!), undefined, "apps isn't named like Star-Map");
    const two = [...RESOURCES.cloudflare!, { id: "star-map", label: "star-map", detail: "Pages · acme.com" }];
    assert.equal(obviousMatch(app(), "cloudflare", two), undefined, "a Worker and a Pages project both called star-map: you choose");
  });

  test("the longest domain wins when the address is on two", () => {
    const zones = [{ id: "example.com", label: "example.com" }, { id: "app.example.com", label: "app.example.com" }];
    assert.equal(obviousMatch(app([], "https://app.example.com/"), "cloudflare-zone", zones)?.id, "app.example.com");
  });
});

describe("a few named like the app", () => {
  // periskopos.com, with both the app's repo and the site's in one account.
  const site = app([], "https://periskopos.com/", "periskopos", "periskopos.com");
  const repos: Resource[] = [
    { id: "periskopos/periskopos", label: "periskopos/periskopos", settings: { branch: "main", paths: [] } },
    { id: "periskopos/periskopos.com", label: "periskopos/periskopos.com", settings: { branch: "main", paths: [] } },
    { id: "periskopos/other", label: "periskopos/other", settings: { branch: "main", paths: [] } },
  ];

  test("a repo named after the whole address matches, dots and all", () => {
    assert.deepEqual(likelyMatches(site, "github", repos).map((r) => r.id), ["periskopos/periskopos.com", "periskopos/periskopos"], "the whole address first");
    assert.equal(obviousMatch(site, "github", repos), undefined, "two of them: never picked for you");
  });

  test("they're offered to choose from, not connected in one click", async () => {
    const [github] = await suggestionsFor(site, [service("github")], async () => repos);
    assert.equal(github!.match, undefined);
    assert.deepEqual(github!.choices?.map((c) => c.resource), ["periskopos/periskopos.com", "periskopos/periskopos"]);
    assert.deepEqual(github!.choices![0]!.settings, { branch: "main", paths: "" });
  });
});

describe("what's suggested", () => {
  test("for an app with only its address: the repo to choose, the Worker and the domain in one click", async () => {
    const list = await suggestionsFor(app(), [service("github"), service("cloudflare")], lister);
    assert.deepEqual(list.map((s) => [s.kind, s.match?.resource]), [["github", undefined], ["cloudflare", "worker:star-map"], ["cloudflare-zone", "example.org"]]);
    const zone = list.find((s) => s.kind === "cloudflare-zone")!;
    assert.equal(zone.match!.settings.host, "example.org", "its DNS record and certificate are checked for the app's name");
    assert.deepEqual(list[0]!.serviceName, "My github");
  });

  test("what the app already has isn't suggested, nor a second host", async () => {
    const has = app([{ type: "github" }, { type: "render", serviceId: "render" }]);
    const list = await suggestionsFor(has, [service("github"), service("render"), service("cloudflare")], lister);
    assert.deepEqual(list.map((s) => s.kind), ["cloudflare-zone"], "Render is its host, so no Worker; only the domain");
  });

  test("a domain the account doesn't hold isn't offered; an account that can't be read still says what it could add", async () => {
    const elsewhere = app([], "https://other.dev/", "other", "Other");
    const list = await suggestionsFor(elsewhere, [service("cloudflare"), service("supabase")], async (_s, kind) => {
      if (kind === "supabase") throw new Error("unreachable");
      return RESOURCES[kind] ?? [];
    });
    assert.deepEqual(list.map((s) => [s.kind, Boolean(s.match)]), [["cloudflare", false], ["supabase", false]]);
  });

  test("an app with everything gets nothing", async () => {
    const full = app([{ type: "github" }, { type: "cloudflare" }, { type: "cloudflare-zone" }]);
    assert.deepEqual(await suggestionsFor(full, [service("github"), service("cloudflare")], lister), []);
  });
});
