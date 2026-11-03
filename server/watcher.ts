import type { DatabaseSync } from "node:sqlite";
import { ACCOUNTS, connectionLabel, isExtraSite } from "../shared/catalog.ts";
import { KEY_WARN_DAYS, daysLeft, duration } from "../shared/format.ts";
import type { App, CheckResult, Connection, Incident, PlanUsage, Service, ServiceType, UsageMeter } from "../shared/types.ts";
import { AUDIT_EVERY_MS, auditApp, lastAuditAt } from "./audits/audit.ts";
import type { Checks } from "./audits/audit.ts";
import { UNREADABLE_AFTER_MS } from "./alerts/notifications.ts";
import * as history from "./history.ts";
import { SERVICE_TYPES, integrations } from "./integrations/index.ts";
import { testKey } from "./keys/keys.ts";
import type { KeyResult } from "./keys/keys.ts";
import type { Notifier } from "./alerts/notify.ts";
import { PROVIDER_EVERY_MS, affects, fetchProvider, getStored, isDegraded, partsInUse, providersInUse, relevantIndicator, store_ as storeProvider } from "./providers.ts";
import type { Fetched } from "./providers.ts";
import { authFor, keyState, readSecret } from "./keys/secrets.ts";
import { getSettings } from "./settings.ts";
import { StatusService } from "./status.ts";
import * as store from "./store.ts";

// The background watcher (PRD §7.5). Every tick it:
// 1. records that it's running (watch periods, so gaps are honest — FR-W6),
// 2. checks every connection that's due and records the result,
// 3. opens an incident on the second failure in a row and closes it on the
//    first success, notifying once each way (FR-W3, FR-W4),
// 4. now and then rolls history up and prunes it (FR-W2),
// 5. once a day tests every account's key, so a revoked or expiring key is
//    news before checks start saying "unknown".

export const TICK_MS = 30_000;
// After a failure, and while down, check again this soon instead of
// waiting the app's whole interval: confirms an outage, or a recovery, fast.
export const CONFIRM_MS = 60_000;
// This many ticks in a row (5 minutes) not getting through, stuck or failing:
// the checks have stopped, and that's news in itself.
export const STOPPED_AFTER_TICKS = 10;
const MAINTENANCE_MS = 60 * 60_000;
// Checks at once against one provider, or one site's host.
export const PER_PROVIDER = 4;

const hostOf = (resource: string) => {
  try {
    return new URL(resource).host;
  } catch {
    return resource;
  }
};

// Runs fn over items, at most `limit` at a time for each key, the keys all
// at once.
export async function eachLimited<T>(items: T[], keyOf: (item: T) => string, limit: number, fn: (item: T) => Promise<unknown>): Promise<void> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  await Promise.all(
    [...groups.values()].map((queue) =>
      Promise.all(
        Array.from({ length: Math.min(limit, queue.length) }, async () => {
          for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
        }),
      ),
    ),
  );
}

// Account keys are tested daily; a test the provider couldn't answer (no
// answer, or its own error) says nothing about the key and is tried again
// sooner.
export const KEY_EVERY_MS = 24 * 60 * 60_000;
export const KEY_RETRY_MS = 60 * 60_000;
// A free plan's usage is read this often: often enough to warn hours
// before a daily limit, rarely enough to spare the provider.
export const USAGE_EVERY_MS = 30 * 60_000;
// Warned once a period at each: near the limit, and over it.
export const USAGE_NEAR = 0.8;

export type UsageLevel = "ok" | "near" | "over";
export const usageLevel = (m: UsageMeter): UsageLevel => (m.used >= m.limit ? "over" : m.used >= USAGE_NEAR * m.limit ? "near" : "ok");
const LEVELS: UsageLevel[] = ["ok", "near", "over"];

// The meters whose level went up since the last reading in the same
// period (a new day starts again from "ok").
export function usageNews(before: PlanUsage | undefined, after: UsageMeter[]): { meter: UsageMeter; level: UsageLevel }[] {
  const prior = before && "meters" in before ? before.meters : [];
  return after.flatMap((m) => {
    const level = usageLevel(m);
    const was = prior.find((p) => p.label === m.label && p.resetsAt === m.resetsAt);
    const wasLevel = was ? usageLevel(was) : "ok";
    return LEVELS.indexOf(level) > LEVELS.indexOf(wasLevel) ? [{ meter: m, level }] : [];
  });
}

