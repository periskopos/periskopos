import type { AppStatus, ProviderStatus } from "./types.ts";

// Pure wording and counting for the Fleet, kept apart from the DOM so Node
// can test it.

export type FleetLamp = "down" | "attention" | "unknown" | "stale" | "up" | "none";

// "All normal" is only said when every app really is up: an app whose state
// isn't known (a check that couldn't run, one not yet made) is counted, not
// waved through.
// Apps that aren't live yet are on purpose and don't count: they neither
// raise an alarm nor make "All normal" untrue. With only such apps, nothing
// is live to be normal.
export function summarize(all: AppStatus[]): { state: FleetLamp; text: string } {
  const statuses = all.filter((s) => s.state !== "prelaunch");
  if (all.length > 0 && statuses.length === 0) return { state: "none", text: "Nothing live yet" };
  const down = statuses.filter((s) => s.state === "down").length;
  const attention = statuses.filter((s) => s.state === "attention").length;
  const unknown = statuses.filter((s) => s.state === "unknown").length;
  const stale = statuses.filter((s) => s.state === "stale").length;
  // Nothing to check says nothing about it: "All normal" doesn't speak for it.
  const unchecked = statuses.filter((s) => s.state === "none").length;
  const noChecks = unchecked ? `${unchecked} with no checks` : "";
  const checked = statuses.length - unchecked;
  const parts = [
    down && `${down} down`,
    attention && `${attention} need${attention === 1 ? "s" : ""} attention`,
    unknown && `${unknown} unknown`,
    stale && `${stale} with no recent data`,
  ].filter(Boolean);
  const state: FleetLamp = down ? "down" : attention ? "attention" : unknown ? "unknown" : stale ? "stale" : checked ? "up" : "none";
  if (parts.length) return { state, text: parts.join(" · ") };
  if (checked) return { state, text: noChecks ? `All normal · ${noChecks}` : "All normal" };
  return { state, text: noChecks || "No apps" };
}

// Whether "providers are fine" can be said: every status page my apps depend
// on was read, lately, and could be understood. An empty or failed read
// mustn't count as fine.
const PROVIDER_READ_FRESH_MS = 30 * 60_000;
export const providersRead = (providers: ProviderStatus[], now = Date.now()): boolean =>
  providers
    .filter((p) => p.apps.length > 0)
    .every((p) => p.relevantIndicator !== "unknown" && p.checkedAt !== undefined && now - Date.parse(p.checkedAt) < PROVIDER_READ_FRESH_MS);

// "Is my last push live?" needs a source of commits and a host: say only
// what's missing.
export function lastPushHint(hasSource: boolean, hasHost: boolean): string {
  if (hasSource && hasHost) return "checking…";
  if (hasSource) return "connect your host to see what's live";
  if (hasHost) return "connect GitHub to compare with your commits";
  return "connect GitHub and a host";
}
