import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, before, beforeEach, describe, test } from "node:test";
import type { App, AppStatus, GeneratedProtocol, ProtocolView } from "../shared/types.ts";
import { createApp } from "../server/app.ts";
import { Approvals } from "../server/agents/approvals.ts";
import { openDb } from "../server/db.ts";
import { generateProtocol, renderTemplate } from "../server/generator.ts";
import { cleanActions, cleanManifest, cleanMetrics, clearProtocolCache, protocolSecretRef, protocolView, validateEndpoint } from "../server/protocol.ts";
import { readSecret, writeSecret } from "../server/keys/secrets.ts";
import { StatusService } from "../server/status.ts";
import { updateSettings } from "../server/settings.ts";
import * as store from "../server/store.ts";
import { Watcher } from "../server/watcher.ts";
import { createHandler } from "../templates/supabase-edge/index.ts";
import { tempDir } from "./tmp.ts";

const realFetch = globalThis.fetch;
const SECRET = "s".repeat(43);

// Each test gets its own .env.local.
let envDir: string;
beforeEach(() => {
  envDir = tempDir("periskopos-env-");
  process.env.PERISKOPOS_ENV_FILE = path.join(envDir, ".env.local");
  clearProtocolCache();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.PERISKOPOS_ENV_FILE;
});

const req = (route: string, init: RequestInit & { secret?: string | null } = {}) => {
  const { secret = SECRET, ...rest } = init;
  return new Request(`https://abc.supabase.co/functions/v1/periskopos${route}`, {
    ...rest,
    headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(rest.headers as Record<string, string>) },
  });
};

// What the endpoint answers with: only the parts these tests look at.
type EndpointReply = {
  error?: string;
  protocol?: number;
  app?: { name: string; version?: string };
  capabilities?: string[];
  metrics?: { id: string; label: string; value: number }[];
  at?: string;
  actions?: { id: string; label: string; confirm?: boolean }[];
  ok?: boolean;
  message?: string;
};

// ── The template: the reference implementation of the protocol ─────────

describe("the endpoint template (protocol v1)", () => {
  const hooks = {
    secret: () => SECRET,
    name: "Star-Map",
    version: "1.4.0",
    capabilities: ["metrics", "actions", "x-reindex"],
    getMetrics: async () => [{ id: "users", label: "Accounts", value: 128 }],
    listActions: async () => [{ id: "purge-cache", label: "Purge cache", confirm: true }],
    runAction: async (id: string) => ({ ok: true, message: `Ran ${id}` }),
  };
  const handle = createHandler(hooks);
  const body = async (r: Response) => (await r.json()) as EndpointReply;

  test("fails closed when no secret is set, or it's too short to be one", async () => {
    for (const secret of [undefined, "", "short"]) {
      const r = await createHandler({ ...hooks, secret: () => secret })(req("/manifest"));
      assert.equal(r.status, 503);
      assert.match((await body(r)).error ?? "", /Not configured/);
    }
  });

  test("401 without the secret, with a wrong one, or with one that only starts right", async () => {
    for (const secret of [null, "x".repeat(43), SECRET.slice(0, 40), SECRET + "x"]) {
      assert.equal((await handle(req("/manifest", { secret }))).status, 401, String(secret));
    }
    assert.equal((await handle(req("/manifest", { secret: null, headers: { authorization: "Basic abc" } }))).status, 401);
  });

  test("manifest", async () => {
    const r = await handle(req("/manifest"));
    assert.equal(r.status, 200);
    assert.deepEqual(await body(r), { protocol: 1, app: { name: "Star-Map", version: "1.4.0" }, capabilities: ["metrics", "actions", "x-reindex"] });
    assert.equal(r.headers.get("access-control-allow-origin"), null, "no CORS: only Periskopos's server calls it");
  });

  test("metrics, actions, and pressing one", async () => {
    const m = await body(await handle(req("/metrics")));
    assert.deepEqual(m.metrics, [{ id: "users", label: "Accounts", value: 128 }]);
    assert.ok(Date.parse(m.at ?? "") > 0, "the answer says when it was made");
    assert.deepEqual((await body(await handle(req("/actions")))).actions, [{ id: "purge-cache", label: "Purge cache", confirm: true }]);
    assert.deepEqual(await body(await handle(req("/actions/purge-cache", { method: "POST" }))), { ok: true, message: "Ran purge-cache" });
  });

  test("an action the app doesn't list can't be run", async () => {
    const r = await handle(req("/actions/drop-everything", { method: "POST" }));
    assert.equal(r.status, 404);
  });

  test("works under any path prefix, since the function's own name is part of the path", async () => {
    for (const p of ["/manifest", "/periskopos/manifest", "/functions/v1/periskopos/manifest/"]) {
      const r = await handle(new Request(`https://x.co${p}`, { headers: { authorization: `Bearer ${SECRET}` } }));
      assert.equal(r.status, 200, p);
    }
  });

  test("a capability the app didn't choose isn't served; odd methods and routes are refused", async () => {
    const only = createHandler({ ...hooks, capabilities: ["metrics"] });
    assert.equal((await only(req("/metrics"))).status, 200);
    assert.equal((await only(req("/actions"))).status, 404);
    assert.equal((await only(req("/actions/purge-cache", { method: "POST" }))).status, 404);
    assert.equal((await handle(req("/manifest", { method: "DELETE" }))).status, 405);
    assert.equal((await handle(req("/nothing"))).status, 404);
  });

  test("an error inside a hook becomes a JSON error, not a crash", async () => {
    const broken = createHandler({ ...hooks, getMetrics: async () => { throw new Error("db unreachable"); } });
    const r = await broken(req("/metrics"));
    assert.equal(r.status, 500);
    assert.equal((await body(r)).error, "db unreachable");
  });
});

