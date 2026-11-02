import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ActionDef, ActionResult, ActivityEntry, App, BlockedAction } from "../../shared/types.ts";
import { HttpError, badRequest } from "../errors.ts";
import { clearHttpCache } from "../http.ts";
import { integrations } from "../integrations/index.ts";
import { clearProtocolCache, protocolView, runProtocolAction } from "../protocol.ts";
import { authFor } from "../keys/secrets.ts";
import * as store from "../store.ts";

// Actions (PRD §7.8): things I can ask an app's services to do. Only
// offered when the service was connected with "Allow actions" (FR-S5);
// everything that runs is recorded (FR-X3), with whether it came from the
// screen or from Claude.

const ID = /^([a-z-]+):(c_[\w-]+)$/;

export async function listActions(db: DatabaseSync, app: App): Promise<{ actions: ActionDef[]; blocked: BlockedAction[] }> {
  const actions: ActionDef[] = [];
  const blocked: BlockedAction[] = [];

  // The app's own actions, from its protocol endpoint (FR-P3). They have no
  // service key to gate on: the endpoint's secret is what grants them.
  if (app.protocol) {
    const view = await protocolView(app);
    if (view.error) {
      blocked.push({ label: `${app.name}'s own actions`, reason: view.error });
    } else {
      for (const a of view.actions ?? []) {
        actions.push({
          id: `proto:${a.id}`,
          label: a.label,
          description: a.description ?? "",
          danger: a.danger,
          connectionId: "",
          service: `${app.name} itself`,
        });
      }
    }
  }

  for (const conn of app.connections) {
    const defs = integrations[conn.type]?.actions?.(conn) ?? [];
    if (defs.length === 0) continue;
    const service = conn.serviceId ? store.getService(db, app.ownerId, conn.serviceId) : undefined;
    for (const def of defs) {
      if (!service) {
        blocked.push({ label: def.label, reason: "The account this connection used was removed" });
      } else if (!service.canWrite) {
        blocked.push({
          label: `${def.label} (${service.name})`,
          reason: `${service.name} is read only. Turn on "Allow actions" for it on the Accounts page.`,
        });
      } else {
        actions.push({
          id: `${def.id}:${conn.id}`,
          label: def.label,
          description: def.description,
          danger: def.danger === true,
          connectionId: conn.id,
          service: service.name,
        });
      }
    }
  }
  return { actions, blocked };
}

// An action marked dangerous needs the app's name typed (FR-X2). Claude can't
// type it, so Claude can't run one at all: it is for the screen only.
function requireDangerConfirmation(danger: boolean, app: App, source: "ui" | "mcp", confirmName: string | undefined) {
  if (!danger) return;
  if (source === "mcp") {
    throw new HttpError(403, "This action is marked dangerous, so it can only be run on screen, where you type the app's name to confirm it.");
  }
  if ((confirmName ?? "").trim().toLowerCase() !== app.name.trim().toLowerCase()) {
    throw badRequest(`Type the app's name (${app.name}) to confirm this action`);
  }
}

// The app as it is now, or undefined if it was deleted (a slug is never
// reused for a different app while this one exists, but check the id too).
export function currentApp(db: DatabaseSync, app: App): App | undefined {
  const now = store.getApp(db, app.ownerId, app.slug);
  return now?.id === app.id ? now : undefined;
}

// Nothing to record it against: the app's activity went with it.
export const removedWhileWaiting = () => new HttpError(409, "The app was removed while waiting, so nothing was run.");

export type PreparedAction = {
  label: string;
  service: string;
  run: () => Promise<ActionResult & { label: string }>;
};

