import type { DatabaseSync } from "node:sqlite";
import { ACCOUNTS } from "../../shared/catalog.ts";
import { KEY_WARN_DAYS, daysLeft } from "../../shared/format.ts";
import type { App, Incident, NotificationItem, NotificationsView, RecoveredItem, ServiceView } from "../../shared/types.ts";
import * as history from "../history.ts";

// The title bar's notifications: every app with an open problem, every
// account whose key is failing or about to expire, and what recovered in
// the last day. Read from what's recorded: opening the panel never checks
// anything.

export const RECOVERED_WINDOW_MS = 24 * 60 * 60_000;

export function notificationsFor(db: DatabaseSync, apps: App[], accounts: ServiceView[], now = Date.now()): NotificationsView {
  const ids = apps.map((a) => a.id);
  return notificationsView(apps, history.openIncidents(db, ids), history.endedSince(db, ids, now - RECOVERED_WINDOW_MS), accounts, now);
}

// The same, from its parts (pure, for the tests).
export function notificationsView(apps: App[], open: Map<string, Incident>, ended: Incident[], accounts: ServiceView[], now = Date.now()): NotificationsView {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const appHref = (a: App) => `#/apps/${encodeURIComponent(a.slug)}`;

  const problems: NotificationItem[] = [];
  for (const a of apps) {
    const incident = open.get(a.id);
    if (!incident) continue;
    problems.push({ state: incident.kind === "outage" ? "down" : "attention", title: a.name, text: incident.reason, href: appHref(a), since: incident.startedAt });
  }
  for (const s of accounts) {
    const problem = keyProblem(s, now);
    if (problem) problems.push({ state: "attention", title: s.name, text: problem, href: "#/services" });
  }
  // Down before needs-attention, then the longest-standing first.
  problems.sort((x, y) => Number(y.state === "down") - Number(x.state === "down") || (x.since ?? "").localeCompare(y.since ?? ""));

  const earlier: RecoveredItem[] = ended.flatMap((i) => {
    const a = byId.get(i.appId);
    return a && i.endedAt ? [{ title: a.name, text: i.reason, href: appHref(a), startedAt: i.startedAt, endedAt: i.endedAt }] : [];
  });
  return { now: problems, earlier };
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