// ── The generator ──────────────────────────────────────────────────────

describe("the generator (FR-G1–G6)", () => {
  let db: DatabaseSync;
  let app: App;
  beforeEach(() => {
    db = openDb(":memory:");
    const user = store.createUser(db, "Me");
    app = store.createApp(db, user.id, { name: "Star-Map", url: "http://star-map.example" });
  });

  test("makes a 32-byte secret, saves it to .env.local, and shows it in the commands only", () => {
    const g = generateProtocol(app, { runtime: "supabase-edge", capabilities: ["metrics", "actions"] });
    assert.equal(g.secretRef, "PERISKOPOS_PROTOCOL_STAR_MAP");
    assert.equal(Buffer.from(g.secret, "base64url").length, 32);
    assert.equal(readSecret(g.secretRef), g.secret);
    assert.equal(g.files.length, 1);
    assert.equal(g.files[0].path, "supabase/functions/periskopos/index.ts");
    assert.equal(g.files[0].content.includes(g.secret), false, "the secret is never inside the code");
    assert.equal(g.commands.length, 2);
    assert.match(g.commands[0], new RegExp(`^supabase secrets set PERISKOPOS_SECRET=${g.secret} --project-ref <project-ref>$`));
    assert.match(g.commands[1], /^supabase functions deploy periskopos --no-verify-jwt --project-ref/);
  });

  test("knows the project from the app's Supabase connection", () => {
    store.addConnection(db, app, { type: "supabase", serviceId: "s_x", resource: "abcdefghijklmnopqrst" });
    const g = generateProtocol(store.getApp(db, app.ownerId, app.slug)!, { capabilities: ["metrics"] });
    assert.equal(g.endpointHint, "https://abcdefghijklmnopqrst.supabase.co/functions/v1/periskopos");
    assert.match(g.commands[1], /--project-ref abcdefghijklmnopqrst$/);
  });

  test("only the chosen capabilities go in the manifest", async () => {
    const mod = await load(generateProtocol(app, { capabilities: ["actions"] }));
    const r = await mod.createHandler({ secret: () => SECRET })(req("/manifest"));
    assert.deepEqual(((await r.json()) as EndpointReply).capabilities, ["actions"]);
  });

  test("generating again rotates the secret and leaves the rest of .env.local alone", () => {
    writeFileSync(process.env.PERISKOPOS_ENV_FILE!, "# my keys\nRENDER_API_KEY=abc\nPERISKOPOS_PROTOCOL_STAR_MAP=old\nOTHER=1\n");
    const g = generateProtocol(app, { capabilities: ["metrics"] });
    assert.equal(readFileSync(process.env.PERISKOPOS_ENV_FILE!, "utf8"), `# my keys\nRENDER_API_KEY=abc\nPERISKOPOS_PROTOCOL_STAR_MAP=${g.secret}\nOTHER=1\n`);
    assert.notEqual(generateProtocol(app, { capabilities: ["metrics"] }).secret, g.secret);
  });

  test("rejects an unknown runtime and an empty choice", () => {
    assert.throws(() => generateProtocol(app, { runtime: "perl-cgi", capabilities: ["metrics"] }), /Unknown runtime/);
    assert.throws(() => generateProtocol(app, { capabilities: [] }), /at least one/);
    assert.throws(() => generateProtocol(app, { capabilities: ["telepathy"] }), /at least one/);
  });

  test("a name every object inherits isn't a runtime, and the app's secret is left alone", () => {
    writeSecret("PERISKOPOS_PROTOCOL_STAR_MAP", SECRET);
    for (const runtime of ["toString", "constructor", "__proto__"]) {
      assert.throws(() => generateProtocol(app, { runtime, capabilities: ["metrics"] }), /Unknown runtime/, runtime);
    }
    assert.equal(readSecret("PERISKOPOS_PROTOCOL_STAR_MAP"), SECRET);
  });

  test("an app name can't break out of the generated code", async () => {
    const nasty = 'Evil "name"; Deno.exit(1)\nconsole.log("pwned") /* */ ${process.exit(1)} </script> __CAPABILITIES__ \\';
    const code = renderTemplate("supabase-edge", { appName: nasty, capabilities: ["metrics"] });
    const first = code.split("\n")[0];
    assert.ok(first.startsWith("//") && !first.includes("\n"));
    const mod = await load({ files: [{ path: "i.ts", content: code }] });
    const r = await mod.createHandler({ secret: () => SECRET })(req("/manifest"));
    assert.equal(((await r.json()) as EndpointReply).app?.name, nasty, "the name arrives exactly as written");
    assert.ok(!code.split("\n").slice(1).some((l) => l.startsWith("console.log(\"pwned\")")));
  });

  test("the secret reference is a valid variable name for any slug", () => {
    for (const slug of ["a", "star-map", "9lives", "my--app-2"]) assert.match(protocolSecretRef(slug), /^[A-Z][A-Z0-9_]{1,63}$/);
  });
});

