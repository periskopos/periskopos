import { duration } from "../../shared/format.ts";
import type { CheckResult } from "../../shared/types.ts";
import { ProviderError, getJson } from "../http.ts";
import { github } from "./github.ts";
import { described } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";

// GitHub security alerts for an app's repository: leaked secrets (secret
// scanning) and vulnerable dependencies (Dependabot). Anything serious
// needs attention: every leaked secret, and each dependency alert rated high or
// critical. Lower ones are counted, not alerted on. A repository where a
// scanner is off says so instead of failing.

const API = "https://api.github.com";
const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };
const SERIOUS = new Set(["critical", "high"]);

type DependabotAlert = {
  number: number;
  html_url: string;
  created_at: string;
  security_advisory?: { summary?: string; severity?: string };
  security_vulnerability?: { severity?: string; package?: { name?: string; ecosystem?: string } };
};
type SecretAlert = { number: number; html_url: string; created_at: string; secret_type_display_name?: string };

// A scanner that's switched off, or a token without its permission, answers
// 403 or 404: that's "not watched", not a failed check.
type Read<T> = { alerts: T[] } | { off: string };

async function read<T>(auth: ServiceAuth, path: string, what: string): Promise<Read<T>> {
  try {
    return { alerts: await getJson<T[]>(`${API}${path}`, { token: await auth.token(), headers: HEADERS, provider: "GitHub" }) };
  } catch (err) {
    if (err instanceof ProviderError && (err.status === 403 || err.status === 404)) {
      return { off: /disabled|not enabled/i.test(err.body) ? `${what} is off for this repository` : `the key can't read ${what} (it needs ${what}: Read-only)` };
    }
    throw err;
  }
}

const severityOf = (a: DependabotAlert) => (a.security_vulnerability?.severity ?? a.security_advisory?.severity ?? "unknown").toLowerCase();

// What the alerts add up to, in words.
export function securityHealth(repo: string, dep: Read<DependabotAlert>, secrets: Read<SecretAlert>, at: string): CheckResult {
  const off = [dep, secrets].flatMap((r) => ("off" in r ? [r.off] : []));
  const leaked = "alerts" in secrets ? secrets.alerts : [];
  const deps = "alerts" in dep ? dep.alerts : [];
  const serious = deps.filter((a) => SERIOUS.has(severityOf(a)));

  const counts = new Map<string, number>();
  for (const a of deps) counts.set(severityOf(a), (counts.get(severityOf(a)) ?? 0) + 1);
  const order = ["critical", "high", "moderate", "medium", "low", "unknown"];
  const tally = [...counts].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([s, n]) => `${n} ${s}`).join(", ");
  const summary = [deps.length ? `Dependabot: ${tally}` : "No open dependency alerts", leaked.length ? `${leaked.length} leaked secret${leaked.length === 1 ? "" : "s"}` : undefined, ...off.map((o) => `${o[0]!.toUpperCase()}${o.slice(1)}`)]
    .filter(Boolean)
    .join(" · ");

  if (off.length === 2) return { state: "unknown", at, detail: summary };
  if (leaked.length || serious.length) {
    const parts = [
      leaked.length ? `${leaked.length === 1 ? "A leaked secret" : `${leaked.length} leaked secrets`}: ${[...new Set(leaked.map((s) => s.secret_type_display_name ?? "secret"))].slice(0, 3).join(", ")}` : undefined,
      serious.length
        ? `${serious.length} ${serious.length === 1 ? "dependency alert" : "dependency alerts"} rated high or critical: ${[...new Set(serious.map((a) => a.security_vulnerability?.package?.name ?? a.security_advisory?.summary ?? "a package"))].slice(0, 3).join(", ")}`
        : undefined,
    ].filter(Boolean);
    const first = leaked[0] ?? serious[0]!;
    return { state: "down", at, detail: parts.join(" · "), summary, link: { url: first.html_url, label: leaked.length ? "Open the secret alert" : "Open the alert" } };
  }
  return { state: "up", at, summary, ...(deps.length ? { link: { url: `https://github.com/${repo}/security/dependabot`, label: "Dependabot alerts" } } : {}) };
}

export const githubSecurity: Integration = {
  ...described("github-security"),
  confirmFailures: 1, // a leaked secret is news the first time it's seen

  // The same repository picker as GitHub's own connection.
  parse: (input) => ({ resource: github.parse(input).resource, settings: {} }),
  listResources: github.listResources,
  resourceName: github.resourceName,
  suggestedSettings: () => ({}),

  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No GitHub account connected" };
    try {
      const [dep, secrets] = await Promise.all([
        read<DependabotAlert>(auth, `/repos/${conn.resource}/dependabot/alerts?state=open&per_page=100`, "Dependabot alerts"),
        read<SecretAlert>(auth, `/repos/${conn.resource}/secret-scanning/alerts?state=open&per_page=100`, "Secret scanning alerts"),
      ]);
      return securityHealth(conn.resource, dep, secrets, at);
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  notice(event, app, reason, downForMs) {
    if (event === "up") return { title: `${app}: security alerts cleared`, body: `Nothing serious is open any more, ${duration(downForMs)} later.` };
    return { title: reason.includes("leaked secret") ? `${app}: a secret leaked` : `${app}: a serious vulnerability`, body: reason };
  },
};
