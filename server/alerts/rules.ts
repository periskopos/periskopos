import type { AlertKind, HeldAlert, IncidentKind, Settings } from "../../shared/types.ts";

// Who gets told what: which kinds of alert I want, and what's paused. Pure, for
// the tests. Nothing here decides what's recorded: a muted or paused alert's
// incident still opens, and the bell and the app's page still show it.

export const MAX_PAUSE_MS = 48 * 60 * 60_000; // a pause always ends: it can't be forgotten for good

const KIND_OF_INCIDENT: Record<IncidentKind, AlertKind> = {
  outage: "outages",
  slow: "outages",
  deploy: "deploys",
  ci: "deploys",
  expiry: "accounts",
  dependency: "warnings",
  search: "warnings",
  errors: "warnings",
  security: "warnings",
  payments: "warnings",
  traffic: "warnings",
  spend: "warnings",
};

export const alertKindOf = (incident: IncidentKind | undefined): AlertKind => KIND_OF_INCIDENT[incident ?? "outage"];

const SWITCH: Record<AlertKind, "alertOutages" | "alertDeploys" | "alertAccounts" | "alertProviders" | "alertWarnings"> = {
  outages: "alertOutages",
  deploys: "alertDeploys",
  accounts: "alertAccounts",
  providers: "alertProviders",
  warnings: "alertWarnings",
};

export const wanted = (settings: Settings, kind: AlertKind): boolean => settings[SWITCH[kind]];

const running = (until: string | undefined, now: number) => {
  const at = until ? Date.parse(until) : NaN;
  return at > now ? until : undefined;
};

// The pause that covers an alert, if any: all alerts, or this app's.
export function pausedUntil(settings: Settings, appId: string | undefined, now: number): string | undefined {
  const all = running(settings.alertsPausedUntil, now);
  const own = appId ? running(settings.appPauses[appId], now) : undefined;
  if (all && own) return Date.parse(all) > Date.parse(own) ? all : own;
  return all ?? own;
}

// How many a pause keeps: a long one keeps only the latest.
export const HELD_KEPT = 100;

// Held alerts whose pause has ended, and those still waiting. A kind switched
// off during the pause isn't wanted any more, so it's dropped.
export function heldDue(settings: Settings, held: HeldAlert[], now: number): { due: HeldAlert[]; kept: HeldAlert[] } {
  const due: HeldAlert[] = [];
  const kept: HeldAlert[] = [];
  for (const alert of held) {
    if (pausedUntil(settings, alert.appId, now)) kept.push(alert);
    else if (!alert.kind || wanted(settings, alert.kind)) due.push(alert);
  }
  return { due, kept };
}

// One message for everything missed, whichever order it happened in: an app
// that went down and came back says both.
export function heldSummary(due: HeldAlert[]): { title: string; body: string } {
  if (due.length === 1) return { title: due[0]!.title, body: "This happened while alerts were paused." };
  const latest = due.slice(-3).map((a) => a.title);
  const rest = due.length - latest.length;
  // At the limit older ones may be gone, so the count is only a floor.
  if (due.length >= HELD_KEPT) return { title: `Over ${HELD_KEPT} alerts while paused`, body: `The latest: ${latest.join(". ")}. The bell shows what's still wrong.` };
  return { title: `${due.length} alerts while paused`, body: `${latest.join(". ")}${rest ? `. And ${rest} more.` : "."}` };
}

// A pause as asked for: nothing, or a time soon after now.
export function pauseProblem(until: unknown, now: number): string | undefined {
  if (until === "") return undefined;
  const at = typeof until === "string" ? Date.parse(until) : NaN;
  if (!(at > now)) return "A pause has to end in the future";
  if (at - now > MAX_PAUSE_MS) return "A pause can last two days at most";
  return undefined;
}
