import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAccess, AgentAuditEntry, AgentGrant, AgentRule, AgentView } from "../../shared/types.ts";
import * as store from "../store.ts";

// AI assistants, one each (docs/AGENT-SAFETY.md, phase 2). Each has its own
// token, which only its hash is kept of; what it may see (all apps, or some)
// and do (read, or also ask for actions); a rule per action (ask, allow
// without asking, never); grants that let one action run without asking for
// a while; and every request it makes, in an audit log.
//
// The `token` file in the data folder, which the MCP server reads by itself
// when it isn't given a token, is an assistant too: "This PC", with every app
// and the right to ask until you change that. It's how most people connect.

export type AgentCtx = {
  id: string;
  name: string;
  legacy: boolean;
  apps: "all" | Set<string>; // app ids
  access: AgentAccess;
  rules: Record<string, AgentRule>; // `${appId}:${actionId}`
  grants: AgentGrant[];
};

type Row = {
  id: string;
  name: string;
  token_hash: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
  apps: string;
  access: string;
  rules: string;
  grants: string;
  legacy: number;
};

export const AUDIT_KEEP_DAYS = 90;
export const GRANT_MINUTES = [15, 60, 240] as const;
export const LEGACY_NAME = "This PC";

const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const LAST_USED_EVERY_MS = 60_000;
export const newAgentToken = () => `gca_${randomBytes(32).toString("base64url")}`;
export const ruleKey = (appId: string, actionId: string) => `${appId}:${actionId}`;

const parse = <T>(text: string, fallback: T): T => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const activeGrants = (grants: AgentGrant[], now = Date.now()) => grants.filter((g) => Date.parse(g.until) > now);

function ctxOf(r: Row): AgentCtx {
  const apps = parse<"all" | string[]>(r.apps, "all");
  return {
    id: r.id,
    name: r.name,
    legacy: r.legacy === 1,
    apps: apps === "all" ? "all" : new Set(apps),
    access: r.access === "read" ? "read" : "ask",
    rules: parse<Record<string, AgentRule>>(r.rules, {}),
    grants: activeGrants(parse<AgentGrant[]>(r.grants, [])),
  };
}

function viewOf(r: Row): AgentView {
  const c = ctxOf(r);
  return {
    id: r.id,
    name: r.name,
    legacy: c.legacy,
    createdAt: r.created_at,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
    apps: c.apps === "all" ? "all" : [...c.apps],
    access: c.access,
    rules: c.rules,
    grants: c.grants,
  };
}

// The assistant a token belongs to, if it's a live one; the shared token
// becomes one the first time it's used. Marks when it was last used.
export function agentForToken(db: DatabaseSync, token: string, legacyToken?: string): AgentCtx | undefined {
  const h = hash(token);
  let row = db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(h) as Row | undefined;
  // Compared as hashes of equal length, in constant time.
  if (!row && legacyToken && timingSafeEqual(Buffer.from(h), Buffer.from(hash(legacyToken))) && store.getLocalUser(db)) {
    db.prepare("INSERT INTO agents (id, name, token_hash, created_at, legacy) VALUES (?, ?, ?, ?, 1)").run(`ag_${randomUUID()}`, LEGACY_NAME, h, new Date().toISOString());
    row = db.prepare("SELECT * FROM agents WHERE token_hash = ?").get(h) as Row | undefined;
  }
  if (!row || row.revoked_at) return undefined;
  // At most once a minute: an assistant reading the fleet makes many
  // requests, and "last used" needn't be truer than that.
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= LAST_USED_EVERY_MS) {
    db.prepare("UPDATE agents SET last_used_at = ? WHERE id = ?").run(new Date(now).toISOString(), row.id);
  }
  return ctxOf(row);
}

// "This PC" exists before its first request, so its limits can be set first.
// Once it's been turned off, it stays off until it's turned back on.
export function ensureLegacyAgent(db: DatabaseSync, legacyToken: string | undefined) {
  if (!legacyToken || !store.getLocalUser(db)) return;
  if (db.prepare("SELECT 1 FROM agents WHERE legacy = 1 OR token_hash = ?").get(hash(legacyToken))) return;
  db.prepare("INSERT INTO agents (id, name, token_hash, created_at, legacy) VALUES (?, ?, ?, ?, 1)").run(`ag_${randomUUID()}`, LEGACY_NAME, hash(legacyToken), new Date().toISOString());
}

