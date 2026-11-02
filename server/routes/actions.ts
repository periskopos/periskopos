import { currentApp, listActions, listActivity, prepareAction, recordActivity, removedWhileWaiting } from "../agents/actions.ts";
import { HttpError, badRequest } from "../errors.ts";
import { generateProtocol } from "../generator.ts";
import { ProtocolError, clearProtocolCache, protocolSecretRef, protocolView, testEndpoint } from "../protocol.ts";
import { decide } from "../agents/agents.ts";
import { ANY_ASSISTANT } from "../security.ts";
import * as store from "../store.ts";
import { findApp, jsonBody, router } from "./context.ts";
import type { RouteDeps } from "./context.ts";

// What can be done to an app: its actions (PRD §7.8), from its accounts or
// its own protocol endpoint (PRD §7.6, §7.7), and the log of what was done.
export function actionRoutes({ db, approvals }: RouteDeps) {
  const r = router();

  r.get("/apps/:slug/actions", async (c) => c.json(await listActions(db, findApp(db, c))));

  // Who is asking comes from the token, never from the body. The screen
  // runs an action after its own confirm dialog; an agent's request waits
  // here until I approve it on screen (docs/AGENT-SAFETY.md §4.2).
  r.post("/apps/:slug/actions/:id", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    if (body.confirmed !== true) throw badRequest("This action must be confirmed: send confirmed: true");
    const source = c.var.role === "ui" ? "ui" : "mcp";
    const confirmName = typeof body.confirmName === "string" ? body.confirmName : undefined;
    const actionId = c.req.param("id")!;
    const agent = source === "mcp" ? (c.var.agent ?? ANY_ASSISTANT) : undefined;
    const prepared = await prepareAction(db, app, actionId, source, confirmName, agent);
    if (source === "mcp") {
      const ctx = c.var.agentCtx;
      const ruled = ctx ? decide(ctx, app.id, actionId) : { rule: "ask" as const, by: "default" as const };
      if (ruled.rule === "never") {
        const message = `${agent ?? ANY_ASSISTANT} may not run ${prepared.label} on ${app.name}: a rule in Settings → AI assistants says never. Nothing was run.`;
        recordActivity(db, { appId: app.id, actionId, label: prepared.label, source, agent, ok: false, message });
        c.set("auditOutcome", "refused by rule");
        throw new HttpError(403, message);
      }
      if (ruled.rule === "allow") {
        // A grant or a rule lets it run without asking: said in the audit
        // log, and the run is recorded as always.
        c.set("auditOutcome", ruled.by === "grant" ? "allowed by grant" : "allowed by rule");
        return c.json(await prepared.run());
      }
      const decision = await approvals.request(
        {
          appSlug: app.slug,
          appName: app.name,
          actionId,
          label: prepared.label,
          service: prepared.service,
          agent: agent ?? ANY_ASSISTANT,
          ...(ctx ? { agentId: ctx.id, appId: app.id } : {}),
        },
        c.req.raw.signal,
      );
      c.set("auditOutcome", decision);
      // The app may have been deleted while it waited: then there's nowhere
      // to record the answer, and nothing to run.
      const still = currentApp(db, app);
      if (decision !== "approved") {
        const message =
          decision === "declined"
            ? "Declined on screen. Nothing was run."
            : "Not approved on screen in time. Nothing was run.";
        if (still) recordActivity(db, { appId: app.id, actionId, label: prepared.label, source, agent, ok: false, message });
        throw new HttpError(403, message);
      }
      if (!still) throw removedWhileWaiting();
      // Approved, but the agent has already hung up: no one would hear the
      // result, so don't run it behind its back.
      if (c.req.raw.signal.aborted) {
        const message = "Approved, but the agent had stopped waiting. Nothing was run.";
        recordActivity(db, { appId: app.id, actionId, label: prepared.label, source, agent, ok: false, message });
        throw new HttpError(409, message);
      }
    }
    return c.json(await prepared.run());
  });

  r.get("/apps/:slug/activity", (c) => c.json({ activity: listActivity(db, findApp(db, c).id) }));

  // ── The app's own protocol endpoint ───────────────────────────────────

  // What the app reports about itself, read live (cached for 30 s).
  r.get("/apps/:slug/protocol", async (c) => c.json({ protocol: await protocolView(findApp(db, c)) }));

  // Generates a secret (written to .env.local) and the endpoint code. The
  // secret is in this answer once, because it has to be installed on the
  // app's side; it is never shown again and never stored in the database.
  r.post("/apps/:slug/protocol/generate", async (c) => {
    const app = findApp(db, c);
    const generated = generateProtocol(app, await jsonBody(c));
    clearProtocolCache(app);
    c.header("Cache-Control", "no-store");
    return c.json({ generated }, 201);
  });

  // Tries the endpoint with this app's secret and, if it answers, saves it.
  r.post("/apps/:slug/protocol/test", async (c) => {
    const app = findApp(db, c);
    const body = await jsonBody(c);
    try {
      const { endpoint, manifest } = await testEndpoint(app, body.endpoint);
      store.setProtocol(db, app, { endpoint, secretRef: protocolSecretRef(app.slug) });
      clearProtocolCache(app);
      return c.json({ ok: true, endpoint, manifest });
    } catch (err) {
      if (!(err instanceof ProtocolError)) throw err;
      return c.json({ ok: false, message: err.message });
    }
  });

  r.delete("/apps/:slug/protocol", (c) => {
    const app = findApp(db, c);
    store.setProtocol(db, app, null);
    clearProtocolCache(app);
    return c.body(null, 204);
  });

  return r;
}
