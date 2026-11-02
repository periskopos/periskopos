import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentAccess, AgentRule, McpStatus } from "../../shared/types.ts";
import { listActions } from "../agents/actions.ts";
import {
  GRANT_MINUTES,
  auditCsv,
  createAgent,
  endGrant,
  ensureLegacyAgent,
  getAgent,
  legacyOff,
  listAgents,
  listAudit,
  restoreLegacy,
  revokeAgent,
  updateAgent,
} from "../agents/agents.ts";
import { ROOT } from "../config.ts";
import { HttpError, badRequest } from "../errors.ts";
import * as store from "../store.ts";
import { requiredText } from "../validate.ts";
import { jsonBody, router } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// AI assistants, managed on screen only (security.ts keeps agents out of
// /api/agents): each one, its token shown once, what it may see and do, its
// rules and grants, and the audit log of what every assistant asked for.
// The `node` assistants start the MCP server with: the one on PATH. Asked at
// most once a minute.
let nodeSeen: { at: number; value: Promise<McpStatus["node"]> } | undefined;
export function nodeOnPath(now = Date.now()): Promise<McpStatus["node"]> {
  if (nodeSeen && now - nodeSeen.at < 60_000) return nodeSeen.value;
  const value = new Promise<McpStatus["node"]>((resolve) => {
    execFile("node", ["--version"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      const version = err ? "" : stdout.trim();
      resolve(version ? { version, ok: Number(/^v(\d+)/.exec(version)?.[1] ?? 0) >= 24 } : null);
    });
  });
  nodeSeen = { at: now, value };
  return value;
}

const claudeDesktopConfig = () =>
  process.platform === "win32"
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "Claude", "claude_desktop_config.json")
    : process.platform === "darwin"
    ? path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
    : path.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");