let loaded = 0;
// Loads generated code as a real module.
async function load(g: Pick<GeneratedProtocol, "files">) {
  const file = path.join(tempDir("periskopos-gen-"), `endpoint${loaded++}.ts`);
  writeFileSync(file, g.files[0].content);
  return (await import(pathToFileURL(file).href)) as typeof import("../templates/supabase-edge/index.ts");
}

// ── The client, against the template: both ends of the contract ────────

describe("the protocol client", () => {
  let calls: { url: string; method: string; auth?: string }[];
  const metrics = async () => [
    { id: "users", label: "Accounts", value: 128 },
    { id: "saved", label: "Saved indexes", value: 341, hint: "all time" },
    { id: "conv", label: "Conversion", value: "4.2%" },
    { id: "extra", label: "Fourth", value: 4 },
  ];
  let handle = createHandler({ secret: () => SECRET });

  const asApp = (endpoint = "https://abc.supabase.co/functions/v1/periskopos"): App =>
    ({ id: "a_1", slug: "star-map", name: "Star-Map", protocol: { endpoint, secretRef: "PERISKOPOS_PROTOCOL_STAR_MAP" } }) as App;

  beforeEach(() => {
    calls = [];
    writeSecret("PERISKOPOS_PROTOCOL_STAR_MAP", SECRET);
    handle = createHandler({
      secret: () => SECRET,
      name: "Star-Map",
      capabilities: ["metrics", "actions"],
      getMetrics: metrics,
      listActions: async () => [{ id: "purge-cache", label: "Purge cache", description: "Refetch files", confirm: true, danger: false }],
    });
    // The endpoint is served by the real template; everything else is real.
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const r = new Request(String(input), init);
      calls.push({ url: r.url, method: r.method, auth: r.headers.get("authorization") ?? undefined });
      return handle(r);
    }) as typeof fetch;
  });

  test("reads the manifest, metrics and actions", async () => {
    const v = await protocolView(asApp());
    assert.equal(v.error, undefined);
    assert.equal(v.secretState, "set");
    assert.equal(v.manifest?.app.name, "Star-Map");
    assert.deepEqual(v.manifest?.capabilities, ["metrics", "actions"]);
    assert.equal(v.metrics?.items.length, 4);
    assert.deepEqual(v.metrics?.items[1], { id: "saved", label: "Saved indexes", value: 341, hint: "all time" });
    assert.deepEqual(v.actions, [{ id: "purge-cache", label: "Purge cache", description: "Refetch files", confirm: true, danger: false }]);
    assert.ok(calls.every((c) => c.auth === `Bearer ${SECRET}`));
  });

  test("answers are cached for a moment", async () => {
    await protocolView(asApp());
    const n = calls.length;
    await protocolView(asApp());
    assert.equal(calls.length, n);
  });

  test("a failure seen by the Fleet's short wait isn't cached for a caller who'd wait longer", async () => {
    const working = handle;
    handle = async () => new Response("{}", { status: 503 }); // a cold endpoint
    assert.ok((await protocolView(asApp(), { timeoutMs: 6_000 })).error);
    handle = working;
    const v = await protocolView(asApp());
    assert.equal(v.error, undefined, "asked again rather than served the Fleet's failure");
    assert.equal(v.actions?.length, 1);
    // A good answer from the short wait is fine for everyone.
    const n = calls.length;
    clearProtocolCache();
    await protocolView(asApp(), { timeoutMs: 6_000 });
    await protocolView(asApp());
    assert.equal(calls.length, n + 3, "one round of manifest, metrics and actions");
  });

  test("an answer over the size limit is refused, declared or not", async () => {
    const big = "x".repeat(300 * 1024);
    handle = async () => new Response(JSON.stringify({ protocol: 1, app: { name: big } }), { headers: { "content-length": String(big.length + 40) } });
    assert.match((await protocolView(asApp())).error ?? "", /too large/);

    // No length given: reading stops once it passes the limit.
    let pulled = 0;
    handle = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 1000) controller.close();
            else controller.enqueue(new Uint8Array(64 * 1024).fill(32));
          },
        }),
      );
    clearProtocolCache();
    assert.match((await protocolView(asApp())).error ?? "", /too large/);
    assert.ok(pulled < 10, `stopped after ${pulled} chunks`);
  });

  test("a wrong secret says what to do", async () => {
    handle = createHandler({ secret: () => "z".repeat(43) });
    const v = await protocolView(asApp());
    assert.match(v.error!, /rejected the secret \(401\).*Redeploy/);
  });

  test("a missing secret says where to put it, and nothing is called", async () => {
    writeFileSync(process.env.PERISKOPOS_ENV_FILE!, "");
    const v = await protocolView(asApp());
    assert.equal(v.secretState, "missing");
    assert.match(v.error!, /Add PERISKOPOS_PROTOCOL_STAR_MAP=/);
    assert.equal(calls.length, 0);
  });

  test("a redirect is never followed, so the secret can't be sent elsewhere", async () => {
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method ?? "GET" });
      assert.equal(init?.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    }) as typeof fetch;
    const v = await protocolView(asApp());
    assert.match(v.error!, /redirected to https:\/\/evil\.example\/steal.*never sent along a redirect/);
    assert.equal(calls.length, 1);
  });

  test("an endpoint that isn't one: HTML, wrong path, older or newer protocol", async () => {
    globalThis.fetch = (async () => new Response("<html>hi</html>", { status: 200 })) as typeof fetch;
    assert.match((await protocolView(asApp())).error!, /didn't answer with JSON/);
    clearProtocolCache();
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    assert.match((await protocolView(asApp())).error!, /Nothing is served at \/manifest \(404\)/);
    clearProtocolCache();
    globalThis.fetch = (async () => Response.json({ protocol: 2, app: { name: "X" }, capabilities: [] })) as typeof fetch;
    assert.match((await protocolView(asApp())).error!, /speaks protocol 2; this Periskopos supports 1/);
    clearProtocolCache();
    globalThis.fetch = (async () => Response.json({ hello: "world" })) as typeof fetch;
    assert.match((await protocolView(asApp())).error!, /doesn't look like a Periskopos endpoint/);
  });

  test("one capability failing leaves the others (FR-P5)", async () => {
    handle = createHandler({ secret: () => SECRET, capabilities: ["metrics", "actions"], getMetrics: async () => { throw new Error("db down"); }, listActions: async () => [{ id: "a", label: "A" }] });
    const v = await protocolView(asApp());
    assert.equal(v.error, undefined);
    assert.deepEqual(v.problems, ["metrics: db down"]);
    assert.equal(v.actions?.length, 1);
    assert.equal(v.metrics, undefined);
  });

  test("an unknown capability is ignored; an x- one is shown as plain JSON (FR-P4)", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const p = new URL(String(input)).pathname;
      if (p.endsWith("/manifest")) return Response.json({ protocol: 1, app: { name: "X" }, capabilities: ["telepathy", "x-reindex"] });
      if (p.endsWith("/x-reindex")) return Response.json({ lastRun: "yesterday", docs: 12 });
      return new Response("", { status: 404 });
    }) as typeof fetch;
    const v = await protocolView(asApp());
    assert.equal(v.error, undefined);
    assert.deepEqual(v.extras, [{ name: "x-reindex", json: JSON.stringify({ lastRun: "yesterday", docs: 12 }, null, 2) }]);
  });

  test("an app with no endpoint isn't called", async () => {
    const v = await protocolView({ ...asApp(), protocol: undefined });
    assert.equal(v.configured, false);
    assert.equal(calls.length, 0);
  });
});

