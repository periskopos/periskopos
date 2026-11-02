import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { MiddlewareHandler } from "hono";
import type { AgentCtx } from "./agents/agents.ts";

// Two keys (docs/AGENT-SAFETY.md §4.1):
// - the app's session key: made fresh by the desktop app each time it starts
//   the server, handed over on the server's stdin and given to the app's own
//   window as an in-memory cookie. Never written down, never put in a page.
//   Full access, and the only way to see Periskopos at all;
// - an assistant's token (server/agents/agents.ts), one per AI assistant, or the
//   shared `token` file in the data folder: it can read, and ask for an
//   action, which then waits for me to approve it in the app (or runs, if a
//   rule or grant says so); only what its scope lets it see; and only while
//   Settings lets assistants in.
// Who is calling is decided here, from the key, never from the request.
export type Role = "ui" | "agent";

// The AI assistant calling through the MCP server names itself (MCP's
// clientInfo), and the MCP server passes that on in x-periskopos-client. It's only
// ever shown to me, so it's cleaned to a short line of text and well-known
// tools get their usual names. It proves nothing: the agent token decides
// what the caller may do.
const KNOWN_CLIENTS: [RegExp, string][] = [
  [/claude[-_ ]?code/i, "Claude Code"],
  [/claude[-_ ]?(ai|desktop)/i, "Claude Desktop"],
  [/cursor/i, "Cursor"],
  [/visual studio code|vscode|copilot/i, "VS Code"],
  [/windsurf|codeium/i, "Windsurf"],
  [/zed/i, "Zed"],
];
export const ANY_ASSISTANT = "An AI assistant";
export function agentName(raw: string | undefined): string {
  const text = (raw ?? "").replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 40);
  if (!text) return ANY_ASSISTANT;
  return KNOWN_CLIENTS.find(([re]) => re.test(text))?.[1] ?? text;
}

export const SESSION_COOKIE = "periskopos_session";
export const newSessionKey = () => randomBytes(32).toString("base64url");

function cookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return undefined;
}

export function loadOrCreateToken(dataDir: string): string {
  const file = path.join(dataDir, "token");
  try {
    const existing = readFileSync(file, "utf8").trim();
    if (existing.length >= 32) return existing;
  } catch {
    // first run
  }
  mkdirSync(dataDir, { recursive: true });
  const token = randomBytes(32).toString("base64url");
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return token;
}

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Rejects anything that isn't this server's own page talking to it:
// - a Host that isn't ours (DNS rebinding: evil.com resolving to 127.0.0.1),
// - an Origin that isn't ours, or a cross-site fetch (another site in my
//   browser),
// - an API call without a key (another program on my PC), and the page
//   itself to anything but the app's own window.
export type AgentRequest = { ctx: AgentCtx; client: string; method: string; path: string; status: number; outcome: string; detail?: string };
export type GuardVars = { role: Role; agent: string; agentCtx: AgentCtx; auditOutcome: string; auditDetail: string };

export function guard({
  token,
  agentFor = () => undefined,
  agentRefusal = () => undefined,
  onAgentRequest = () => {},
  agentAllowed = () => true,
  port,
}: {
  token: string;
  agentFor?: (given: string) => AgentCtx | undefined;
  agentRefusal?: (ctx: AgentCtx, method: string, apiPath: string) => string | undefined;
  onAgentRequest?: (r: AgentRequest) => void;
  agentAllowed?: () => boolean;
  port: number;
}): MiddlewareHandler<{ Variables: GuardVars }> {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));

  return async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hosts.has(host)) return c.text("Forbidden", 403);

    const origin = c.req.header("origin");
    if (origin && !origins.has(origin)) return c.json({ error: "Forbidden origin" }, 403);
    if (c.req.header("sec-fetch-site") === "cross-site") {
      return c.json({ error: "Forbidden" }, 403);
    }

    // The app's window carries the session key as a cookie; the app itself
    // (its tray) sends it as a header. The agent token is only ever a header.
    const session = cookie(c.req.header("cookie"), SESSION_COOKIE);
    const given = c.req.header("x-periskopos-token");
    const isUi = Boolean((session && sameSecret(session, token)) || (given && sameSecret(given, token)));
    const ctx = !isUi && given ? agentFor(given) : undefined;
    const role: Role | undefined = isUi ? "ui" : ctx ? "agent" : undefined;

    if (!c.req.path.startsWith("/api/") || role !== "agent" || !ctx) {
      if (c.req.path.startsWith("/api/") && !role) return c.json({ error: "Missing or wrong local token" }, 401);
      if (role) c.set("role", role);
      return next();
    }

    // An assistant: who it says it is (its own name, or for the shared token
    // the tool it says it is), what it may reach, and a line in the audit log
    // whatever comes of it.
    const client = agentName(c.req.header("x-periskopos-client"));
    const method = c.req.method;
    const apiPath = c.req.path;
    const refuse = (status: 403 | 404, error: string) => {
      onAgentRequest({ ctx, client, method, path: apiPath, status, outcome: "refused", detail: error });
      return c.json({ error }, status);
    };
    if (!agentAllowed()) {
      return refuse(403, "AI assistants can't use Periskopos right now: it's switched off. Turn it on in Periskopos → Settings → AI assistants.");
    }
    if (!agentMayCall(method, apiPath)) {
      return refuse(403, "Agents can read, and ask for an app's actions; anything else is done on screen in Periskopos.");
    }
    const narrower = agentRefusal(ctx, method, apiPath);
    if (narrower) return refuse(narrower === "No such app" ? 404 : 403, narrower);

    c.set("role", "agent");
    c.set("agentCtx", ctx);
    c.set("agent", ctx.legacy ? client : ctx.name);
    try {
      await next();
    } finally {
      const status = c.res.status;
      onAgentRequest({
        ctx,
        client,
        method,
        path: apiPath,
        status,
        outcome: c.get("auditOutcome") ?? (status >= 400 ? "failed" : method === "GET" || method === "HEAD" ? "read" : "done"),
        ...(c.get("auditDetail") ? { detail: c.get("auditDetail") } : {}),
      });
    }
  };
}

// What the agent token may do: read anything (no read returns a key), and
// ask to run an action. Approvals, settings, "Allow actions", protocol
// secrets, adding or removing anything: the UI only.
const AGENT_ACTION = /^\/api\/apps\/[^/]+\/actions\/[^/]+$/;
export function agentMayCall(method: string, apiPath: string): boolean {
  if (apiPath === "/api/approvals" || apiPath.startsWith("/api/approvals/")) return false;
  // The assistants themselves, their tokens' setup and the audit log: on screen only.
  if (apiPath === "/api/agents" || apiPath.startsWith("/api/agents/")) return false;
  if (method === "GET" || method === "HEAD") return true;
  return method === "POST" && AGENT_ACTION.test(apiPath);
}