export function agentRoutes({ db, approvals, agentToken }: RouteDeps) {
  const r = router();

  // The MCP server, and how to set it up: without a token it reads the data
  // folder's (it's "This PC"); with one, it's that assistant. Options first
  // and no "--": PowerShell drops a bare "--", and --env would then take the
  // command as more variables.
  const mcpMain = path.join(ROOT, "mcp", "main.ts");
  const setup = (token?: string) => ({
    claudeCode: `claude mcp add ${token ? `--env PERISKOPOS_AGENT_TOKEN=${token} ` : ""}--scope user periskopos node "${mcpMain}"`,
    json: JSON.stringify({ mcpServers: { "periskopos": { command: "node", args: [mcpMain], ...(token ? { env: { PERISKOPOS_AGENT_TOKEN: token } } : {}) } } }, null, 2),
  });

  r.get("/agents", async (c) => {
    ensureLegacyAgent(db, agentToken);
    const [last] = listAudit(db, { limit: 1 });
    const mcp: McpStatus = {
      installed: existsSync(mcpMain),
      node: await nodeOnPath(),
      setup: { ...setup(), claudeDesktop: claudeDesktopConfig() },
      thisPcOff: legacyOff(db),
      ...(last ? { lastRequest: { agentName: last.agentName, ...(last.client ? { client: last.client } : {}), at: last.at } } : {}),
    };
    return c.json({ agents: listAgents(db), grantMinutes: GRANT_MINUTES, mcp });
  });

  // "This PC", turned off, back on: the MCP servers set up without a token
  // work again.
  r.post("/agents/this-pc", (c) => {
    ensureLegacyAgent(db, agentToken);
    restoreLegacy(db);
    return c.json({ agents: listAgents(db) });
  });

  const accessOf = (v: unknown): AgentAccess => {
    if (v !== "read" && v !== "ask") throw badRequest('access must be "read" or "ask"');
    return v;
  };
  const appsOf = (userId: string, v: unknown): "all" | string[] => {
    if (v === "all") return "all";
    if (!Array.isArray(v) || v.length === 0) throw badRequest('apps must be "all" or a list of app ids');
    const known = new Set(store.listApps(db, userId).map((a) => a.id));
    const ids = [...new Set(v.map(String))];
    if (ids.some((id) => !known.has(id))) throw badRequest("One of those apps doesn't exist");
    return ids;
  };

  r.post("/agents", async (c) => {
    const body = await jsonBody(c);
    const { agent, token } = createAgent(db, {
      name: requiredText(body.name, "Name", 40),
      access: accessOf(body.access ?? "ask"),
      apps: appsOf(c.var.user.id, body.apps ?? "all"),
    });
    c.header("Cache-Control", "no-store");
    return c.json({ agent, token, setup: setup(token) }, 201);
  });

  r.patch("/agents/:id", async (c) => {
    const id = c.req.param("id")!;
    if (!getAgent(db, id)) throw new HttpError(404, "No such assistant");
    const body = await jsonBody(c);
    const patch: Parameters<typeof updateAgent>[2] = {};
    if (body.name !== undefined) patch.name = requiredText(body.name, "Name", 40);
    if (body.access !== undefined) patch.access = accessOf(body.access);
    if (body.apps !== undefined) patch.apps = appsOf(c.var.user.id, body.apps);
    if (body.rules !== undefined) patch.rules = await rulesOf(c.var.user.id, body.rules);
    return c.json({ agent: updateAgent(db, id, patch) });
  });

  // A rule per action, for actions that exist; a dangerous one can't run
  // without the screen, so it can't be set to run without asking.
  async function rulesOf(userId: string, v: unknown): Promise<Record<string, AgentRule>> {
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw badRequest("rules must be an object");
    const apps = new Map(store.listApps(db, userId).map((a) => [a.id, a]));
    const out: Record<string, AgentRule> = {};
    const actionsOf = new Map<string, Awaited<ReturnType<typeof listActions>>>();
    for (const [key, rule] of Object.entries(v as Record<string, unknown>)) {
      if (rule !== "ask" && rule !== "allow" && rule !== "never") throw badRequest(`A rule is "ask", "allow" or "never", not "${String(rule)}"`);
      const at = key.indexOf(":");
      const app = apps.get(key.slice(0, at));
      if (at < 1 || !app) throw badRequest(`No such app in the rule "${key}"`);
      const actionId = key.slice(at + 1);
      if (!actionsOf.has(app.id)) actionsOf.set(app.id, await listActions(db, app));
      const def = actionsOf.get(app.id)!.actions.find((a) => a.id === actionId);
      if (!def) throw badRequest(`${app.name} has no action "${actionId}"`);
      if (rule === "allow" && def.danger) throw badRequest(`${def.label} on ${app.name} is dangerous: it always needs the screen, so it can't run without asking`);
      if (rule !== "ask") out[key] = rule;
    }
    return out;
  }

  // Revoked: its token stops working now, and whatever it's waiting on is
  // withdrawn.
  r.delete("/agents/:id", (c) => {
    const id = c.req.param("id")!;
    if (!revokeAgent(db, id)) throw new HttpError(404, "No such assistant");
    approvals.cancelWhere((a) => a.agentId === id);
    return c.body(null, 204);
  });

  r.delete("/agents/:id/grants", (c) => {
    const appId = c.req.query("appId");
    const actionId = c.req.query("actionId");
    if (!appId || !actionId) throw badRequest("Say which grant: appId and actionId");
    if (!endGrant(db, c.req.param("id")!, appId, actionId)) throw new HttpError(404, "No such grant");
    return c.body(null, 204);
  });

  // ?agent=<id> for one; ?format=csv or json to download (up to 5,000).
  r.get("/agents/audit", (c) => {
    const agentId = c.req.query("agent") || undefined;
    const format = c.req.query("format");
    const entries = listAudit(db, { ...(agentId ? { agentId } : {}), limit: format ? 5000 : 200 });
    if (format === "csv") {
      c.header("Content-Type", "text/csv; charset=utf-8");
      c.header("Content-Disposition", 'attachment; filename="periskopos-assistants.csv"');
      return c.body(auditCsv(entries));
    }
    if (format === "json") c.header("Content-Disposition", 'attachment; filename="periskopos-assistants.json"');
    return c.json({ entries });
  });

  return r;
}
