import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { createApp } from "../server/app.ts";
import { openDb } from "../server/db.ts";
import { integrations } from "../server/integrations/index.ts";
import { Watcher } from "../server/watcher.ts";

// What an export holds is what a parser once returned. If a parser stopped
// accepting its own answer, that kind of connection couldn't be imported.
describe("every kind of connection can be read back", () => {
  const UUID = "11111111-1111-4111-8111-111111111111";
  const railway = { projectId: "22222222-2222-4222-8222-222222222222", environmentId: "33333333-3333-4333-8333-333333333333", name: "api" };
  const samples: Record<string, { resource: string; settings?: Record<string, unknown> }> = {
    site: { resource: "https://a.example.org", settings: { label: "/health", expectStatus: 200, expectText: "ok" } },
    link: { resource: "https://a.example.org/docs", settings: { label: "Docs" } },
    ssl: { resource: "a.example.org:8443" },
    domain: { resource: "a.example.org", settings: { expiresOn: "2030-01-01" } },
    github: { resource: "me/repo", settings: { branch: "main", paths: ["web"] } },
    "github-security": { resource: "me/repo" },
    vercel: { resource: "prj_abc123", settings: { name: "web", teamId: "team_abc" } },
    "vercel-logs": { resource: "prj_abc123", settings: { name: "web" } },
    netlify: { resource: UUID, settings: { name: "web" } },
    "digitalocean-logs": { resource: UUID },
    railway: { resource: UUID, settings: railway },
    "railway-logs": { resource: UUID, settings: railway },
    supabase: { resource: "abcdefghijklmnopqrst", settings: { name: "db" } },
    "supabase-logs": { resource: "abcdefghijklmnopqrst" },
    fly: { resource: "my-app" },
    "fly-logs": { resource: "my-app" },
    "render-logs": { resource: "srv-abc123" },
    sentry: { resource: "me/project" },
    stripe: { resource: "acct_1AbC" },
    paddle: { resource: "account" },
  };

  for (const [type, input] of Object.entries(samples)) {
    test(type, () => {
      const first = integrations[type]!.parse({ resource: input.resource, settings: input.settings });
      assert.deepEqual(integrations[type]!.parse({ resource: first.resource, settings: first.settings }), first);
    });
  }
});