describe("validating what an endpoint says", () => {
  test("endpoints: https only, except loopback; no passwords; query and fragment dropped", () => {
    assert.equal(validateEndpoint("https://abc.supabase.co/functions/v1/periskopos/"), "https://abc.supabase.co/functions/v1/periskopos");
    assert.equal(validateEndpoint("http://127.0.0.1:8000/x?y=1#z"), "http://127.0.0.1:8000/x");
    assert.equal(validateEndpoint("http://localhost:8000"), "http://localhost:8000");
    for (const bad of ["http://abc.example/x", "ftp://x.example", "https://u:p@x.example", "not a url", "", undefined, 5]) {
      assert.throws(() => validateEndpoint(bad), Error, String(bad));
    }
  });

  test("metrics: bad entries are skipped, the rest kept, at most twelve", () => {
    const junk = [{ id: "ok", label: "OK", value: 1 }, { id: "", label: "x", value: 1 }, { id: "nan", label: "NaN", value: NaN }, { id: "obj", label: "Obj", value: { a: 1 } }, { id: "long", label: "L", value: "x".repeat(101) }, null, "str"];
    assert.deepEqual(cleanMetrics({ metrics: junk }).items, [{ id: "ok", label: "OK", value: 1 }]);
    assert.equal(cleanMetrics({ metrics: Array.from({ length: 30 }, (_, i) => ({ id: `m${i}`, label: `M${i}`, value: i })) }).items.length, 12);
    assert.throws(() => cleanMetrics({}));
  });

  test("actions: ids must be simple; confirm defaults to on", () => {
    assert.deepEqual(cleanActions({ actions: [{ id: "purge-cache", label: "Purge" }, { id: "bad id!", label: "X" }, { id: "../x", label: "Y" }, { id: "a_1", label: "A", confirm: false, danger: true }] }), [
      { id: "purge-cache", label: "Purge", confirm: true, danger: false },
      { id: "a_1", label: "A", confirm: false, danger: true },
    ]);
  });

  test("manifest: needs a version and a name", () => {
    assert.throws(() => cleanManifest({ app: { name: "X" } }));
    assert.throws(() => cleanManifest({ protocol: 1, app: {} }));
    assert.deepEqual(cleanManifest({ protocol: 1, app: { name: "X", version: "1.0" }, capabilities: ["metrics", "metrics", 5] }), { protocol: 1, app: { name: "X", version: "1.0" }, capabilities: ["metrics"] });
  });
});

