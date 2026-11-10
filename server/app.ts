import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import type { User } from "../shared/types.ts";
import { GRANT_MINUTES, addGrant, agentForToken, audit, pruneAudit, scopeRefusal } from "./agents/agents.ts";
import { Approvals } from "./agents/approvals.ts";
import type { Backups } from "./backup.ts";
import { HttpError, badRequest } from "./errors.ts";
import type { AppIcons } from "./icons.ts";
import { silentNotifier } from "./alerts/notify.ts";
import type { Notifier } from "./alerts/notify.ts";
import { accountRoutes } from "./routes/accounts.ts";
import { agentRoutes } from "./routes/agents.ts";
import { configRoutes } from "./routes/config.ts";
import { actionRoutes } from "./routes/actions.ts";
import { appRoutes } from "./routes/apps.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { jsonBody, router } from "./routes/context.ts";
import type { RouteDeps } from "./routes/context.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { statusRoutes } from "./routes/status.ts";
import { SESSION_COOKIE, guard } from "./security.ts";
import type { GuardVars } from "./security.ts";
import { getSettings } from "./settings.ts";
import * as store from "./store.ts";
import { requiredText } from "./validate.ts";
import { Watcher } from "./watcher.ts";

export type Deps = {
  db: DatabaseSync;
  // The UI's token; the agent token is optional (docs/AGENT-SAFETY.md §4.1).
  token: string;
  agentToken?: string;
  approvals?: Approvals;
  port: number;
  distDir: string;
  notifier?: Notifier;
  watcher?: Watcher;
  // Fetches apps' favicons; without it, an app shows the icon it already has.
  icons?: AppIcons;
  // The database's daily copies; without them, Settings has no Backups section.
  backups?: Backups;
};

// The page loads only its own files and talks only to this server.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "script-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