export type WatcherDeps = {
  db: DatabaseSync;
  notifier: Notifier;
  baseUrl: string; // where notification clicks go, e.g. http://localhost:4100
  status?: StatusService;
  // Can this PC reach the internet? Asked only when a check fails without
  // any answer from the site.
  isOnline?: () => Promise<boolean>;
  // Reads a provider's status page; replaced in tests.
  fetchProvider?: (type: ServiceType) => Promise<Fetched>;
  // Daily configuration checks (server/audits/audit.ts), with the site and DNS
  // checks they use: on in the app (server/main.ts), off unless asked for
  // elsewhere, so a test's watcher never looks up a real domain.
  audits?: Checks;
};

// While an app isn't live yet there's no site to check: its response and
// certificate are left alone, so nothing about it can fail or alert.
export function isCheckable(app: App, conn: Connection): boolean {
  const integration = integrations[conn.type];
  return Boolean(integration?.check) && (app.live || !integration?.needsLiveApp);
}

// Marking an app not live ends the problems its site checks had open, with
// no notification: they were about a site that isn't meant to exist yet.
export function settleLiveChecks(db: DatabaseSync, app: App, at = new Date().toISOString()) {
  for (const conn of app.connections) {
    if (integrations[conn.type]?.needsLiveApp) history.closeOpenIncidents(db, conn.id, at);
  }
}

// Offline only if neither answers: one big site down or blocked here mustn't
// turn a real outage into "this PC is offline". Only a HEAD, with nothing about
// me or my apps in it. The privacy page names these: change them together.
const ONLINE_PROBES = ["https://github.com", "https://www.cloudflare.com"];

export async function defaultIsOnline(probes: readonly string[] = ONLINE_PROBES): Promise<boolean> {
  try {
    await Promise.any(probes.map((url) => fetch(url, { method: "HEAD", signal: AbortSignal.timeout(5000) })));
    return true;
  } catch {
    return false;
  }
}

export class Watcher {
  #db: DatabaseSync;
  #notifier: Notifier;
  #baseUrl: string;
  #status: StatusService;
  #isOnline: () => Promise<boolean>;
  #fetchProvider: (type: ServiceType) => Promise<Fetched>;

  #timer: ReturnType<typeof setInterval> | undefined;
  #busy = false;
  #slowRunning = false;
  #periodId: number | undefined;
  #lastBeat = 0;
  #lastMaintenance = 0;
  #offline = false;
  #missedTicks = 0;
  #lastGoodTick: number | undefined;
  #stoppedSince: string | undefined;
  // connection id → when it was last checked, and which resource that was:
  // editing an app's URL keeps the connection id but points it at a new
  // host, and the new host hasn't been checked at all.
  #lastChecked = new Map<string, { resource: string; at: number }>();
  // connection id → the first check of its current resource, when that
  // changed while running: a failure of the old host never confirms one of
  // the new host's.
  #newResourceAt = new Map<string, string>();
  // Checks running right now, so the tick and "Check now" asking at once
  // record one result between them, not one each.
  #checking = new Map<string, Promise<CheckResult | undefined>>();
  // Provider refreshes running right now: every open window asks for
  // providers, and only one fetch (and one announcement) should come of it.
  #refreshing = new Map<ServiceType, Promise<void>>();
  // Whether I've told the user about a provider's incident, so recovery is
  // announced only after an announced incident, whatever came in between
  // (maintenance, an unreadable page).
  #announced = new Map<ServiceType, boolean>();
  // account id → when its key was last tried, answered or not.
  #keyTriedAt = new Map<string, number>();
  #usageTriedAt = new Map<string, number>();
  #audits: Checks | undefined;
  constructor({ db, notifier, baseUrl, status = new StatusService(), isOnline = defaultIsOnline, fetchProvider: fetchProviderFn = fetchProvider, audits }: WatcherDeps) {
    this.#audits = audits;
    this.#db = db;
    this.#notifier = notifier;
    this.#baseUrl = baseUrl;
    this.#status = status;
    this.#isOnline = isOnline;
    this.#fetchProvider = fetchProviderFn;
  }

