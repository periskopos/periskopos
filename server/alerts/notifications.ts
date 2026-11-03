import type { DatabaseSync } from "node:sqlite";
import { ACCOUNTS } from "../../shared/catalog.ts";
import { KEY_WARN_DAYS, daysLeft } from "../../shared/format.ts";
import type { App, Connection, DeliveryFailure, Incident, NotificationItem, NotificationsView, RecoveredItem, ServiceView } from "../../shared/types.ts";
import * as history from "../history.ts";
import { integrations } from "../integrations/index.ts";

// The title bar's notifications: every app with an open problem, every
// account whose key is failing or about to expire, and what recovered in
// the last day. Read from what's recorded: opening the panel never checks
// anything.

export const RECOVERED_WINDOW_MS = 24 * 60 * 60_000;

export function notificationsFor(db: DatabaseSync, apps: App[], accounts: ServiceView[], now = Date.now(), checks: ChecksHealth = {}): NotificationsView {
  const ids = apps.map((a) => a.id);
  return notificationsView(apps, history.openIncidents(db, ids), history.endedSince(db, ids, now - RECOVERED_WINDOW_MS), accounts, now, { ...checks, unreadable: history.unknownSince(db, ids) });
}

// Whether the checks themselves are running: switched off in Settings, or
// failing to get through since a given time; which connections' checks can't
// currently say; and whether I'd hear about a problem: notifications switched
// off (silent), or the last ones not reaching me (delivery).
export type ChecksHealth = { off?: boolean; stoppedSince?: string; silent?: boolean; unreadable?: { connectionId: string; since: string; detail?: string; httpStatus?: number }[]; delivery?: DeliveryFailure[] };

// A check that can't read for a while (a renamed repository, a key that lost
// a permission) never opens an incident, so left alone it would hide red CI
// or failed payments behind "all normal". A site only when it answered and
// refused (a 403, a 429), as a firewall blocking everyone is an outage nothing
// else would say: an offline PC isn't news. Not expiry dates: some domain
// endings have no lookup at all, and that isn't news.
export const UNREADABLE_AFTER_MS = 60 * 60_000;
function unreadableText(conn: Connection, since: string, detail: string | undefined, httpStatus: number | undefined, now: number): string | undefined {
  const kind = integrations[conn.type]?.incidentKind ?? "outage";
  if (kind === "expiry" || (kind === "outage" && httpStatus === undefined)) return undefined;
  const every = integrations[conn.type]?.everyMs ?? 0;
  if (now - Date.parse(since) < Math.max(UNREADABLE_AFTER_MS, 2 * every)) return undefined;
  if (kind === "outage") return detail ?? `Answered HTTP ${httpStatus}, so an outage wouldn't show`;
  const label = integrations[conn.type]?.label ?? conn.type;
  return `${label} can't be read, so a problem there wouldn't show${detail ? `: ${detail}` : ""}`;
}

// The same, from its parts (pure, for the tests).
export function notificationsView(apps: App[], open: Map<string, Incident>, ended: Incident[], accounts: ServiceView[], now = Date.now(), checks: ChecksHealth = {}): NotificationsView {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const appHref = (a: App) => `#/apps/${encodeURIComponent(a.slug)}`;

  const problems: NotificationItem[] = [];
  // A fault in the watching, not in an app, and said apart from the apps'
  // problems so the one is never read as the other.
  if (apps.some((a) => a.live)) {
    if (checks.off) {
      problems.push({ state: "attention", title: "Periskopos", watching: true, deliberate: true, text: "Background checks are off, so what's shown may be out of date", href: "#/settings" });
    } else if (checks.stoppedSince) {
      problems.push({ state: "attention", title: "Periskopos", watching: true, text: "Checks have stopped running, so what's shown may be out of date. Restarting Periskopos may clear it", href: "#/settings", since: checks.stoppedSince });
    }
    if (checks.silent) {
      problems.push({ state: "attention", title: "Periskopos", watching: true, deliberate: true, text: "Notifications are off, so you won't be told when an app goes down", href: "#/settings/notifications" });
    }
  }
  for (const f of checks.delivery ?? []) {
    const what = f.channel === "phone" ? "An alert couldn't reach your phone" : "A notification couldn't be shown on this PC";
    problems.push({ state: "attention", title: "Periskopos", watching: true, text: `${what}: ${f.message}`, href: "#/settings/notifications", since: f.at });
  }
  for (const a of apps) {
    const incident = open.get(a.id);
    if (!incident) continue;
    problems.push({ state: incident.kind === "outage" ? "down" : "attention", title: a.name, text: incident.reason, href: appHref(a), since: incident.startedAt });
  }
  const unreadable = new Map((checks.unreadable ?? []).map((u) => [u.connectionId, u]));
  for (const a of apps) {
    for (const conn of a.connections) {
      if (!a.live && integrations[conn.type]?.needsLiveApp) continue; // parked: its last answer is old news
      const u = unreadable.get(conn.id);
      const text = u && unreadableText(conn, u.since, u.detail, u.httpStatus, now);
      if (u && text) problems.push({ state: "attention", title: a.name, text, href: appHref(a), since: u.since });
    }
  }
  for (const s of accounts) {
    const problem = keyProblem(s, now) ?? planProblem(s);
    if (problem) problems.push({ state: "attention", title: s.name, text: problem, href: "#/services" });
  }
  // Down before needs-attention, then the longest-standing first.
  problems.sort((x, y) => Number(y.state === "down") - Number(x.state === "down") || (x.since ?? "").localeCompare(y.since ?? ""));

  const earlier: RecoveredItem[] = ended.flatMap((i) => {
    const a = byId.get(i.appId);
    return a && i.endedAt ? [{ title: a.name, text: i.reason, href: appHref(a), startedAt: i.startedAt, endedAt: i.endedAt }] : [];
  });
  return { now: problems, earlier, accountsRead: accounts.every((s) => keyTestedLately(s, now)) };
}

// A key whose last test passed lately: what "accounts are fine" can rest on.
// The watcher tests each one daily, so a few days allows for a PC that was off.
const KEY_TEST_FRESH_MS = 3 * 24 * 60 * 60_000;
const keyTestedLately = (s: ServiceView, now: number) => s.lastTest?.ok === true && now - Date.parse(s.lastTest.at) < KEY_TEST_FRESH_MS;

// A free plan used up: requests start failing, while everything looks up.
export function planProblem(s: ServiceView): string | undefined {
  const usage = s.planUsage;
  if (s.paidPlan || !usage || !("meters" in usage)) return undefined;
  const over = usage.meters.find((m) => m.used >= m.limit);
  return over && `${over.label}: the free plan's limit is used up (${over.used.toLocaleString()} of ${over.limit.toLocaleString()})`;
}

// What's wrong with an account's key, in a line, if anything: missing,
// failing its last test, or expiring within the warning window.
export function keyProblem(s: ServiceView, now = Date.now()): string | undefined {
  const label = ACCOUNTS[s.type].label;
  if (s.keyState === "missing") return `No ${label} key in the keys file`;
  if (s.lastTest && !s.lastTest.ok) return `The ${label} key isn't working: ${s.lastTest.message}`;
  const expiresAt = s.lastTest?.expiresAt;
  if (expiresAt) {
    const days = daysLeft(expiresAt, now);
    if (days <= 0) return `The ${label} key has expired`;
    if (days <= KEY_WARN_DAYS) return `The ${label} key expires in ${days} day${days === 1 ? "" : "s"}`;
  }
  return undefined;
}