// Checks everything that can be checked before an action runs (it exists,
// its service allows actions, a dangerous one is confirmed), so an agent's
// request is only put to me if approving it would actually run it.
export async function prepareAction(
  db: DatabaseSync,
  app: App,
  id: string,
  source: "ui" | "mcp",
  confirmName?: string,
  agent?: string,
): Promise<PreparedAction> {
  // An action the app itself offers through its protocol endpoint.
  if (id.startsWith("proto:")) {
    const actionId = id.slice("proto:".length);
    const def = (await protocolView(app)).actions?.find((a) => a.id === actionId);
    if (!def) throw new HttpError(404, "No such action");
    requireDangerConfirmation(def.danger, app, source, confirmName);
    return {
      label: def.label,
      service: `${app.name} itself`,
      run: async () => {
        // Read again: the app may have been deleted while it waited.
        const now = currentApp(db, app);
        if (!now) throw removedWhileWaiting();
        let result: ActionResult;
        try {
          result = await runProtocolAction(now, actionId);
        } catch (err) {
          result = { ok: false, message: (err as Error).message };
        }
        recordActivity(db, { appId: now.id, actionId: id, label: def.label, source, agent, ...result });
        clearProtocolCache(now); // its numbers may have just changed
        return { ...result, label: def.label };
      },
    };
  }

  const match = ID.exec(id);
  const conn = match && app.connections.find((c) => c.id === match[2]);
  const integration = conn && integrations[conn.type];
  const def = conn && integration?.actions?.(conn).find((a) => a.id === match[1]);
  if (!match || !conn || !integration?.run || !def) throw new HttpError(404, "No such action");
  requireDangerConfirmation(def.danger === true, app, source, confirmName);

  const service = conn.serviceId ? store.getService(db, app.ownerId, conn.serviceId) : undefined;
  if (!service) throw new HttpError(409, "The account this action used was removed");
  if (!service.canWrite) {
    throw new HttpError(403, `${service.name} is read only. Turn on "Allow actions" for it on the Accounts page first.`);
  }

  return {
    label: def.label,
    service: service.name,
    run: async () => {
      // Read everything again: while it waited for approval the app or this
      // connection may have been removed, or "Allow actions" switched off.
      const nowApp = currentApp(db, app);
      if (!nowApp) throw removedWhileWaiting();
      const nowConn = nowApp.connections.find((c) => c.id === conn.id);
      if (!nowConn) {
        const message = "This connection was removed while waiting, so nothing was run.";
        recordActivity(db, { appId: nowApp.id, actionId: id, label: def.label, source, agent, ok: false, message });
        throw new HttpError(409, message);
      }
      const now = store.getService(db, app.ownerId, service.id);
      if (!now?.canWrite) {
        // Refused after approval: the audit log still has to show the attempt.
        const message = `${service.name} is read only now, so nothing was run.`;
        recordActivity(db, { appId: nowApp.id, actionId: id, label: def.label, source, agent, ok: false, message });
        throw new HttpError(403, message);
      }
      let result: ActionResult;
      try {
        result = await integration.run!(nowConn, authFor(now), match[1]);
      } catch (err) {
        result = { ok: false, message: (err as Error).message };
      }
      recordActivity(db, { appId: nowApp.id, actionId: id, label: def.label, source, agent, ...result });
      clearHttpCache(); // what the host reports has just changed
      return { ...result, label: def.label };
    },
  };
}

export async function runAction(
  db: DatabaseSync,
  app: App,
  id: string,
  source: "ui" | "mcp",
  confirmName?: string,
): Promise<ActionResult & { label: string }> {
  return (await prepareAction(db, app, id, source, confirmName)).run();
}

// ── Activity log ────────────────────────────────────────────────────────

export function recordActivity(db: DatabaseSync, e: Omit<ActivityEntry, "id" | "at">) {
  db.prepare("INSERT INTO activity (id, app_id, at, action_id, label, source, agent, ok, message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    `x_${randomBytes(8).toString("base64url")}`,
    e.appId,
    new Date().toISOString(),
    e.actionId,
    e.label,
    e.source,
    e.source === "mcp" ? (e.agent ?? null) : null,
    e.ok ? 1 : 0,
    e.message,
  );
}

type Row = { id: string; app_id: string; at: string; action_id: string; label: string; source: "ui" | "mcp"; agent: string | null; ok: number; message: string };

export function listActivity(db: DatabaseSync, appId: string, limit = 20): ActivityEntry[] {
  const rows = db.prepare("SELECT * FROM activity WHERE app_id = ? ORDER BY at DESC, rowid DESC LIMIT ?").all(appId, limit) as Row[];
  return rows.map((r) => ({
    id: r.id,
    appId: r.app_id,
    at: r.at,
    actionId: r.action_id,
    label: r.label,
    source: r.source,
    ...(r.agent ? { agent: r.agent } : {}),
    ok: r.ok === 1,
    message: r.message,
  }));
}
