import { ACCOUNTS } from "../../shared/catalog.ts";
import { HttpError, badRequest } from "../errors.ts";
import { integrations } from "../integrations/index.ts";
import { authFor } from "../keys/secrets.ts";
import * as store from "../store.ts";
import { requiredText } from "../validate.ts";
import { accountOf, findApp, findConnection, fromProvider, jsonBody, router } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// An app's connections (FR-A2, FR-A3): connect, look inside, edit, remove.
export function connectionRoutes({ db, watcher }: RouteDeps) {
  const r = router();

  r.post("/apps/:slug/connections", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    const type = requiredText(body.type, "Type", 40);
    // Own keys only: "constructor" or "toString" must not pass as a type.
    const integration = Object.hasOwn(integrations, type) ? integrations[type] : undefined;
    if (!integration) throw badRequest(`Unknown connection type "${type}"`);
    let serviceId: string | undefined;
    if (integration.needsService) {
      const service = store.getService(db, c.var.user.id, requiredText(body.serviceId, "Service", 60));
      if (!service || service.type !== integration.serviceType) {
        throw badRequest(`Pick one of your ${integration.serviceType ? ACCOUNTS[integration.serviceType].label : integration.label} accounts`);
      }
      serviceId = service.id;
    }
    const parsed = integration.parse({ resource: body.resource, settings: body.settings });
    // Another status check is an extra URL of the app's own: each URL once.
    if (type === "site") {
      if (app.connections.some((x) => x.type === "site" && x.resource === parsed.resource)) throw badRequest("That URL is already checked for this app");
      parsed.settings = { ...parsed.settings, label: parsed.settings?.label ?? shortUrl(app.url, parsed.resource) };
    }
    const input = { type, ...parsed, ...(serviceId ? { serviceId } : {}) };
    if (store.sameConnection(app, input)) throw new HttpError(409, `${app.name} already has ${parsed.resource} connected`);
    const connection = store.addConnection(db, app, input);
    return c.json({ connection }, 201);
  });

  // What an app page shows for one connection: a host's deploys, a
  // source's commits and CI runs, a domain's traffic.
  r.get("/apps/:slug/connections/:id/details", async (c) => {
    const { conn } = findConnection(db, c);
    const integration = integrations[conn.type];
    if (!integration?.details) throw new HttpError(404, "Nothing more to show for this connection");
    const service = accountOf(db, c, conn);
    return c.json({ details: await fromProvider(() => integration.details!(conn, authFor(service))) });
  });

  // Why a connection's check is failing, in the provider's own words: the
  // end of each failed CI job's log. Read-only, and never a key.
  r.get("/apps/:slug/connections/:id/failure-log", async (c) => {
    const { app, conn } = findConnection(db, c);
    const integration = integrations[conn.type];
    if (!integration?.failureLog) throw new HttpError(404, "This connection has no logs to read");
    const service = accountOf(db, c, conn);
    const failure = await fromProvider(() => integration.failureLog!(conn, authFor(service)));
    // A failed build's log is kept by the host that ran it (Cloudflare's
    // Workers Builds): the app's connection to that host reads it, if any.
    for (const build of failure.builds) {
      if (!build.url) continue;
      for (const other of app.connections) {
        const otherService = other.serviceId ? store.getService(db, c.var.user.id, other.serviceId) : undefined;
        const log = otherService && (await integrations[other.type]?.buildLog?.(other, authFor(otherService), build.url));
        if (log) {
          Object.assign(build, log);
          break;
        }
      }
    }
    return c.json({ failure });
  });

  // What's edited about a connection in place: a domain's expiry date,
  // entered by hand when it can't be looked up (FR-I5), and what a status
  // check expects of its page and how slow is too slow. The rest of a
  // status check's settings (its name, an expected status) stay as they are.
  r.patch("/apps/:slug/connections/:id", async (c) => {
    const { app, conn } = findConnection(db, c);
    const body = await jsonBody(c);
    let parsed;
    if (conn.type === "domain") {
      parsed = integrations.domain.parse({ resource: conn.resource, settings: { expiresOn: body.expiresOn } });
    } else if (conn.type === "site") {
      const { label, expectStatus } = conn.settings ?? {};
      parsed = integrations.site.parse({
        resource: conn.resource,
        settings: { label, expectStatus, expectText: body.expectText, expectJson: body.expectJson, slowMs: body.slowMs, slowChecks: body.slowChecks },
      });
    } else {
      throw badRequest("Only a domain's expiry date and a status check's settings can be edited");
    }
    store.updateConnectionSettings(db, app, conn.id, parsed.settings ?? {});
    await watcher.checkConnection(app, { ...conn, settings: parsed.settings });
    return c.json({ ok: true });
  });

  r.delete("/apps/:slug/connections/:id", (c) => {
    const app = findApp(db, c);
    if (!store.deleteConnection(db, app, c.req.param("id")!)) {
      throw new HttpError(404, "No such connection");
    }
    return c.body(null, 204);
  });

  return r;
}

// An extra URL's name when it's given none: its path on the app's own host
// ("/health"), or its host and path elsewhere.
function shortUrl(appUrl: string, url: string): string {
  const u = new URL(url);
  let sameHost = false;
  try {
    sameHost = new URL(appUrl).host === u.host;
  } catch {}
  const shown = sameHost ? `${u.pathname}${u.search}` : `${u.host}${u.pathname === "/" ? "" : u.pathname}`;
  return shown.length > 40 ? `${shown.slice(0, 39)}…` : shown;
}
