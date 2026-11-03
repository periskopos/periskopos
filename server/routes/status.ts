import type { DatabaseSync } from "node:sqlite";
import type { App, AppStatus } from "../../shared/types.ts";
import { deployState } from "../deploys.ts";
import * as history from "../history.ts";
import { protocolMetrics } from "../protocol.ts";
import { listProviders } from "../providers.ts";
import { deliveryFailures, getSettings } from "../settings.ts";
import { overallState, relevantChecks, staleSince } from "../status.ts";
import * as store from "../store.ts";
import type { Watcher } from "../watcher.ts";
import { notificationsFor } from "../alerts/notifications.ts";
import { accountView, findApp, router, visible } from "./context.ts";
import type { RouteDeps } from "./context.ts";

const DAY_MS = 86_400_000;

// How every app is doing, from what the watcher recorded, and the status
// pages of the providers they use (FR-I3).
export function statusRoutes({ db, watcher }: RouteDeps) {
  const r = router();

  // ?refresh=1 checks everything now.
  r.get("/status", async (c) => {
    const statuses = await statusOf(db, watcher, visible(c, store.listApps(db, c.var.user.id)), c.req.query("refresh") === "1");
    return c.json({ statuses });
  });

  r.get("/apps/:slug/status", async (c) => {
    const [status] = await statusOf(db, watcher, [findApp(db, c)], c.req.query("refresh") === "1");
    return c.json({ status });
  });

  // The title bar's notifications: open problems, failing or expiring
  // keys, and what recovered in the last day. Reads only what's recorded.
  r.get("/notifications", (c) => {
    const accounts = store.listServices(db, c.var.user.id).map((s) => accountView(db, s));
    const stoppedSince = watcher.stoppedSince;
    const settings = getSettings(db, c.var.user.id);
    return c.json(
      notificationsFor(db, store.listApps(db, c.var.user.id), accounts, Date.now(), {
        off: !settings.watcherEnabled,
        silent: !settings.notificationsEnabled,
        ...(stoppedSince ? { stoppedSince } : {}),
        delivery: deliveryFailures(db, c.var.user.id),
      }),
    );
  });

  // ?refresh=1: read every status page now (the Status page's Check now).
  r.get("/providers", async (c) => {
    await watcher.refreshProviders(c.var.user.id, c.req.query("refresh") === "1");
    // An assistant limited to some apps hears only of those.
    const shown = new Set(visible(c, store.listApps(db, c.var.user.id)).map((a) => a.slug));
    return c.json({ providers: listProviders(db, c.var.user.id).map((p) => ({ ...p, apps: p.apps.filter((a) => shown.has(a.slug)) })) });
  });

  return r;
}

// Every check goes through the watcher, so it's recorded and counts towards
// incidents, whether it came from the timer or "Check now". Apps never
// checked yet are checked on the spot.
async function statusOf(db: DatabaseSync, watcher: Watcher, apps: App[], refresh: boolean): Promise<AppStatus[]> {
  await Promise.all(apps.map((a) => watcher.checkApp(a, !refresh)));
  const ids = apps.map((a) => a.id);
  const latest = history.latestChecks(db, ids);
  const open = history.openIncidents(db, ids);
  const now = Date.now();
  return Promise.all(
    apps.map(async (a): Promise<AppStatus> => {
      const recorded = relevantChecks(
        a.connections.flatMap((conn) => (latest.has(conn.id) ? [{ conn, result: latest.get(conn.id)! }] : [])),
        a.live,
      );
      // A not-live app has no uptime to speak of.
      const { uptimePct, watchedMs } = a.live ? history.uptime(db, a.id, now - 30 * DAY_MS, now, now) : { uptimePct: undefined, watchedMs: 0 };
      const [deploy, metrics] = await Promise.all([deployState(db, a), protocolMetrics(a)]);
      const state = overallState(recorded, a.live);
      const slow = state === "up" && open.get(a.id)?.kind === "slow";
      const since = a.live ? staleSince(recorded, a.checkIntervalMin, now) : undefined;
      return {
        slug: a.slug,
        // Answering, but slow for a while: something to look at, not an outage.
        // Only "up" goes stale: a problem stays on show until a check clears it.
        state: slow ? "attention" : state === "up" && since ? "stale" : state,
        ...(since ? { staleSince: since } : {}),
        checks: Object.fromEntries(recorded.map(({ conn, result }) => [conn.id, result])),
        ...(open.has(a.id) ? { incident: open.get(a.id)! } : {}),
        ...(uptimePct !== undefined ? { uptime30d: uptimePct, uptimeWatchedMs: watchedMs } : {}),
        ...(deploy ? { deploy } : {}),
        ...(metrics?.length ? { metrics } : {}),
      };
    }),
  );
}