describe("importing and pausing, through the API", () => {
  const TOKEN = "t".repeat(43);
  const distDir = mkdtempSync(path.join(tmpdir(), "periskopos-import-"));
  writeFileSync(path.join(distDir, "index.html"), '<meta name="periskopos" content="app" />');
  const silent = { notify: async () => undefined };

  type Body = {
    app: { slug: string; id: string };
    apps: { connections: { type: string; resource: string }[]; notes?: string }[];
    plan: { newApps: unknown[] };
    added: number;
    connected: number;
    settings: { appPauses: Record<string, string> };
  };
  type Answer = { status: number; body: Body };
  function server() {
    const db = openDb(":memory:");
    const watcher = new Watcher({ db, notifier: silent, baseUrl: "http://localhost:4100", isOnline: async () => true });
    const gc = createApp({ db, token: TOKEN, port: 4100, distDir, watcher });
    const call = async (method: string, url: string, body?: unknown): Promise<Answer> => {
      const r = await gc.request(`http://localhost:4100/api${url}`, { method, headers: { "x-periskopos-token": TOKEN, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: r.status, body: (r.status === 204 ? {} : await r.json()) as Body };
    };
    return call;
  }
  const inAnHour = () => new Date(Date.now() + 3_600_000).toISOString();

  async function ready() {
    const call = server();
    await call("POST", "/setup", { name: "Me" });
    return call;
  }

  test("what's exported imports into an empty Periskopos, and again changes nothing", async () => {
    const here = await ready();
    const made = (await here("POST", "/apps", { name: "Shop", url: "https://shop.example.org", notes: "Mine" })).body.app;
    await here("POST", `/apps/${made.slug}/connections`, { type: "link", resource: "https://docs.example.org", settings: { label: "Docs" } });
    const setup = (await here("GET", "/settings/export")).body;

    const there = await ready();
    const { plan } = (await there("POST", "/settings/import/preview", { setup })).body;
    assert.equal(plan.newApps.length, 1);
    assert.equal((await there("GET", "/apps")).body.apps.length, 0, "a preview changes nothing");

    const done = (await there("POST", "/settings/import", { setup })).body;
    assert.deepEqual([done.added, done.connected], [1, 0]);
    const copy = (await there("GET", "/settings/export")).body;
    const lines = (s: Body) => s.apps[0]!.connections.map((c) => `${c.type} ${c.resource}`).sort();
    assert.deepEqual(lines(copy), lines(setup));
    assert.equal(copy.apps[0]!.notes, "Mine");

    assert.equal((await there("POST", "/settings/import", { setup })).body.added, 0);
    assert.equal((await there("GET", "/apps")).body.apps.length, 1);
  });

  test("an export holds only the settings an import takes: no address, chat id or pause", async () => {
    const call = await ready();
    await call("PATCH", "/settings", { emailTo: "me@example.org", telegramChatId: "12345", appPauses: {} });
    const { settings } = (await call("GET", "/settings/export")).body as { settings: Record<string, unknown> };
    for (const private_ of ["emailTo", "emailFrom", "telegramChatId", "ntfyServer", "alertsPausedUntil", "appPauses", "agentAccess", "checksKeptDays"]) assert.ok(!(private_ in settings), `${private_} is in the export`);
    assert.equal(settings.alertOutages, true);
    assert.ok("defaultCheckIntervalMin" in settings);
  });

  test("a file over the limit is refused before it is read", async () => {
    const call = await ready();
    const big = { setup: { periskopos: "0", apps: [], padding: "x".repeat(7 * 1024 * 1024) } };
    assert.equal((await call("POST", "/settings/import", big)).status, 413);
    assert.equal((await call("POST", "/settings/import/preview", big)).status, 413);
  });

  test("a file that isn't one is refused", async () => {
    const call = await ready();
    assert.equal((await call("POST", "/settings/import/preview", { setup: { hello: 1 } })).status, 400);
    assert.equal((await call("POST", "/settings/import", { setup: [] })).status, 400);
  });

  test("an app's pause: set, read and ended there, leaving other apps' alone", async () => {
    const call = await ready();
    const one = (await call("POST", "/apps", { name: "One", url: "https://one.example.org" })).body.app;
    const two = (await call("POST", "/apps", { name: "Two", url: "https://two.example.org" })).body.app;
    const until = inAnHour();
    assert.deepEqual((await call("GET", `/apps/${one.slug}/pause`)).body, {});
    assert.deepEqual((await call("POST", `/apps/${one.slug}/pause`, { until })).body, { app: until });
    await call("POST", `/apps/${two.slug}/pause`, { until });
    assert.deepEqual((await call("POST", `/apps/${one.slug}/pause`, { until: "" })).body, {});
    assert.deepEqual(Object.keys((await call("GET", "/settings")).body.settings.appPauses), [two.id]);
  });

  test("a pause has to be for a set time", async () => {
    const call = await ready();
    const { slug } = (await call("POST", "/apps", { name: "One", url: "https://one.example.org" })).body.app;
    for (const until of [undefined, "soon", 5, "2099-01-01T00:00:00Z", "2001-01-01T00:00:00Z"]) {
      assert.equal((await call("POST", `/apps/${slug}/pause`, { until })).status, 400, String(until));
    }
  });

  test("all alerts being paused shows on every app", async () => {
    const call = await ready();
    const { slug } = (await call("POST", "/apps", { name: "One", url: "https://one.example.org" })).body.app;
    const until = inAnHour();
    await call("PATCH", "/settings", { alertsPausedUntil: until });
    assert.deepEqual((await call("GET", `/apps/${slug}/pause`)).body, { all: until });
  });

  test("a deleted app's pause goes with it, so it can't block the next pause in Settings", async () => {
    const call = await ready();
    const gone = (await call("POST", "/apps", { name: "Gone", url: "https://gone.example.org" })).body.app;
    const kept = (await call("POST", "/apps", { name: "Kept", url: "https://kept.example.org" })).body.app;
    await call("POST", `/apps/${gone.slug}/pause`, { until: inAnHour() });
    await call("DELETE", `/apps/${gone.slug}`);
    const { settings } = (await call("GET", "/settings")).body;
    assert.deepEqual(settings.appPauses, {});
    assert.equal((await call("PATCH", "/settings", { appPauses: { ...settings.appPauses, [kept.id]: inAnHour() } })).status, 200);
  });
});