// The server: who may ask (the guard), the API's groups of routes
// (server/routes), and the page itself.
export function createApp({
  db,
  token,
  agentToken,
  approvals = new Approvals(),
  port,
  distDir,
  notifier = silentNotifier,
  watcher = new Watcher({ db, notifier, baseUrl: `http://localhost:${port}` }),
  icons,
  backups,
}: Deps) {
  const app = new Hono<{ Variables: GuardVars }>();

  // Claude gets in only while Settings says so.
  const agentAllowed = () => {
    const user = store.getLocalUser(db);
    return user !== undefined && getSettings(db, user.id).agentAccess;
  };
  pruneAudit(db);
  const prune = setInterval(() => pruneAudit(db), 24 * 60 * 60_000);
  prune.unref?.();
  app.use(
    "*",
    guard({
      token,
      agentFor: (given) => agentForToken(db, given, agentToken),
      agentRefusal: (ctx, method, apiPath) => scopeRefusal(db, ctx, method, apiPath),
      onAgentRequest: (r) => {
        try {
          const slug = /^\/api\/apps\/([^/]+)/.exec(r.path)?.[1];
          audit(db, { agentId: r.ctx.id, client: r.client, method: r.method, path: r.path, ...(slug ? { appSlug: decodeURIComponent(slug) } : {}), outcome: r.outcome, status: r.status, ...(r.detail ? { detail: r.detail } : {}) });
        } catch (err) {
          console.error(`Couldn't write the assistants' audit log: ${(err as Error).message}`);
        }
      },
      agentAllowed,
      port,
    }),
  );

  // An agent asked for something: tell me, wherever I am.
  approvals.onRequest((a) => {
    void notifier
      .notify({
        title: `${a.agent} asks to run ${a.label}`,
        body: `${a.label} on ${a.appName} (${a.service}). Open Periskopos to approve or decline it.`,
        url: `http://localhost:${port}/#/apps/${encodeURIComponent(a.appSlug)}`,
      })
      .catch((err: unknown) => console.error(`Couldn't show the approval notification: ${(err as Error).message}`));
  });

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    console.error(err);
    return c.json({ error: "Something went wrong in Periskopos" }, 500);
  });

  // The one place the current user comes from (FR-U2). Sign-in, if it ever
  // comes, replaces only this.
  const currentUser = (_c: Context): User | undefined => store.getLocalUser(db);

  const api = router();

  api.get("/me", (c) => c.json({ user: currentUser(c) ?? null }));

  api.patch("/me", async (c) => {
    const user = currentUser(c);
    if (!user) throw new HttpError(409, "Periskopos isn't set up yet");
    const body = await jsonBody(c);
    return c.json({ user: store.renameUser(db, user, requiredText(body.name, "Name", 80)) });
  });

  api.post("/setup", async (c) => {
    if (currentUser(c)) throw new HttpError(409, "Periskopos is already set up");
    const body = await jsonBody(c);
    const user = store.createUser(db, requiredText(body.name, "Name", 80));
    return c.json({ user }, 201);
  });

  // What agents are waiting on, and my answer (UI token only). Before the
  // user check: the page asks from the first-run screen too.
  api.get("/approvals", (c) => c.json({ approvals: approvals.list() }));

  // { approve, allowForMinutes? }: approving can also let that assistant
  // run that action without asking for a while.
  api.post("/approvals/:id", async (c) => {
    const body = await jsonBody(c);
    if (typeof body.approve !== "boolean") throw badRequest("approve must be true or false");
    const minutes = body.allowForMinutes;
    if (minutes !== undefined && !(GRANT_MINUTES as readonly number[]).includes(minutes as number)) throw badRequest(`allowForMinutes is one of ${GRANT_MINUTES.join(", ")}`);
    const asked = approvals.get(c.req.param("id")!);
    if (!asked || !approvals.decide(asked.id, body.approve)) {
      throw new HttpError(404, "That request has already been answered or has expired");
    }
    if (body.approve && minutes !== undefined && asked.agentId && asked.appId) {
      addGrant(db, asked.agentId, { appId: asked.appId, actionId: asked.actionId }, minutes as number);
    }
    return c.json({ ok: true });
  });

  // Everything below needs the user.
  api.use("*", async (c, next) => {
    const user = currentUser(c);
    if (!user) throw new HttpError(409, "Set up Periskopos first");
    c.set("user", user);
    await next();
  });

  const deps: RouteDeps = { db, approvals, notifier, watcher, port, ...(agentToken ? { agentToken } : {}), ...(icons ? { icons } : {}), ...(backups ? { backups } : {}) };
  for (const routes of [appRoutes, connectionRoutes, statusRoutes, accountRoutes, actionRoutes, settingsRoutes, agentRoutes, configRoutes]) {
    api.route("/", routes(deps));
  }

  api.all("*", () => {
    throw new HttpError(404, "Not found");
  });

  app.route("/api", api);

  // The UI, for the app's own window only (it carries the session key as a
  // cookie). Anything else, a browser or a script, gets a page saying where
  // Periskopos lives, with nothing in it worth having. Read on each
  // request, so a rebuild is picked up without a restart.
  app.get("/", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    if (c.get("role") !== "ui") {
      c.header("Content-Security-Policy", "default-src 'none'");
      return c.html(LOCKED_PAGE, 403);
    }
    let html: string;
    try {
      html = await readFile(path.join(distDir, "index.html"), "utf8");
    } catch {
      return c.text("The UI isn't built yet. Run: npm run build", 503);
    }
    c.header("Content-Security-Policy", CSP);
    return c.html(html);
  });

  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), distDir) }));

  app.notFound((c) => c.text("Not found", 404));

  return app;
}

// What anything but the app's window sees. The meta tag tells the desktop
// app that Periskopos (not some other program) holds the port.
export const LOCKED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="periskopos" content="locked"><title>Periskopos</title></head><body><p>Periskopos opens only in its desktop app.</p></body></html>`;

export { SESSION_COOKIE };