export function legacyOff(db: DatabaseSync): boolean {
  const row = db.prepare("SELECT revoked_at FROM agents WHERE legacy = 1 ORDER BY created_at DESC LIMIT 1").get() as { revoked_at: string | null } | undefined;
  return !!row?.revoked_at;
}

export function restoreLegacy(db: DatabaseSync): boolean {
  return db.prepare("UPDATE agents SET revoked_at = NULL WHERE legacy = 1 AND revoked_at IS NOT NULL").run().changes > 0;
}

export function listAgents(db: DatabaseSync): AgentView[] {
  return (db.prepare("SELECT * FROM agents WHERE revoked_at IS NULL ORDER BY created_at").all() as Row[]).map(viewOf);
}

export function getAgent(db: DatabaseSync, id: string): AgentView | undefined {
  const row = db.prepare("SELECT * FROM agents WHERE id = ? AND revoked_at IS NULL").get(id) as Row | undefined;
  return row && viewOf(row);
}

// A new assistant, and its token: the only time the token is seen.
export function createAgent(db: DatabaseSync, input: { name: string; access: AgentAccess; apps: "all" | string[] }): { agent: AgentView; token: string } {
  const token = newAgentToken();
  const id = `ag_${randomUUID()}`;
  db.prepare("INSERT INTO agents (id, name, token_hash, created_at, apps, access) VALUES (?, ?, ?, ?, ?, ?)").run(
    id,
    input.name,
    hash(token),
    new Date().toISOString(),
    JSON.stringify(input.apps),
    input.access,
  );
  return { agent: getAgent(db, id)!, token };
}

export function updateAgent(db: DatabaseSync, id: string, patch: { name?: string; access?: AgentAccess; apps?: "all" | string[]; rules?: Record<string, AgentRule> }): AgentView | undefined {
  const current = getAgent(db, id);
  if (!current) return undefined;
  db.prepare("UPDATE agents SET name = ?, access = ?, apps = ?, rules = ? WHERE id = ?").run(
    patch.name ?? current.name,
    patch.access ?? current.access,
    JSON.stringify(patch.apps ?? current.apps),
    JSON.stringify(patch.rules ?? current.rules),
    id,
  );
  return getAgent(db, id);
}

