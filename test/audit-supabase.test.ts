import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { App, AuditResult, Connection } from "../shared/types.ts";
import { clearHttpCache } from "../server/http.ts";
import { supabase, type Lint } from "../server/integrations/supabase.ts";
import type { ServiceAuth } from "../server/integrations/types.ts";

// Supabase's security advisors as configuration findings. Everything here is
// a fake; nothing reaches the network, and nothing but GET is ever sent.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;
type Seen = { method: string; url: URL };
let seen: Seen[];
let answer: (s: Seen) => Response;
beforeEach(() => {
  clearHttpCache();
  seen = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const s: Seen = { method: init?.method ?? "GET", url: new URL(String(input instanceof Request ? input.url : input)) };
    seen.push(s);
    return answer(s);
  }) as typeof fetch;
});
afterEach(() => {
  assert.ok(seen.every((s) => s.method === "GET"), "only GET");
  globalThis.fetch = realFetch;
});

const REF = "abcdefghijklmnopqrst";
const auth = { service: { id: "s", ownerId: "u", type: "supabase", name: "Supabase", canWrite: false }, token: async () => "test-token" } as ServiceAuth;
const conn: Connection = { id: "c", appId: "a", type: "supabase", serviceId: "s", resource: REF, settings: { name: "shop" } };
const app: App = { id: "a", slug: "shop", ownerId: "u", name: "Shop", url: "https://shop.example", live: true, checkIntervalMin: 5, connections: [] };
const keys = (r: AuditResult) => r.findings.map((f) => `${f.key}/${f.severity}`).sort();

const lint = (name: string, level: Lint["level"], metadata: Lint["metadata"], extra: Partial<Lint> = {}): Lint => ({
  name,
  title: `Title of ${name}`,
  level,
  categories: ["SECURITY"],
  description: `Description of ${name}.`,
  detail: `Detail of ${name}`,
  remediation: `https://supabase.com/docs/guides/database/database-linter?lint=00xx_${name}`,
  metadata,
  cache_key: `${name}_${metadata?.schema ?? ""}_${metadata?.name ?? ""}`,
  ...extra,
});

// Answers the project list and the advisors; `status` and `advisors` change per test.
function serve(status: string, advisors: () => Response) {
  answer = (s) => {
    if (s.url.pathname === "/v1/projects") return json([{ id: REF, ref: REF, name: "shop", status }]);
    if (s.url.pathname === `/v1/projects/${REF}/advisors/security`) return advisors();
    return json({ message: "not found" }, 404);
  };
}