  start() {
    this.#timer = setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
  }

  // Since when ticks have stopped getting through, while they should be.
  get stoppedSince(): string | undefined {
    return this.#stoppedSince;
  }

  async tick(now = Date.now()) {
    if (this.#busy) {
      this.#missedTick(now);
      return;
    }
    this.#busy = true;
    let slow: Promise<void> | undefined;
    let failed = false;
    try {
      const user = store.getLocalUser(this.#db);
      // Switched off: no heartbeat, so this time shows as not watched.
      if (!user || !getSettings(this.#db, user.id).watcherEnabled) return;

      // Offline: not watching either. Look again each tick.
      if (this.#offline) {
        if (!(await this.#isOnline())) return;
        this.#offline = false;
      }
      this.#heartbeat(now);

      if (now - this.#lastMaintenance >= MAINTENANCE_MS) {
        this.#lastMaintenance = now;
        history.rollUp(this.#db, now);
        history.prune(this.#db, now);
      }

      const due: [App, Connection][] = [];
      for (const app of store.listApps(this.#db, user.id)) {
        for (const conn of app.connections) {
          if (isCheckable(app, conn) && this.#isDue(app, conn, now)) due.push([app, conn]);
        }
      }
      // Keys, free-plan usage and the daily configuration checks run beside
      // the status checks, not in front of the next ones: a slow provider
      // there never makes a check late. One round of them at a time.
      if (!this.#slowRunning) slow = this.#slowWork(user.id, now);
      // A few at a time per provider (or per site's host), so a startup with
      // everything due doesn't run into a provider's rate limit.
      await eachLimited(due, ([, conn]) => integrations[conn.type]?.serviceType ?? hostOf(conn.resource), PER_PROVIDER, ([app, conn]) => this.checkConnection(app, conn));
      await this.refreshProviders(user.id, false, now);
    } catch (err) {
      console.error("Watcher tick failed:", err);
      failed = true;
    } finally {
      this.#busy = false;
    }
    if (failed) this.#missedTick(now);
    else this.#tickWentThrough(now);
    await slow;
  }

  // Counted in ticks, not time: a PC that slept missed no ticks, and only
  // ticks that ran and couldn't get through mean the checks have stopped.
  #missedTick(now: number) {
    this.#missedTicks += 1;
    if (this.#missedTicks !== STOPPED_AFTER_TICKS) return;
    this.#stoppedSince = new Date(this.#lastGoodTick ?? now).toISOString();
    console.error(`Watcher: ${STOPPED_AFTER_TICKS} ticks in a row didn't get through`);
    void this.#announceChecks({ title: "Periskopos has stopped checking your apps", body: "What it shows may be out of date. Restarting Periskopos may clear it." });
  }

  #tickWentThrough(now: number) {
    this.#missedTicks = 0;
    this.#lastGoodTick = now;
    if (!this.#stoppedSince) return;
    this.#stoppedSince = undefined;
    void this.#announceChecks({ title: "Periskopos is checking your apps again", body: "Checks are running again." });
  }

  async #announceChecks(notice: { title: string; body: string }) {
    try {
      const user = store.getLocalUser(this.#db);
      if (user) await this.#announce(user.id, notice);
    } catch (err) {
      console.error("Couldn't say the checks stopped:", err);
    }
  }

  async #slowWork(userId: string, now: number) {
    this.#slowRunning = true;
    try {
      await this.checkKeys(userId, now);
      await this.checkPlanUsage(userId, now);
      if (this.#audits) await this.auditDue(userId, now);
    } catch (err) {
      console.error("Watcher's key, usage or configuration round failed:", err);
    } finally {
      this.#slowRunning = false;
    }
  }

  #heartbeat(now: number) {
    if (this.#periodId === undefined || now - this.#lastBeat > history.GAP_MS) {
      this.#periodId = history.startPeriod(this.#db, now);
    } else {
      history.heartbeat(this.#db, this.#periodId, now);
    }
    this.#lastBeat = now;
  }

  #lastCheckedAt(conn: Connection): number | undefined {
    const known = this.#lastChecked.get(conn.id);
    if (known) return known.resource === conn.resource ? known.at : undefined; // a new resource is due at once
    // Nothing remembered (just started): what's recorded is about this
    // resource, since a URL is only ever edited while the watcher runs.
    const last = history.latestCheck(this.#db, conn.id);
    if (!last) return undefined;
    this.#lastChecked.set(conn.id, { resource: conn.resource, at: Date.parse(last.at) });
    return Date.parse(last.at);
  }

  // The usual time between two checks of a connection while it's fine.
  #intervalMs(app: App, conn: Connection): number {
    return integrations[conn.type]?.everyMs ?? app.checkIntervalMin * 60_000;
  }

  #isDue(app: App, conn: Connection, now: number): boolean {
    const last = this.#lastCheckedAt(conn);
    if (last === undefined) return true;
    const fixed = integrations[conn.type]?.everyMs; // daily checks stay daily
    const [latest] = history.lastDecisiveChecks(this.#db, conn.id, 1);
    const interval = fixed ?? (latest?.state === "down" ? CONFIRM_MS : this.#intervalMs(app, conn));
    // Half a tick of slack, so a 5-minute check doesn't drift to 5.5.
    return now - last >= interval - TICK_MS / 2;
  }

  // Checks every checkable connection of one app now ("Check now").
  async checkApp(app: App, onlyUnchecked = false) {
    await Promise.all(
      app.connections
        .filter((c) => isCheckable(app, c))
        .filter((c) => !onlyUnchecked || this.#lastCheckedAt(c) === undefined)
        .map((c) => this.checkConnection(app, c)),
    );
  }

  async checkConnection(app: App, conn: Connection): Promise<CheckResult | undefined> {
    // StatusService already shares the provider call, but each caller would
    // still record the result and judge it: one failure would be counted
    // twice and confirm itself. So callers at the same moment share it all,
    // as long as they ask the same question (settings just saved are a new one).
    const key = `${conn.id} ${conn.resource} ${JSON.stringify(conn.settings ?? {})}`;
    let pending = this.#checking.get(key);
    if (!pending) {
      pending = this.#checkConnection(app, conn).finally(() => this.#checking.delete(key));
      this.#checking.set(key, pending);
    }
    return pending;
  }

  async #checkConnection(app: App, conn: Connection): Promise<CheckResult | undefined> {
    const integration = integrations[conn.type];
    if (!integration?.check || !isCheckable(app, conn)) return undefined;

    let result: CheckResult | undefined;
    if (integration.needsService) {
      const service = conn.serviceId ? store.getService(this.#db, app.ownerId, conn.serviceId) : undefined;
      result = service
        ? await this.#status.check(conn, true, authFor(service))
        : { state: "unknown", at: new Date().toISOString(), detail: "The account this connection used was removed" };
    } else {
      result = await this.#status.check(conn, true);
    }
    if (!result) return undefined;

    // No answer at all from the site: is it the site, or this PC?
    if (
      integration.incidentKind === "outage" &&
      result.state === "down" &&
      result.httpStatus === undefined &&
      !(await this.#isOnline())
    ) {
      this.#offline = true;
      result = { state: "unknown", at: result.at, detail: "This PC is offline, so this check doesn't count" };
    }

    // A check can take a while. If meanwhile the app or this connection was
    // removed, or the app marked not live yet, its answer no longer counts:
    // recording it would fail on the deleted rows, and judging it could open
    // an incident (and notify) for an app that isn't live.
    const now = store.getAppById(this.#db, app.id);
    const current = now?.connections.find((c) => c.id === conn.id);
    if (!now || !current || !isCheckable(now, current)) return undefined;

    // The connection now points somewhere new (the app's URL was edited):
    // nothing checked before this belongs to it.
    const before = this.#lastChecked.get(conn.id);
    if (before && before.resource !== conn.resource) this.#newResourceAt.set(conn.id, result.at);
    const refused = result.state === "unknown" && integration.incidentKind === "outage" && result.httpStatus !== undefined;
    const previous = refused ? history.latestCheck(this.#db, conn.id) : undefined;
    history.recordCheck(this.#db, app.id, conn.id, result);
    this.#lastChecked.set(conn.id, { resource: conn.resource, at: Date.parse(result.at) });
    if (result.state !== "unknown") await this.#track(app, conn, result);
    else if (refused) await this.#sayIfStillRefused(app, conn, result, previous?.at);
    return result;
  }

  // A site refusing the check opens no incident: it may be up for its visitors.
  // But it may be refusing them too, so once it's gone on for a while I'm told,
  // once: judged from what's recorded, so a restart doesn't say it again.
  async #sayIfStillRefused(app: App, conn: Connection, result: CheckResult, previousAt: string | undefined) {
    const since = history.unknownSince(this.#db, [app.id]).find((u) => u.connectionId === conn.id)?.since;
    if (!since || !previousAt) return;
    const longEnough = (at: string) => Date.parse(at) - Date.parse(since) >= UNREADABLE_AFTER_MS;
    if (longEnough(previousAt) || !longEnough(result.at)) return;
    const name = isExtraSite(app, conn) ? `${app.name} · ${connectionLabel(conn)}` : app.name;
    await this.#notify(app, { title: `${name} is refusing Periskopos's checks`, body: `It has answered HTTP ${result.httpStatus} for over an hour. A firewall or rate limit may be blocking only the check, or visitors too: Periskopos can't tell.` });
  }

  async #track(app: App, conn: Connection, result: CheckResult) {
    const integration = integrations[conn.type];
    const what = connectionLabel(conn);
    // An extra URL of the app (its API's /health) says which one it is.
    const name = isExtraSite(app, conn) ? `${app.name} · ${what}` : app.name;
    const words = (event: "down" | "up", reason: string, downForMs: number) =>
      integration?.notice?.(event, name, reason, downForMs) ??
      (event === "down"
        ? { title: `${app.name}: ${what} is failing`, body: reason }
        : { title: `${app.name}: ${what} is fine again`, body: `After ${duration(downForMs)}.` });

    // A slow spell is an incident of its own on the same connection: it
    // never counts as the outage, and an outage replaces it.
    const found = history.openIncidentFor(this.#db, conn.id);
    const slow = found?.kind === "slow" ? found : undefined;
    const open = slow ? undefined : found;
    if (result.state === "up") {
      if (open) {
        history.closeIncident(this.#db, open.id, result.at);
        // A short failure, then a PC asleep for three days, wasn't three days
        // down: what's said is the time actually watched, and that it's partial.
        const [from, to] = [Date.parse(open.startedAt), Date.parse(result.at)];
        const watched = history.watchedMsBetween(this.#db, from, to);
        const partial = watched > 0 && to - from - watched >= history.GAP_MS;
        const notice = words("up", open.reason, partial ? watched : to - from);
        await this.#notify(app, partial ? { ...notice, body: `${notice.body} Periskopos wasn't watching for another ${duration(to - from - watched)}, so it could have been longer or shorter.` } : notice);
      }
      await this.#trackSlow(app, conn, result, slow, name);
      return;
    }
    if (open) {
      // A certificate or domain that was about to expire and now has: that's
      // news, not more of the same. The warning ends and the expiry opens in
      // its place, so it's notified.
      const escalates = open.kind === "expiry" && result.summary === "Expired" && / expires in /.test(open.reason);
      if (!escalates) return;
      history.closeIncident(this.#db, open.id, result.at);
    }
    // One failure is only a failure: confirm with a second, unless the
    // check runs too rarely to wait (daily SSL and domain expiry).
    const needed = integration?.confirmFailures ?? 2;
    const [, previous] = history.lastDecisiveChecks(this.#db, conn.id, 2);
    if (needed > 1 && previous?.state !== "down") return;
    const since = this.#newResourceAt.get(conn.id);
    if (needed > 1 && since && previous!.at < since) return; // the old host's failure
    // The failure before only confirms this one if it was the check just
    // before it: a down check from days ago (say, before the app was parked)
    // says nothing about now, and would backdate the outage to then. The
    // next check, soon after this one, confirms it instead.
    if (needed > 1 && Date.parse(result.at) - Date.parse(previous!.at) > this.#recentMs(app, conn)) return;
    if (slow) history.closeIncident(this.#db, slow.id, result.at); // quietly: the outage is the news
    const incident: Incident = history.openIncident(this.#db, {
      appId: app.id,
      connectionId: conn.id,
      kind: integration?.incidentKind ?? "outage",
      startedAt: needed > 1 ? previous!.at : result.at,
      reason: result.detail ?? "Not responding",
    });
    await this.#notify(app, words("down", incident.reason, 0));
  }

  // How far apart two checks in a row can be and still be "in a row".
  #recentMs(app: App, conn: Connection): number {
    return Math.max(this.#intervalMs(app, conn), CONFIRM_MS) * 2 + TICK_MS;
  }

  // Slow answers, judged like failures: it takes several in a row (the
  // user's setting) to open a "slow" incident, and the first fast one
  // closes it. Only while the site answers: an outage is judged above.
  async #trackSlow(app: App, conn: Connection, result: CheckResult, open: Incident | undefined, name: string) {
    const slowness = integrations[conn.type]?.slowness?.(conn);
    if (open && !slowness) {
      history.closeIncident(this.#db, open.id, result.at); // switched off: nothing to announce
      return;
    }
    if (!slowness) return;
    const isSlow = (r: CheckResult) => r.state === "up" && r.ms !== undefined && r.ms > slowness.overMs;
    if (open) {
      if (isSlow(result)) return;
      history.closeIncident(this.#db, open.id, result.at);
      await this.#notify(app, { title: `${name} is fast again`, body: `It answers in ${result.ms} ms. It was slow for ${duration(Date.parse(result.at) - Date.parse(open.startedAt))}.` });
      return;
    }
    if (!isSlow(result)) return;
    const recent = history.lastDecisiveChecks(this.#db, conn.id, slowness.checks);
    if (recent.length < slowness.checks || !recent.every(isSlow)) return;
    const first = recent.at(-1)!;
    const since = this.#newResourceAt.get(conn.id);
    if (since && first.at < since) return; // the old host's slowness
    // In a row means recently: slow checks from before a gap don't count.
    if (Date.parse(result.at) - Date.parse(first.at) > this.#recentMs(app, conn) * (slowness.checks - 1)) return;
    const incident = history.openIncident(this.#db, {
      appId: app.id,
      connectionId: conn.id,
      kind: "slow",
      startedAt: first.at,
      reason: `Answering in ${result.ms} ms, over ${slowness.overMs} ms for ${slowness.checks} checks in a row`,
    });
    await this.#notify(app, { title: `${name} is slow`, body: incident.reason });
  }

  // Provider status pages, once per provider however many apps use it
  // (FR-I3, FR-W1). Announces a provider going degraded and recovering,
  // naming my apps that depend on it.
  async refreshProviders(ownerId: string, force: boolean, now = Date.now()) {
    for (const { type, apps, using } of providersInUse(this.#db, ownerId)) {
      // A refresh of this provider that's already running answers this one
      // too: two would fetch twice and announce the same incident twice.
      const running = this.#refreshing.get(type);
      if (running) {
        await running;
        continue;
      }
      const pending = this.#refreshProvider(ownerId, type, apps, using, force, now).finally(() => this.#refreshing.delete(type));
      this.#refreshing.set(type, pending);
      await pending;
    }
  }

  async #refreshProvider(ownerId: string, type: ServiceType, apps: { name: string }[], using: App[], force: boolean, now: number) {
    const stored = getStored(this.#db, type);
    if (!force && stored && now - Date.parse(stored.checkedAt) < PROVIDER_EVERY_MS - TICK_MS / 2) return;
    let fetched;
    try {
      fetched = await this.#fetchProvider(type);
    } catch {
      return; // the status page itself is down: keep what I knew
    }
    storeProvider(this.#db, type, fetched, new Date(now).toISOString());
    // Only trouble in the parts my apps use is news; an account no app uses
    // is shown on the Accounts page and never announced.
    if (apps.length === 0) return;
    const inUse = partsInUse(type, using);
    const relevant = relevantIndicator(fetched, inUse);
    // First look since starting: an incident already stored was announced
    // when it was stored.
    if (!this.#announced.has(type)) this.#announced.set(type, Boolean(stored && isDegraded(relevantIndicator(stored, inUse))));
    const announced = this.#announced.get(type);
    const label = ACCOUNTS[type].label;
    const names = apps.map((a) => a.name).join(", ");
    // Maintenance and "unknown" change nothing either way: degraded →
    // maintenance → normal still says it's back, and degraded → maintenance
    // → degraded doesn't announce the same trouble again.
    if (isDegraded(relevant) && !announced) {
      this.#announced.set(type, true);
      const incident = fetched.incidents.find((i) => affects(i.parts, inUse));
      const parts = incident?.parts?.length ? ` (${incident.parts.slice(0, 3).join(", ")})` : "";
      await this.#announce(ownerId, {
        title: `${label} reports an incident`,
        body: `${incident?.name ?? fetched.description}${parts}${names ? ` · affects ${names}` : ""}`,
        ...(getSettings(this.#db, ownerId).incidentAlarm ? { alarm: true as const } : {}),
      });
    } else if (relevant === "none" && announced) {
      this.#announced.set(type, false);
      await this.#announce(ownerId, { title: `${label} is back to normal`, body: names ? `Affected: ${names}` : "Its status page reports no incident." });
    }
  }

  // Every account's key that's due (daily), tested as Test on the Accounts
  // page does and stored the same way. Says so when a key that worked stops
  // working, when it works again, and once when it's about to expire.
  async checkKeys(ownerId: string, now = Date.now()) {
    const due = store.listServices(this.#db, ownerId).filter((s) => {
      if (keyState(s) === "missing") return false; // the Accounts page already asks for one
      const tested = s.lastTest ? Date.parse(s.lastTest.at) : undefined;
      const tried = this.#keyTriedAt.get(s.id);
      if (tested !== undefined && now - tested < KEY_EVERY_MS - TICK_MS / 2) return false;
      return tried === undefined || now - tried >= KEY_RETRY_MS - TICK_MS / 2;
    });
    await Promise.all(due.map((s) => this.#checkKey(s, now)));
  }

  async #checkKey(service: Service, now: number) {
    this.#keyTriedAt.set(service.id, now);
    const keyBefore = service.secretRef ? readSecret(service.secretRef) : undefined;
    const { result, transient } = await testKey(service, now);
    if (transient) return;
    // A new key pasted (or the account removed) while this one was tested:
    // the verdict is about a key that's gone, so it isn't stored or announced.
    const current = store.getService(this.#db, service.ownerId, service.id);
    if (!current || current.secretRef !== service.secretRef || (current.secretRef ? readSecret(current.secretRef) : undefined) !== keyBefore) return;
    store.setServiceLastTest(this.#db, service, result);
    const before = service.lastTest;
    const name = service.name;
    if (before?.ok && !result.ok) {
      const expired = before.expiresAt && Date.parse(before.expiresAt) <= now;
      await this.#announce(
        service.ownerId,
        {
          title: `${name}: key stopped working`,
          body: expired ? `It expired on ${before.expiresAt!.slice(0, 10)}. Make a new one and choose Change key.` : result.message,
        },
        "#/services",
      );
    } else if (before && !before.ok && result.ok) {
      await this.#announce(service.ownerId, { title: `${name}: key works again`, body: result.message }, "#/services");
    }
    if (result.ok && result.expiresAt && expiresSoon(result) && !(before?.ok && before.expiresAt === result.expiresAt && expiresSoon(before))) {
      const days = daysLeft(result.expiresAt, now);
      await this.#announce(
        service.ownerId,
        {
          title: `${name}: key expires in ${days} day${days === 1 ? "" : "s"}`,
          body: `On ${result.expiresAt.slice(0, 10)}. Make a new one and choose Change key before then.`,
        },
        "#/services",
      );
    }
  }

  // Accounts on a free plan with a limit (Cloudflare Workers): how much of
  // it is used, stored for the Accounts page, and a notification once a
  // period when it nears the limit (80%) and when it's over.
  async checkPlanUsage(ownerId: string, now = Date.now()) {
    const due = store.listServices(this.#db, ownerId).filter((s) => {
      if (s.paidPlan || !SERVICE_TYPES[s.type].planUsage || keyState(s) === "missing") return false;
      const tried = this.#usageTriedAt.get(s.id);
      return tried === undefined || now - tried >= USAGE_EVERY_MS - TICK_MS / 2;
    });
    await Promise.all(due.map((s) => this.#checkPlanUsage(s, now)));
  }

  async #checkPlanUsage(service: Service, now: number) {
    this.#usageTriedAt.set(service.id, now);
    const at = new Date(now).toISOString();
    let meters: UsageMeter[];
    try {
      meters = await SERVICE_TYPES[service.type].planUsage!(authFor(service));
    } catch (err) {
      // Kept for the Accounts page; the last good reading's level stays the
      // baseline, so a hiccup doesn't announce the same warning twice.
      const current = store.getService(this.#db, service.ownerId, service.id);
      if (current && !current.paidPlan && !(current.planUsage && "meters" in current.planUsage)) store.setServicePlanUsage(this.#db, current, { at, error: (err as Error).message });
      return;
    }
    // Switched to the paid plan (or removed) while reading: nothing to keep.
    const current = store.getService(this.#db, service.ownerId, service.id);
    if (!current || current.paidPlan) return;
    store.setServicePlanUsage(this.#db, current, { at, meters });
    const plan = ACCOUNTS[service.type].plan;
    for (const { meter, level } of usageNews(current.planUsage, meters)) {
      const pct = Math.floor((meter.used / meter.limit) * 100);
      const resets = duration(Math.max(0, Date.parse(meter.resetsAt) - now));
      await this.#announce(
        service.ownerId,
        level === "over"
          ? { title: `${service.name}: over the free plan's limit`, body: `${meter.label}: ${meter.used.toLocaleString("en")} of ${meter.limit.toLocaleString("en")}. Requests fail until it resets in ${resets}${plan ? `, or move to ${plan.paid}` : ""}.` }
          : { title: `${service.name}: ${pct}% of the free plan's limit`, body: `${meter.label}: ${meter.used.toLocaleString("en")} of ${meter.limit.toLocaleString("en")}. It resets in ${resets}.` },
        "#/services",
      );
    }
  }

  // Configuration checks, once a day per app; a couple of apps a tick, so
  // a fresh start doesn't ask every provider at once. Only a new serious
  // finding is told about: the rest waits on the app's Configuration tab.
  async auditDue(ownerId: string, now = Date.now()) {
    const due = store.listApps(this.#db, ownerId).filter((a) => {
      const last = lastAuditAt(this.#db, a.id);
      return last === undefined || now - last >= AUDIT_EVERY_MS;
    });
    for (const app of due.slice(0, 2)) {
      try {
        const { fresh } = await auditApp(this.#db, app, this.#audits);
        for (const f of fresh.filter((x) => x.severity === "high")) {
          await this.#notify(app, { title: `${app.name}: ${f.title}`, body: f.why }, "config");
        }
      } catch (err) {
        console.error(`Couldn't check ${app.name}'s configuration:`, err);
      }
    }
  }

  async #announce(ownerId: string, notice: { title: string; body: string; alarm?: true }, page = "#/") {
    if (!getSettings(this.#db, ownerId).notificationsEnabled) return;
    try {
      await this.#notifier.notify({ ...notice, url: `${this.#baseUrl}/${page}` });
      console.log(`Notified: ${notice.title}`);
    } catch (err) {
      console.error("Couldn't show a notification:", err);
    }
  }

  async #notify(app: App, notice: { title: string; body: string }, tab?: string) {
    if (!getSettings(this.#db, app.ownerId).notificationsEnabled) return;
    try {
      await this.#notifier.notify({ ...notice, url: `${this.#baseUrl}/#/apps/${encodeURIComponent(app.slug)}${tab ? `/${tab}` : ""}` });
      console.log(`Notified: ${notice.title}`);
    } catch (err) {
      console.error("Couldn't show a notification:", err);
    }
  }
}

// Was the key, when tested, within the warning window of its expiry (and
// not yet past it: then it fails, and that's the news)?
function expiresSoon(t: KeyResult): boolean {
  if (!t.expiresAt) return false;
  const days = daysLeft(t.expiresAt, Date.parse(t.at));
  return days > 0 && days <= KEY_WARN_DAYS;
}
