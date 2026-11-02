import { auditApp, configReport, setIgnored } from "../audits/audit.ts";
import { HttpError, badRequest } from "../errors.ts";
import { findApp, jsonBody, router } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// An app's configuration checks (server/audits/audit.ts): what was found, checking
// again now, and ignoring a finding that's fine as it is.
export function configRoutes({ db }: RouteDeps) {
  const r = router();

  r.get("/apps/:slug/config", (c) => c.json({ report: configReport(db, findApp(db, c)) }));

  r.post("/apps/:slug/config/check", async (c) => {
    const { report } = await auditApp(db, findApp(db, c));
    return c.json({ report });
  });

  r.patch("/apps/:slug/config/findings/:id", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    if (typeof body.ignored !== "boolean") throw badRequest("Say whether it's ignored: ignored true or false");
    if (!setIgnored(db, app.id, c.req.param("id")!, body.ignored)) throw new HttpError(404, "No such finding");
    return c.json({ report: configReport(db, app) });
  });

  return r;
}