// Revoked: its token stops working at once. Kept, so the audit log can
// still name it.
export function revokeAgent(db: DatabaseSync, id: string): boolean {
  return db.prepare("UPDATE agents SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(new Date().toISOString(), id).changes > 0;
}

export function addGrant(db: DatabaseSync, agentId: string, grant: Omit<AgentGrant, "until">, minutes: number, now = Date.now()): AgentGrant | undefined {
  const row = db.prepare("SELECT grants FROM agents WHERE id = ? AND revoked_at IS NULL").get(agentId) as { grants: string } | undefined;
  if (!row) return undefined;
  const g: AgentGrant = { ...grant, until: new Date(now + minutes * 60_000).toISOString() };
  const others = activeGrants(parse<AgentGrant[]>(row.grants, []), now).filter((x) => !(x.appId === g.appId && x.actionId === g.actionId));
  db.prepare("UPDATE agents SET grants = ? WHERE id = ?").run(JSON.stringify([...others, g]), agentId);
  return g;
}

export function endGrant(db: DatabaseSync, agentId: string, appId: string, actionId: string): boolean {
  const row = db.prepare("SELECT grants FROM agents WHERE id = ?").get(agentId) as { grants: string } | undefined;
  if (!row) return false;
  const grants = parse<AgentGrant[]>(row.grants, []);
  const left = grants.filter((x) => !(x.appId === appId && x.actionId === actionId));
  db.prepare("UPDATE agents SET grants = ? WHERE id = ?").run(JSON.stringify(left), agentId);
  return left.length < grants.length;
}

// What happens when this assistant asks for this action: a live grant lets
// it run, then its rule decides (asking by default).
export function decide(ctx: AgentCtx, appId: string, actionId: string, now = Date.now()): { rule: AgentRule; by: "grant" | "rule" | "default" } {
  if (ctx.grants.some((g) => g.appId === appId && g.actionId === actionId && Date.parse(g.until) > now)) return { rule: "allow", by: "grant" };
  const rule = ctx.rules[ruleKey(appId, actionId)];
  return rule ? { rule, by: "rule" } : { rule: "ask", by: "default" };
}

export const seesApp = (ctx: AgentCtx | undefined, appId: string) => !ctx || ctx.apps === "all" || ctx.apps.has(appId);

// What a token's request may reach, beyond the agent token's own limits
// (security.ts): an assistant limited to some apps sees only those, through
// the endpoints its MCP server uses; one that only reads can't ask.
const APP_PATH = /^\/api\/apps\/([^/]+)(\/|$)/;
const SCOPED_LISTS = new Set(["/api/me", "/api/apps", "/api/status", "/api/providers", "/api/services"]);
export function scopeRefusal(db: DatabaseSync, ctx: AgentCtx, method: string, apiPath: string): string | undefined {
  const isAction = method === "POST";
  if (isAction && ctx.access === "read") return `${ctx.name} can only read: it can't ask for actions. Change that in Periskopos → Settings → AI assistants.`;
  if (ctx.apps === "all") return undefined;
  const m = APP_PATH.exec(apiPath);
  if (m) {
    const user = store.getLocalUser(db);
    let slug: string;
    try {
      slug = decodeURIComponent(m[1]!);
    } catch {
      return "No such app";
    }
    const app = user && store.getApp(db, user.id, slug);
    // An app it can't see doesn't exist, as far as it can tell.
    if (!app || !ctx.apps.has(app.id)) return "No such app";
    return undefined;
  }
  return SCOPED_LISTS.has(apiPath) ? undefined : `${ctx.name} can see only some apps, so this isn't open to it.`;
}

// ── The audit log ───────────────────────────────────────────────────────

export function audit(db: DatabaseSync, e: Omit<AgentAuditEntry, "id" | "at" | "agentName"> & { at?: string }) {
  db.prepare("INSERT INTO agent_audit (agent_id, at, client, method, path, app_slug, outcome, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    e.agentId,
    e.at ?? new Date().toISOString(),
    e.client ?? null,
    e.method,
    e.path,
    e.appSlug ?? null,
    e.outcome,
    e.status,
    e.detail ?? null,
  );
}

type AuditRow = { id: number; agent_id: string; name: string | null; at: string; client: string | null; method: string; path: string; app_slug: string | null; outcome: string; status: number; detail: string | null };

export function listAudit(db: DatabaseSync, { agentId, limit = 200 }: { agentId?: string; limit?: number } = {}): AgentAuditEntry[] {
  const rows = db
    .prepare(
      `SELECT a.*, g.name FROM agent_audit a LEFT JOIN agents g ON g.id = a.agent_id
       ${agentId ? "WHERE a.agent_id = ?" : ""} ORDER BY a.id DESC LIMIT ?`,
    )
    .all(...(agentId ? [agentId, limit] : [limit])) as AuditRow[];
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    agentId: r.agent_id,
    agentName: r.name ?? "A removed assistant",
    ...(r.client ? { client: r.client } : {}),
    method: r.method,
    path: r.path,
    ...(r.app_slug ? { appSlug: r.app_slug } : {}),
    outcome: r.outcome,
    status: r.status,
    ...(r.detail ? { detail: r.detail } : {}),
  }));
}

export function pruneAudit(db: DatabaseSync, now = Date.now()) {
  db.prepare("DELETE FROM agent_audit WHERE at < ?").run(new Date(now - AUDIT_KEEP_DAYS * 86_400_000).toISOString());
}

const csvCell = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  // A cell a spreadsheet would run as a formula is kept as text.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function auditCsv(entries: AgentAuditEntry[]): string {
  const head = ["at", "assistant", "client", "method", "path", "app", "outcome", "status", "detail"];
  const lines = entries.map((e) => [e.at, e.agentName, e.client, e.method, e.path, e.appSlug, e.outcome, e.status, e.detail].map(csvCell).join(","));
  return [head.join(","), ...lines].join("\n") + "\n";
}
