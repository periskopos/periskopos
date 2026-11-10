import os from "node:os";
import type { DatabaseSync } from "node:sqlite";
import { worldPerfLines } from "../shared/world-perf.ts";
import type { WorldPerf } from "../shared/world-perf.ts";
import { VERSION } from "./config.ts";
import { recentCrashes, redact } from "./crash-log.ts";
import { SCHEMA_VERSION } from "./db.ts";
import { keyState } from "./keys/secrets.ts";
import { getSettings } from "./settings.ts";
import * as store from "./store.ts";

export { recentCrashes, recordCrash, redact } from "./crash-log.ts";

// What to paste into a bug report: the version, the system, what's connected
// (by kind, never by name), how the World has run (numbers and the graphics
// card, shared/world-perf.ts), and the last problems the server ran into. Every
// line goes through `redact`, so no key, address, app name or person's name
// leaves the PC this way.

const KEEP = 50;
const problems: { at: string; text: string }[] = [];
const startedAt = Date.now();

// Something went wrong in the background: kept (the last 50) for diagnostics.
export function recordProblem(text: string, at = new Date()) {
  problems.push({ at: at.toISOString(), text: redact(text) });
  if (problems.length > KEEP) problems.splice(0, problems.length - KEEP);
}

export const recentProblems = () => [...problems];

// What the page last said about the World. Only in memory, and only ever goes out in a report.
let worldPerf: WorldPerf | null = null;
export const recordWorldPerf = (perf: WorldPerf | null) => void (worldPerf = perf);

const count = (xs: string[]) =>
  Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, n]) => (n > 1 ? `${k} ×${n}` : k))
    .join(", ");

// A problem's own words can name an app or an account ("Couldn't check Acme
// Billing's configuration"), which redact() can't know. Only what's on this PC
// knows those names, so they're taken out here.
function withoutNames(text: string, names: string[]): string {
  return names.reduce((out, name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu"), "[name]");
  }, text);
}

export function diagnostics(db: DatabaseSync, now = Date.now()): string {
  const user = store.getLocalUser(db);
  const apps = user ? store.listApps(db, user.id) : [];
  const services = user ? store.listServices(db, user.id) : [];
  const settings = user ? getSettings(db, user.id) : undefined;
  // Longest first, so "Acme Billing" goes before "Acme".
  const names = [...new Set([user?.name, ...apps.flatMap((a) => [a.name, a.slug]), ...services.map((s) => s.name)])]
    .filter((n): n is string => Boolean(n && n.trim()))
    .sort((a, b) => b.length - a.length);
  const lines = [
    `Periskopos ${VERSION} diagnostics, ${new Date(now).toISOString()}`,
    "",
    `System: ${os.platform()} ${os.release()} ${os.arch()} · Node ${process.versions.node}${process.versions.electron ? ` · Electron ${process.versions.electron}` : ""}`,
    `Server up: ${Math.round((now - startedAt) / 60_000)} min · database schema ${SCHEMA_VERSION}`,
    settings ? `Settings: watching ${settings.watcherEnabled ? "on" : "off"} · notifications ${settings.notificationsEnabled ? "on" : "off"} · AI assistants ${settings.agentAccess ? "on" : "off"}` : "Settings: no user yet",
    `Apps: ${apps.length} (${apps.filter((a) => a.live).length} live)`,
    `Connections: ${count(apps.flatMap((a) => a.connections.map((c) => c.type))) || "none"}`,
    `Accounts: ${
      services.map((s) => `${s.type} (key ${keyState(s)}${s.lastTest ? `, last test ${s.lastTest.ok ? "ok" : "failed"}` : ""})`).join(", ") || "none"
    }`,
    "",
    ...worldPerfLines(worldPerf),
    "",
    "Recent problems (newest last):",
    ...(problems.length ? problems.slice(-20).map((p) => `  ${p.at}  ${withoutNames(p.text.split("\n")[0]!, names)}`) : ["  none since the server started"]),
  ];
  const crashes = recentCrashes();
  if (crashes.length) lines.push("", "Crashes (newest last):", ...crashes.map((c) => `  ${c.at}  ${withoutNames(c.text.split("\n").slice(0, 4).join(" | "), names)}`));
  return lines.map((l) => redact(l)).join("\n") + "\n";
}
