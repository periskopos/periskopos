import { badRequest, HttpError } from "../errors.ts";
import * as history from "../history.ts";
import { protocolSecretRef } from "../protocol.ts";
import { removeSecret } from "../keys/secrets.ts";
import * as store from "../store.ts";
import { suggestionsFor } from "../suggestions.ts";
import { httpUrl, requiredText, text } from "../validate.ts";
import { settleLiveChecks } from "../watcher.ts";
import { findApp, jsonBody, router, visible } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// Apps (FR-A1–A7): add, edit, remove; their icon, history, and what my
// accounts could still add to them.
export function appRoutes({ db, watcher, icons }: RouteDeps) {
  const r = router();

  r.get("/apps", (c) => c.json({ apps: visible(c, store.listApps(db, c.var.user.id)) }));

  r.post("/apps", async (c) => {
    const body = await jsonBody(c);
    const app = store.createApp(db, c.var.user.id, {
      name: requiredText(body.name, "Name", 80),
      url: httpUrl(body.url, "URL"),
      notes: text(body.notes, "Notes", { max: 2000, optional: true }),
      live: liveFlag(body.live) ?? true,
    });
    void icons?.refresh(app).catch((err) => console.error(`Icon refresh failed: ${(err as Error).message}`));
    return c.json({ app }, 201);
  });

  r.get("/apps/:slug", (c) => c.json({ app: findApp(db, c) }));

  // The app's favicon, as fetched from its site. Only ever shown in an
  // <img>, but an SVG opened on its own would be a page on this origin: it
  // gets no scripts and nothing else.
  r.get("/apps/:slug/icon", (c) => {
    const app = findApp(db, c);
    const icon = store.getAppIcon(db, app.id);
    if (!icon?.data || !icon.type || icon.pageUrl !== app.url) throw new HttpError(404, "This app has no icon");
    c.header("Content-Type", icon.type);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // The URL carries the icon's date: a new icon is a new URL.
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    return c.body(new Uint8Array(icon.data));
  });

  r.patch("/apps/:slug", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    const updated = store.updateApp(db, app, {
      ...(body.name !== undefined ? { name: requiredText(body.name, "Name", 80) } : {}),
      ...(body.url !== undefined ? { url: httpUrl(body.url, "URL") } : {}),
      ...(body.notes !== undefined
        ? { notes: text(body.notes, "Notes", { max: 2000, optional: true }) ?? null }
        : {}),
      ...(body.live !== undefined ? { live: liveFlag(body.live) } : {}),
      ...(body.checkIntervalMin !== undefined
        ? { checkIntervalMin: checkInterval(body.checkIntervalMin) }
        : {}),
    });
    if (app.live && !updated.live) settleLiveChecks(db, updated);
    // Launched: look at the site now rather than at the next check.
    if (!app.live && updated.live) void watcher.checkApp(updated).catch((err) => console.error(`First check failed: ${(err as Error).message}`));
    // A new URL, or just launched: its icon, if it's due.
    void icons?.refresh(updated).catch((err) => console.error(`Icon refresh failed: ${(err as Error).message}`));
    return c.json({ app: updated });
  });

  r.delete("/apps/:slug", (c) => {
    const app = findApp(db, c);
    store.deleteApp(db, app);
    // Its protocol secret goes with it: a new app of the same name would
    // otherwise find it and talk to its endpoint with the old app's secret.
    const stillUsed = new Set(store.listApps(db, c.var.user.id).flatMap((a) => [a.protocol?.secretRef, protocolSecretRef(a.slug)]));
    for (const ref of new Set([app.protocol?.secretRef, protocolSecretRef(app.slug)])) if (ref && !stillUsed.has(ref)) removeSecret(ref);
    return c.body(null, 204);
  });

  r.get("/apps/:slug/history", (c) => c.json({ history: history.appHistory(db, findApp(db, c).id) }));

  // Marking an incident a false alarm (or not): on screen only, as the
  // agent token can't PATCH.
  r.patch("/apps/:slug/incidents/:id", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    if (typeof body.falseAlarm !== "boolean") throw badRequest("falseAlarm must be true or false");
    const incident = history.setFalseAlarm(db, app.id, c.req.param("id"), body.falseAlarm);
    if (!incident) throw new HttpError(404, "No such incident");
    return c.json({ incident });
  });

  // What my accounts could still add to this app ("Get more from this
  // app"), with the one obvious thing in each to connect, if there is one.
  r.get("/apps/:slug/suggestions", async (c) => c.json({ suggestions: await suggestionsFor(findApp(db, c), store.listServices(db, c.var.user.id)) }));

  return r;
}

function liveFlag(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw badRequest("live must be true or false");
  return value;
}

function checkInterval(value: unknown): number {
  if (typeof value !== "number" || !store.CHECK_INTERVALS_MIN.includes(value)) {
    throw badRequest(`Check interval must be one of ${store.CHECK_INTERVALS_MIN.join(", ")} minutes`);
  }
  return value;
}
