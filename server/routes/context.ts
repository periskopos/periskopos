import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import type { App, Connection, Service, ServiceView, User } from "../../shared/types.ts";
import type { Approvals } from "../agents/approvals.ts";
import type { Backups } from "../backup.ts";
import { HttpError, badRequest } from "../errors.ts";
import type { AppIcons } from "../icons.ts";
import type { Notifier } from "../alerts/notify.ts";
import type { AgentCtx } from "../agents/agents.ts";
import { seesApp } from "../agents/agents.ts";
import type { Role } from "../security.ts";
import { keyState } from "../keys/secrets.ts";
import * as store from "../store.ts";
import type { Watcher } from "../watcher.ts";

// What every group of API routes shares: who is asking (set by app.ts
// before any of them runs), what they're given to work with, and the
// lookups and answers they'd otherwise each write again.

export type Env = { Variables: { user: User; role: Role; agent: string; agentCtx: AgentCtx; auditOutcome: string; auditDetail: string } };

// The apps the caller may see: all of them for the screen, those in its
// scope for an assistant limited to some.
export const visible = <T extends { id: string }>(c: Context<Env>, apps: T[]): T[] => apps.filter((a) => seesApp(c.var.agentCtx, a.id));

export type RouteDeps = {
  db: DatabaseSync;
  approvals: Approvals;
  notifier: Notifier;
  watcher: Watcher;
  icons?: AppIcons;
  backups?: Backups;
  port: number;
  agentToken?: string; // the data folder's token: "This PC"
};

export const router = () => new Hono<Env>();

export function findApp(db: DatabaseSync, c: Context<Env>): App {
  const app = store.getApp(db, c.var.user.id, c.req.param("slug")!);
  if (!app) throw new HttpError(404, "No such app");
  return app;
}

export function findConnection(db: DatabaseSync, c: Context<Env>): { app: App; conn: Connection } {
  const app = findApp(db, c);
  const conn = app.connections.find((x) => x.id === c.req.param("id"));
  if (!conn) throw new HttpError(404, "No such connection");
  return { app, conn };
}

// The account a connection reads through, which may have been removed since.
export function accountOf(db: DatabaseSync, c: Context<Env>, conn: Connection): Service {
  const service = conn.serviceId ? store.getService(db, c.var.user.id, conn.serviceId) : undefined;
  if (!service) throw new HttpError(409, "The account this connection used was removed");
  return service;
}

export function findService(db: DatabaseSync, c: Context<Env>): Service {
  const service = store.getService(db, c.var.user.id, c.req.param("id")!);
  if (!service) throw new HttpError(404, "No such service");
  return service;
}

// An account as the window sees it: whether its key is there, and which
// apps use it. Never the key.
export function accountView(db: DatabaseSync, s: Service, usage = store.serviceUsage(db, s.ownerId)): ServiceView {
  return { ...s, keyState: keyState(s), apps: usage.get(s.id) ?? [] };
}

// A provider's answer, or its failure as a 502 in its own words: it's the
// provider that failed, not Periskopos.
export async function fromProvider<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    throw new HttpError(502, (err as Error).message);
  }
}

export async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw badRequest("The request body must be JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw badRequest("The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

// A pasted key or secret, or a 400 saying what's wrong with it.
export function pasted<T>(read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}