describe("Supabase audit", () => {
  test("an overloaded function is one finding for its name: the first overload's", async () => {
    serve("ACTIVE_HEALTHY", () =>
      json({
        lints: [
          lint("some_future_lint", "WARN", { schema: "public", name: "add_item", type: "function" }, { detail: "First overload" }),
          lint("some_future_lint", "ERROR", { schema: "public", name: "add_item", type: "function" }, { detail: "Second overload", cache_key: "other_overload" }),
        ],
      }),
    );
    const r = await supabase.audit!(conn, auth, app);
    assert.deepEqual(keys(r), ["some_future_lint:public.add_item/medium"]);
    assert.match(r.findings[0]!.fix.steps, /^First overload/);
  });

  test("each lint becomes a finding: severity from its level, SQL where it's obvious", async () => {
    serve("ACTIVE_HEALTHY", () =>
      json({
        lints: [
          lint("rls_disabled_in_public", "ERROR", { schema: "public", name: "orders", type: "table" }),
          lint("policy_exists_rls_disabled", "ERROR", { schema: "public", name: "Line Items", type: "table" }),
          lint("security_definer_view", "ERROR", { schema: "public", name: "order_totals", type: "view" }),
          lint("function_search_path_mutable", "WARN", { schema: "public", name: "add_item", type: "function" }),
          lint("function_search_path_mutable", "WARN", { schema: "public", name: "add_item", type: "function" }, { cache_key: "other_overload" }),
          lint("auth_leaked_password_protection", "WARN", { entity: "Auth", type: "auth" }),
          lint("rls_enabled_no_policy", "INFO", { schema: "public", name: "audit_log", type: "table" }),
          lint("some_future_lint", "WARN", { schema: "public", name: "thing", type: "table" }),
        ],
      }),
    );
    const r = await supabase.audit!(conn, auth, app);
    assert.deepEqual(keys(r), [
      "auth_leaked_password_protection:Auth/medium",
      "function_search_path_mutable:public.add_item/medium",
      "policy_exists_rls_disabled:public.Line Items/high",
      "rls_disabled_in_public:public.orders/high",
      "rls_enabled_no_policy:public.audit_log/low",
      "security_definer_view:public.order_totals/high",
      "some_future_lint:public.thing/medium",
    ]);
    assert.deepEqual(r.notes, []);
    const by = (k: string) => r.findings.find((f) => f.key.startsWith(k))!;

    const rls = by("rls_disabled_in_public");
    assert.equal(rls.title, "Row Level Security is off on public.orders: anyone with your anon key can read and change every row");
    assert.match(rls.fix.code!, /^alter table public\.orders enable row level security;/);
    assert.match(rls.fix.code!, /create policy/);
    assert.equal(rls.fix.link?.url, "https://supabase.com/docs/guides/database/database-linter?lint=00xx_rls_disabled_in_public");

    assert.equal(by("policy_exists_rls_disabled").fix.code, 'alter table public."Line Items" enable row level security;');
    assert.equal(by("security_definer_view").fix.code, "alter view public.order_totals set (security_invoker = on);");
    assert.equal(by("function_search_path_mutable").fix.code, "alter function public.add_item set search_path = '';");
    assert.equal(by("auth_leaked_password_protection").fix.link?.url, `https://supabase.com/dashboard/project/${REF}/auth/providers?provider=Email`);

    // A lint without plain words of its own keeps Supabase's.
    const other = by("some_future_lint");
    assert.equal(other.title, "Title of some_future_lint: public.thing");
    assert.equal(other.why, "Description of some_future_lint.");
    assert.match(other.fix.steps, /^Detail of some_future_lint\. Supabase's guide/);
  });

  test("a guide link that isn't Supabase's is replaced by the Security Advisor", async () => {
    serve("ACTIVE_HEALTHY", () => json({ lints: [lint("some_future_lint", "WARN", { schema: "public", name: "thing", type: "table" }, { remediation: "https://evil.example/fix" })] }));
    const r = await supabase.audit!(conn, auth, app);
    assert.equal(r.findings[0]!.fix.link?.url, `https://supabase.com/dashboard/project/${REF}/advisors/security`);
  });

  test("a clean project finds nothing; health lints and unavailable checks aren't findings", async () => {
    serve("ACTIVE_HEALTHY", () =>
      json({
        lints: [
          lint("instance_db_down", "ERROR", {}, { categories: ["HEALTH"] }),
          lint("advisor_check_unavailable", "INFO", {}, { detail: "Some checks couldn't run." }),
        ],
      }),
    );
    const r = await supabase.audit!(conn, auth, app);
    assert.deepEqual(r.findings, []);
    assert.deepEqual(r.notes, ["Some checks couldn't run."]);

    clearHttpCache();
    serve("ACTIVE_HEALTHY", () => json({ lints: [] }));
    assert.deepEqual(await supabase.audit!(conn, auth, app), { findings: [], notes: [] });
  });

  test("a paused project isn't checked: a throw, so earlier findings stay", async () => {
    serve("INACTIVE", () => assert.fail("advisors asked of a paused project"));
    await assert.rejects(supabase.audit!(conn, auth, app), /paused/);
  });

  test("a token without the advisors permission is a note", async () => {
    serve("ACTIVE_HEALTHY", () => json({ message: "forbidden" }, 403));
    const r = await supabase.audit!(conn, auth, app);
    assert.deepEqual(r.findings, []);
    assert.match(r.notes![0]!, /advisors_read/);
  });

  test("an unreachable API throws", async () => {
    serve("ACTIVE_HEALTHY", () => json({ message: "boom" }, 502));
    await assert.rejects(supabase.audit!(conn, auth, app), /HTTP 502/);
  });

  test("keys are the same from one run to the next", async () => {
    const lints = [lint("rls_disabled_in_public", "ERROR", { schema: "public", name: "orders", type: "table" }), lint("auth_otp_long_expiry", "WARN", { entity: "Auth", type: "auth" })];
    serve("ACTIVE_HEALTHY", () => json({ lints }));
    const a = keys(await supabase.audit!(conn, auth, app));
    clearHttpCache();
    serve("ACTIVE_HEALTHY", () => json({ lints: [...lints].reverse() }));
    assert.deepEqual(keys(await supabase.audit!(conn, auth, app)), a);
  });
});