// ── Through Periskopos's own API ───────────────────────────────────

describe("API: Add protocol, Test connection, metrics, actions", () => {
  const TOKEN = "t".repeat(43);
  const AGENT = "a".repeat(43);
  const BASE = "http://localhost:4100";
  let gc: ReturnType<typeof createApp>;
  let handle: ReturnType<typeof createHandler>;
  let ran: string[];
  let secretInUse: string;

  const api = async (method: string, p: string, body?: unknown, token = TOKEN) => {
    const res = await gc.request(`${BASE}/api${p}`, { method, headers: { "x-periskopos-token": token, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: res.status === 204 ? undefined : await res.json(), text: "" };
  };

  beforeEach(() => {
    ran = [];
    const db = openDb(":memory:");
    updateSettings(db, store.createUser(db, "Me").id, { agentAccess: true }); // Claude is let in (off by default)
    const dist = tempDir("periskopos-web-");
    writeFileSync(path.join(dist, "index.html"), "");
    // An agent's requests are approved at once here; approval has its own tests (mcp.test.ts).
    const approvals = new Approvals();
    approvals.onRequest((a) => approvals.decide(a.id, true));
    gc = createApp({ db, token: TOKEN, agentToken: AGENT, approvals, port: 4100, distDir: dist, watcher: new Watcher({ db, notifier: { notify: async () => {} }, baseUrl: BASE, status: new StatusService(0), isOnline: async () => true, fetchProvider: async () => ({ indicator: "none", description: "ok", incidents: [] }) }) });
    handle = createHandler({
      secret: () => secretInUse,
      name: "Mine",
      capabilities: ["metrics", "actions"],
      getMetrics: async () => [{ id: "users", label: "Accounts", value: 128 }, { id: "saved", label: "Saved", value: 341 }],
      listActions: async () => [{ id: "purge-cache", label: "Purge cache" }, { id: "reset-demo", label: "Reset demo data", danger: true }],
      runAction: async (id) => (ran.push(id), { ok: true, message: "Purged 12 files." }),
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => handle(new Request(String(input), init))) as typeof fetch;
  });

  async function setUp() {
    await api("POST", "/setup", { name: "Me" });
    await api("POST", "/apps", { name: "Mine", url: "http://mine.example" });
    const g = (await api("POST", "/apps/mine/protocol/generate", { runtime: "supabase-edge", capabilities: ["metrics", "actions"] })).body.generated as GeneratedProtocol;
    secretInUse = g.secret; // "deploying" the endpoint with the new secret
    return g;
  }

  test("generate → test connection saves the endpoint; the secret is shown once and never read back", async () => {
    const g = await setUp();
    assert.equal(g.secret.length, 43);
    // Not configured until the endpoint answers.
    assert.equal(((await api("GET", "/apps/mine")).body.app as App).protocol, undefined);

    const wrong = await api("POST", "/apps/mine/protocol/test", { endpoint: "http://abc.example/x" });
    assert.equal(wrong.body.ok, false);
    assert.match(wrong.body.message, /must use https/);

    const ok = await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.manifest.app.name, "Mine");
    const app = (await api("GET", "/apps/mine")).body.app as App;
    assert.deepEqual(app.protocol, { endpoint: "https://abc.supabase.co/functions/v1/periskopos", secretRef: "PERISKOPOS_PROTOCOL_MINE" });

    // The secret value appears in no later answer.
    for (const p of ["/apps/mine", "/apps/mine/protocol", "/apps", "/status", "/apps/mine/actions"]) {
      assert.equal(JSON.stringify((await api("GET", p)).body).includes(g.secret), false, p);
    }
    assert.equal((await api("GET", "/apps/mine/protocol")).body.protocol.secretState, "set");
  });

  test("test connection with a wrong secret fails and saves nothing", async () => {
    await setUp();
    secretInUse = "q".repeat(43);
    const r = await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    assert.equal(r.body.ok, false);
    assert.match(r.body.message, /rejected the secret/);
    assert.equal(((await api("GET", "/apps/mine")).body.app as App).protocol, undefined);
  });

  test("testing before generating says to generate first", async () => {
    await api("POST", "/setup", { name: "Me" });
    await api("POST", "/apps", { name: "Mine", url: "http://mine.example" });
    const r = await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/x" });
    assert.match(r.body.message, /Generate one first/);
  });

  test("metrics reach the status (first three) and the protocol view", async () => {
    await setUp();
    await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    const { statuses } = (await api("GET", "/status")).body as { statuses: AppStatus[] };
    assert.deepEqual(statuses[0].metrics?.map((m) => `${m.label} ${m.value}`), ["Accounts 128", "Saved 341"]);
    const v = (await api("GET", "/apps/mine/protocol")).body.protocol as ProtocolView;
    assert.equal(v.metrics?.items.length, 2);
  });

  test("the app's own actions join the actions API, are confirmed, and are logged", async () => {
    await setUp();
    await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    const listed = (await api("GET", "/apps/mine/actions")).body;
    assert.deepEqual(listed.actions.map((a: { id: string; service: string }) => [a.id, a.service]), [["proto:purge-cache", "Mine itself"], ["proto:reset-demo", "Mine itself"]]);

    assert.equal((await api("POST", "/apps/mine/actions/proto:purge-cache", {})).status, 400, "needs confirmed");
    assert.deepEqual(ran, []);
    const r = await api("POST", "/apps/mine/actions/proto:purge-cache", { confirmed: true }, AGENT);
    assert.deepEqual(r.body, { ok: true, message: "Purged 12 files.", label: "Purge cache" });
    assert.deepEqual(ran, ["purge-cache"]);
    const log = (await api("GET", "/apps/mine/activity")).body.activity[0];
    assert.deepEqual([log.actionId, log.source, log.ok], ["proto:purge-cache", "mcp", true]);
    assert.equal((await api("POST", "/apps/mine/actions/proto:nope", { confirmed: true })).status, 404);
  });

  test("a dangerous action needs the app's name typed, and Claude can't run it at all (FR-X2)", async () => {
    await setUp();
    await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    const listed = (await api("GET", "/apps/mine/actions")).body.actions as { id: string; danger: boolean }[];
    assert.deepEqual(listed.map((a) => [a.id, a.danger]), [["proto:purge-cache", false], ["proto:reset-demo", true]]);

    const run = (extra: Record<string, unknown>, token = TOKEN) => api("POST", "/apps/mine/actions/proto:reset-demo", { confirmed: true, ...extra }, token);
    // On screen: the name must be typed.
    const none = await run({});
    assert.equal(none.status, 400);
    assert.match(none.body.error, /Type the app's name \(Mine\)/);
    assert.equal((await run({ confirmName: "Not mine" })).status, 400);
    assert.deepEqual(ran, [], "nothing ran yet");
    assert.equal((await run({ confirmName: "  mine " })).status, 200, "case and spaces don't matter");
    assert.deepEqual(ran, ["reset-demo"]);

    // Claude: refused, even with the right name, and even claiming to be the screen.
    for (const extra of [{ confirmName: "Mine" }, { source: "ui", confirmName: "Mine" }]) {
      const claude = await run(extra, AGENT);
      assert.equal(claude.status, 403);
      assert.match(claude.body.error, /only be run on screen/);
    }
    assert.deepEqual(ran, ["reset-demo"], "the endpoint wasn't called again");

    // A harmless action needs no name.
    assert.equal((await api("POST", "/apps/mine/actions/proto:purge-cache", { confirmed: true }, AGENT)).status, 200);
  });

  test("an unreachable endpoint is reported where its actions would be", async () => {
    await setUp();
    await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    secretInUse = "r".repeat(43);
    clearProtocolCache();
    const listed = (await api("GET", "/apps/mine/actions")).body;
    assert.deepEqual(listed.actions, []);
    assert.match(listed.blocked[0].reason, /rejected the secret/);
  });

  test("removing the protocol keeps the app, and the secret stays in .env.local", async () => {
    const g = await setUp();
    await api("POST", "/apps/mine/protocol/test", { endpoint: "https://abc.supabase.co/functions/v1/periskopos" });
    assert.equal((await api("DELETE", "/apps/mine/protocol")).status, 204);
    assert.equal(((await api("GET", "/apps/mine")).body.app as App).protocol, undefined);
    assert.equal(readSecret("PERISKOPOS_PROTOCOL_MINE"), g.secret);
  });
});

// ── The same file, in the real runtime ─────────────────────────────────

describe("the generated endpoint under Deno (the Edge Function runtime)", () => {
  const deno = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1")), "..", "node_modules", "deno", process.platform === "win32" ? "deno.exe" : "deno");
  let free = false;
  before(async () => {
    free = await new Promise<boolean>((resolve) => {
      const s = net.createServer().once("error", () => resolve(false)).once("listening", () => s.close(() => resolve(true)));
      s.listen(8000, "127.0.0.1");
    });
  });

  test("the template, and the worked example in the docs (test/fixtures/supabase-get-metrics.ts.txt), type-check against the real supabase-js", { skip: !existsSync(deno) && "Deno isn't installed (npm install)", timeout: 240_000 }, async () => {
    const snippet = readFileSync(path.join(path.dirname(deno), "..", "..", "test", "fixtures", "supabase-get-metrics.ts.txt"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(snippet.includes("export async function getMetrics()"), "the worked example has its getMetrics()");

    const template = renderTemplate("supabase-edge", { appName: "Star-Map", capabilities: ["metrics"] });
    const start = template.indexOf("export async function getMetrics()");
    const end = template.indexOf("// FILL IN: the buttons");
    assert.ok(start > 0 && end > start, "the template still has its getMetrics section");
    const starMap = template.slice(0, start) + snippet + "\n" + template.slice(end);

    // A folder with no package.json, as the Edge runtime sees it.
    const dir = tempDir("periskopos-denocheck-");
    for (const [name, code] of [["template.ts", template], ["star-map.ts", starMap]]) {
      writeFileSync(path.join(dir, name), code);
      const out = await new Promise<{ code: number | null; text: string }>((resolve) => {
        const child = spawn(deno, ["check", name], { cwd: dir, env: { ...process.env, NO_COLOR: "1" }, stdio: "pipe" });
        let text = "";
        child.stderr.on("data", (d) => (text += d));
        child.stdout.on("data", (d) => (text += d));
        child.on("close", (code) => resolve({ code, text }));
      });
      assert.equal(out.code, 0, `${name}: ${out.text}`);
    }
  });

  test("Periskopos's client reads a real generated endpoint over real HTTP", { skip: !existsSync(deno) && "Deno isn't installed (npm install)" }, async (t) => {
    if (!free) return t.skip("port 8000 is in use");
    // Generate exactly what the user would get, and run that file.
    const db = openDb(":memory:");
    const app = store.createApp(db, store.createUser(db, "Me").id, { name: "Real Deno", url: "http://real.example" });
    const g = generateProtocol(app, { capabilities: ["metrics", "actions"] });
    const file = path.join(tempDir("periskopos-deno-"), "index.ts");
    writeFileSync(file, g.files[0].content);

    // Deno resolves the template's npm:@supabase/supabase-js import up front, so
    // the first run downloads it (cached afterwards): wait generously.
    const child = spawn(deno, ["run", "--allow-net=0.0.0.0:8000", "--allow-env", file], { env: { ...process.env, PERISKOPOS_SECRET: g.secret, APP_VERSION: "9.9.9", NO_COLOR: "1" }, stdio: "pipe" });
    let out = "";
    child.stderr.on("data", (d) => (out += d));
    child.stdout.on("data", (d) => (out += d));
    try {
      for (let i = 0; i < 600 && !/Listening on/i.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
      assert.match(out, /Listening on/i, out);

      const view = await protocolView({ id: "a_deno", slug: app.slug, name: app.name, protocol: { endpoint: "http://127.0.0.1:8000", secretRef: g.secretRef } } as App);
      assert.equal(view.error, undefined, view.error);
      assert.deepEqual(view.manifest, { protocol: 1, app: { name: "Real Deno", version: "9.9.9" }, capabilities: ["metrics", "actions"] });
      assert.deepEqual(view.metrics?.items, [], "the unfilled template reports nothing, and says so cleanly");
      assert.deepEqual(view.actions, []);

      const noAuth = await realFetch("http://127.0.0.1:8000/manifest");
      assert.equal(noAuth.status, 401);
    } finally {
      child.kill();
    }
  });
});
