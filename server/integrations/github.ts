import { duration } from "../../shared/format.ts";
import type { AuditResult, CheckResult, CiRun, Commit, Connection, FailureLog, FindingDraft } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError, getJson, getJsonFresh, getText } from "../http.ts";
import { requiredText, text } from "../validate.ts";
import { described } from "./types.ts";
import type { BuildCheck, Integration, KeyTest, ServiceAuth } from "./types.ts";

const API = "https://api.github.com";
// Pages of 100 repos read for the picker: 1,000 repos is plenty.
const REPO_PAGES = 10;
const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" };

type GhRepo = { full_name: string; private: boolean; default_branch: string; pushed_at: string | null };
type GhCommit = { sha: string; html_url: string; commit: { message: string; committer: { date: string } | null } };
type GhRun = {
  id: number;
  name: string | null;
  workflow_id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  created_at: string;
  html_url: string;
  path?: string;
};

async function gh<T>(auth: ServiceAuth, path: string): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), headers: HEADERS, provider: "GitHub" });
}

// A fine-grained token's expiry, from the github-authentication-token-expiration
// header: "2026-11-01 12:00:00 UTC" or "2026-11-01 12:00:00 -0800". Tokens
// without an expiry (and the gh login) send none.
export function tokenExpiry(header: string | null): string | undefined {
  const m = header?.trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return undefined;
  const zone = !m[3] || m[3] === "UTC" || m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d{2}):?(\d{2})$/, "$1:$2");
  const at = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

const settingsOf = (conn: Connection) => ({
  branch: String(conn.settings?.branch ?? "main"),
  paths: Array.isArray(conn.settings?.paths) ? (conn.settings.paths as string[]) : [],
});

const enc = encodeURIComponent;
// A commit's first line, at most 120 characters: a longer one ends in "…",
// so a cut message reads as cut, not as one that stops mid-word.
export const firstLine = (message: string) => {
  const line = message.split("\n")[0] ?? "";
  return line.length > 120 ? `${line.slice(0, 119).trimEnd()}…` : line;
};

const toCommit = (c: GhCommit): Commit => ({
  sha: c.sha,
  message: firstLine(c.commit.message),
  at: c.commit.committer?.date ?? "",
  url: c.html_url,
});

// Commits on the branch that touch the app's folders, newest first.
async function commits(conn: Connection, auth: ServiceAuth, perPath = 10): Promise<Commit[]> {
  const { branch, paths } = settingsOf(conn);
  const lists = await Promise.all(
    (paths.length ? paths : [undefined]).map((p) =>
      gh<GhCommit[]>(
        auth,
        `/repos/${conn.resource}/commits?sha=${enc(branch)}&per_page=${perPage(perPath)}${p ? `&path=${enc(p)}` : ""}`,
      ),
    ),
  );
  const bySha = new Map<string, Commit>();
  for (const c of lists.flat()) bySha.set(c.sha, toCommit(c));
  return [...bySha.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, perPath);
}
const perPage = (n: number) => Math.min(100, Math.max(1, n));

function runState(r: GhRun): CiRun["state"] {
  if (r.status !== "completed") return "running";
  if (r.conclusion === "success") return "passing";
  if (r.conclusion && ["failure", "timed_out", "startup_failure"].includes(r.conclusion)) return "failing";
  return "other"; // cancelled, skipped, neutral
}

const toRun = (r: GhRun): CiRun => ({
  id: r.id,
  name: r.name ?? `Workflow ${r.workflow_id}`,
  state: runState(r),
  ...(r.conclusion ? { conclusion: r.conclusion } : {}),
  sha: r.head_sha,
  at: r.created_at,
  url: r.html_url,
});

// Dependabot's own jobs are listed with a repo's workflow runs, but they say
// nothing about the code: one fails when it can't make an update, and stays the
// newest run of its "workflow" until its next run, often a week later. Other jobs
// GitHub runs by itself, like a Pages deployment, can be a real problem and stay.
const isDependabotJob = (r: GhRun) => r.path?.startsWith("dynamic/dependabot/") === true;

async function runs(conn: Connection, auth: ServiceAuth): Promise<GhRun[]> {
  const { branch } = settingsOf(conn);
  // The most a page holds: a batch of Dependabot jobs can fill a shorter list and
  // leave no real CI run in it.
  const { workflow_runs } = await gh<{ workflow_runs: GhRun[] }>(
    auth,
    `/repos/${conn.resource}/actions/runs?branch=${enc(branch)}&per_page=100`,
  );
  return workflow_runs.filter((r) => !isDependabotJob(r));
}

// The newest finished run of each workflow: what "CI on main" means right
// now. A run still queued or going has no verdict yet, so it neither clears
// a failure (no false "CI is passing again") nor hides one.
export function latestPerWorkflow(list: GhRun[]): GhRun[] {
  const seen = new Set<number>();
  return list.filter((r) => runState(r) !== "running" && !seen.has(r.workflow_id) && seen.add(r.workflow_id));
}

const ago = (iso: string) => `${duration(Date.now() - Date.parse(iso))} ago`;

// ── Builds other services record as check runs ─────────────────────────
// Cloudflare Workers Builds posts a check run named "Workers Builds:
// <worker>" on each commit it builds. In a monorepo it only builds commits
// in the Worker's folders, which is why these are read from the app's own
// commits (branch + paths), never just the branch head.

type GhCheckRun = {
  id: number;
  name: string;
  head_sha: string;
  status: string; // queued, in_progress, completed…
  conclusion: string | null;
  completed_at?: string | null;
  details_url: string | null;
  html_url: string | null;
  app?: { slug?: string } | null;
};

const WORKERS_BUILDS_APP = "cloudflare-workers-and-pages";
const WORKERS_BUILDS = "Workers Builds: ";
// The most commits whose checks are read: one GitHub call each, cached.
const CHECK_COMMITS = 10;

// Every run of every check on a commit, newest first. By default GitHub
// shows only the latest run of each name, and Workers Builds can build one
// commit twice: the first build deploys it, and the second ends as a
// "failure" that deploys nothing. The latest alone would call a live commit
// failed. Unfiltered by name, so every
// caller shares one cached answer per commit.
async function checkRuns(conn: Connection, auth: ServiceAuth, sha: string): Promise<GhCheckRun[]> {
  const { check_runs } = await gh<{ check_runs: GhCheckRun[] }>(auth, `/repos/${conn.resource}/commits/${enc(sha)}/check-runs?filter=all&per_page=100`);
  return check_runs ?? [];
}

// One run per check name, the one that says how the commit's build went: a
// success if any run had one (that build went live, whatever ran after
// it), else the newest finished run, else the newest. Workers Builds posts a
// build's start and its end as two runs, and the start's is never closed.
export function verdictRuns<R extends Pick<GhCheckRun, "name" | "status" | "conclusion">>(runs: R[]): R[] {
  const byName = new Map<string, R>();
  for (const r of runs) {
    const best = byName.get(r.name);
    if (!best || (succeeded(r) && !succeeded(best)) || (best.status !== "completed" && r.status === "completed" && !succeeded(best))) byName.set(r.name, r);
  }
  return [...byName.values()];
}

const isWorkersBuild = (r: GhCheckRun) => r.name.startsWith(WORKERS_BUILDS) && (!r.app?.slug || r.app.slug === WORKERS_BUILDS_APP);
const succeeded = (r: Pick<GhCheckRun, "status" | "conclusion">) => r.status === "completed" && r.conclusion === "success";
const buildFailed = (r: Pick<GhCheckRun, "status" | "conclusion">) =>
  r.status === "completed" && !!r.conclusion && ["failure", "timed_out", "startup_failure"].includes(r.conclusion);

// Failed Workers Builds on the app's newest commits, in words, each with
// its page on Cloudflare's dashboard. The newest
// build that finished decides for each Worker: one still running neither
// clears a failure nor hides one, and a cancelled one fixes nothing (as with
// deploys). Costs one call when the newest commit has no such check (a repo
// Cloudflare doesn't build), so every GitHub connection can afford it.
type FailedBuild = { reason: string; url?: string };
async function failedWorkersBuilds(conn: Connection, auth: ServiceAuth, latest: Commit | undefined): Promise<FailedBuild[]> {
  if (!latest) return [];
  const newest = verdictRuns((await checkRuns(conn, auth, latest.sha)).filter(isWorkersBuild));
  if (newest.length === 0) return [];
  const verdicts = new Map<string, { failed: boolean; sha: string; url?: string }>();
  const pending = new Set(newest.map((r) => r.name));
  const judge = (sha: string, runs: GhCheckRun[]) => {
    for (const r of runs) {
      if (!pending.has(r.name) || !(succeeded(r) || buildFailed(r))) continue;
      const url = r.details_url ?? r.html_url ?? undefined;
      verdicts.set(r.name, { failed: buildFailed(r), sha, ...(url ? { url } : {}) });
      pending.delete(r.name);
    }
  };
  judge(latest.sha, newest);
  if (pending.size) {
    for (const c of (await commits(conn, auth, CHECK_COMMITS)).filter((c) => c.sha !== latest.sha)) {
      judge(c.sha, verdictRuns((await checkRuns(conn, auth, c.sha)).filter(isWorkersBuild)));
      if (!pending.size) break;
    }
  }
  return [...verdicts]
    .filter(([, v]) => v.failed)
    .map(([name, v]) => ({ reason: `Cloudflare's build of ${name.slice(WORKERS_BUILDS.length)} failed on ${v.sha.slice(0, 7)}`, ...(v.url ? { url: v.url } : {}) }));
}

// ── Why CI failed: the end of each failed job's log ────────────────────

type GhJob = {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  steps?: { name: string; status: string; conclusion: string | null }[];
};

// How much of a failed job's log an assistant is given: the end, where the
// error is, and no more than a few jobs (each log is one more call).
export const LOG_LINES = 150;
const LOG_JOBS = 3;

// A job's log as plain lines, ending where it failed. GitHub stamps every
// line with its time and colours some, and after the failure come the
// clean-up steps: none of that says why it failed. GitHub writes the
// failure itself as "##[error]…", so the tail ends at the last one.
export function logTail(raw: string, lines = LOG_LINES): string {
  const all = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .split("\n")
    .map((l) => l.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "").slice(0, 500));
  const lastError = all.findLastIndex((l) => l.startsWith("##[error]"));
  const kept = lastError >= 0 ? all.slice(0, lastError + 1) : all;
  while (kept.length && kept.at(-1)!.trim() === "") kept.pop();
  return kept.slice(-lines).join("\n");
}

async function failedJobs(conn: Connection, auth: ServiceAuth, run: GhRun): Promise<GhJob[]> {
  const { jobs } = await gh<{ jobs: GhJob[] }>(auth, `/repos/${conn.resource}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`);
  return (jobs ?? []).filter(buildFailed);
}

async function jobLog(conn: Connection, auth: ServiceAuth, job: GhJob): Promise<{ log: string } | { logProblem: string }> {
  try {
    const raw = await getText(`${API}/repos/${conn.resource}/actions/jobs/${job.id}/logs`, { token: await auth.token(), headers: HEADERS, provider: "GitHub" });
    return { log: logTail(raw) };
  } catch (err) {
    return { logProblem: `Couldn't read the log: ${(err as Error).message}` };
  }
}

// ── Configuration checks ───────────────────────────────────────────────
// How the repository is set up around the app's branch: is it protected,
// are leaked secrets and vulnerable dependencies caught, and what can a
// workflow's token do. Most of these settings need Administration: Read,
// which the setup guide doesn't ask for: without it, the check says what it
// couldn't see instead of guessing. Rulesets need only Metadata, so a
// ruleset protecting the branch is seen either way.

type GhRepoSettings = {
  private: boolean;
  security_and_analysis?: {
    secret_scanning?: { status?: string };
    secret_scanning_push_protection?: { status?: string };
  } | null;
};
type GhProtection = {
  allow_force_pushes?: { enabled?: boolean };
  required_pull_request_reviews?: unknown;
  required_status_checks?: unknown;
};
type GhRule = { type: string };

// Settings change rarely and the check runs daily: a short cache is plenty.
const AUDIT_TTL_MS = 5 * 60_000;
// Rule types that keep pushes to a branch in check; "creation" and the
// naming patterns don't.
const PROTECTING_RULES = new Set(["pull_request", "required_status_checks", "non_fast_forward", "update", "deletion", "merge_queue", "required_deployments", "workflows", "code_scanning"]);

type Answer<T> = { ok: true; value: T } | { ok: false; status: number; body: string };
// A read that may be refused: the refusal is an answer (which permission is
// missing, whether a feature is off), but an unreachable GitHub isn't.
async function answer<T>(read: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await read() };
  } catch (err) {
    if (err instanceof ProviderError && err.status >= 400 && err.status < 500) return { ok: false, status: err.status, body: err.body };
    throw err;
  }
}

async function auditRepo(conn: Connection, auth: ServiceAuth): Promise<AuditResult> {
  const repo = conn.resource;
  const { branch } = settingsOf(conn);
  const b = enc(branch);
  const token = await auth.token();
  const read = <T>(path: string) => answer(() => getJson<T>(`${API}${path}`, { token, headers: HEADERS, provider: "GitHub", ttlMs: AUDIT_TTL_MS }));
  // On (204, no body) or off (404): not JSON, so read as text.
  const vulnerabilityAlerts = answer(() => getText(`${API}/repos/${repo}/vulnerability-alerts`, { token, headers: HEADERS, provider: "GitHub" }));

  const [info, rules, protection, alerts, securityFixes, workflow] = await Promise.all([
    getJson<GhRepoSettings>(`${API}/repos/${repo}`, { token, headers: HEADERS, provider: "GitHub", ttlMs: AUDIT_TTL_MS }),
    read<GhRule[]>(`/repos/${repo}/rules/branches/${b}?per_page=100`),
    read<GhProtection>(`/repos/${repo}/branches/${b}/protection`),
    vulnerabilityAlerts,
    read<{ enabled: boolean; paused?: boolean }>(`/repos/${repo}/automated-security-fixes`),
    read<{ default_workflow_permissions: string }>(`/repos/${repo}/actions/permissions/workflow`),
  ]);

  const findings: FindingDraft[] = [];
  const notes: string[] = [];
  const unseen: string[] = []; // what Administration: Read would show
  const isPublic = !info.private;
  const settings = (page: string, label: string) => ({ url: `https://github.com/${repo}/settings/${page}`, label });

  // Branch protection: a classic rule or a ruleset, either counts.
  const ruleTypes = new Set(rules.ok ? rules.value.map((r) => r.type) : []);
  const byRuleset = [...ruleTypes].some((t) => PROTECTING_RULES.has(t));
  const classic = protection.ok ? protection.value : undefined;
  const classicKnown = protection.ok || (protection.status === 404 && /branch not protected/i.test(protection.body));
  const notOnPlan = !protection.ok && protection.status === 403 && /upgrade to github pro|make this repository public/i.test(protection.body);
  // On GitHub Free a private repository has no rulesets either: the plan
  // note below says it once, not a refusal as well.
  if (!rules.ok && !notOnPlan) notes.push(`Couldn't read the rulesets for ${branch} (GitHub answered ${rules.status})`);
  if (!classicKnown && !notOnPlan && !byRuleset) unseen.push(`branch protection on ${branch}`);

  if (!classic && !byRuleset) {
    if (notOnPlan) {
      notes.push(`GitHub Free doesn't protect branches of private repositories, so ${branch} can't be protected on this plan`);
    } else if (classicKnown) {
      findings.push({
        key: `branch-protection:${branch}`,
        severity: isPublic ? "high" : "medium",
        title: `${branch} isn't protected`,
        why: `Anyone who can push to ${repo} can push straight to ${branch}, force-push over its history or delete it, and that's the branch your app deploys from.${isPublic ? " The repository is public, so a leaked token or a careless collaborator goes straight to production." : ""}`,
        fix: {
          steps: `On GitHub, open the repository's Settings → Rules → Rulesets → New ruleset → New branch ruleset. Name it, set Enforcement status to Active, under Target branches click Add target → Include by pattern and enter ${branch}, then tick Restrict deletions, Block force pushes and Require a pull request before merging. Click Create.`,
          link: settings("rules", "Open the repository's rulesets"),
        },
      });
    }
  } else {
    // Each of these is known when a ruleset settles it, or the classic rule
    // could be read.
    const blocksForce = ruleTypes.has("non_fast_forward") || ruleTypes.has("update") || (!!classic && classic.allow_force_pushes?.enabled !== true);
    if (!blocksForce && classicKnown) {
      findings.push({
        key: `force-push:${branch}`,
        severity: "low",
        title: `Force pushes to ${branch} are allowed`,
        why: `A force push can rewrite or wipe ${branch}'s history, and with it what's deployed. Its protection lets anyone with push access do it.`,
        fix: {
          steps: classic
            ? `On GitHub, open Settings → Branches, click Edit on the rule for ${branch}, untick Allow force pushes, and click Save changes.`
            : `On GitHub, open Settings → Rules → Rulesets, open the ruleset for ${branch}, tick Block force pushes, and click Save changes.`,
          link: classic ? settings("branches", "Open branch protection") : settings("rules", "Open the repository's rulesets"),
        },
      });
    }
    const needsPr = ruleTypes.has("pull_request") || !!classic?.required_pull_request_reviews;
    if (!needsPr && (classicKnown || ruleTypes.has("pull_request"))) {
      findings.push({
        key: `pr-required:${branch}`,
        severity: "low",
        title: `Changes to ${branch} don't need a pull request`,
        why: `Commits can land on ${branch} without going through a pull request, so nothing (no review, no checks) stands between a push and a deploy.`,
        fix: {
          steps: classic
            ? `On GitHub, open Settings → Branches, click Edit on the rule for ${branch}, tick Require a pull request before merging (approvals can stay at 0 if you work alone), and click Save changes.`
            : `On GitHub, open Settings → Rules → Rulesets, open the ruleset for ${branch}, tick Require a pull request before merging (approvals can stay at 0 if you work alone), and click Save changes.`,
          link: classic ? settings("branches", "Open branch protection") : settings("rules", "Open the repository's rulesets"),
        },
      });
    }
    const needsChecks = ruleTypes.has("required_status_checks") || !!classic?.required_status_checks;
    if (!needsChecks && (classicKnown || ruleTypes.has("required_status_checks"))) {
      findings.push({
        key: `status-checks:${branch}`,
        severity: "low",
        title: `${branch} doesn't require CI to pass`,
        why: `A change can be merged into ${branch} while its CI is failing or still running, and go live broken.`,
        fix: {
          steps: classic
            ? `On GitHub, open Settings → Branches, click Edit on the rule for ${branch}, tick Require status checks to pass before merging, add your CI jobs, and click Save changes.`
            : `On GitHub, open Settings → Rules → Rulesets, open the ruleset for ${branch}, tick Require status checks to pass, add your CI jobs, and click Save changes.`,
          link: classic ? settings("branches", "Open branch protection") : settings("rules", "Open the repository's rulesets"),
        },
      });
    }
  }

  // Secret scanning: free, and what catches a key committed by mistake, on
  // public repositories. GitHub shows these only to admins.
  if (isPublic) {
    const sa = info.security_and_analysis;
    if (!sa) unseen.push("secret scanning");
    else {
      const security = settings("security_analysis", "Open the repository's security settings");
      if (sa.secret_scanning?.status === "disabled") {
        findings.push({
          key: "secret-scanning",
          severity: "medium",
          title: "Secret scanning is off",
          why: "The repository is public, and nothing tells you when a password or API key is committed to it. Bots scrape public repositories for keys within minutes.",
          fix: { steps: "On GitHub, open the repository's Settings → Advanced Security (Code security on older accounts), and click Enable next to Secret Protection (Secret scanning).", link: security },
        });
      }
      if (sa.secret_scanning_push_protection?.status === "disabled") {
        findings.push({
          key: "push-protection",
          severity: "medium",
          title: "Push protection is off",
          why: "The repository is public, and GitHub doesn't stop a push that contains a key. Once pushed, a key is public and has to be replaced.",
          fix: { steps: "On GitHub, open the repository's Settings → Advanced Security (Code security on older accounts), and click Enable next to Push protection.", link: security },
        });
      }
    }
  }

  // Dependabot alerts: 204 on, 404 off.
  const alertsOff = !alerts.ok && alerts.status === 404;
  if (!alerts.ok && !alertsOff) unseen.push("Dependabot alerts");
  if (alertsOff) {
    findings.push({
      key: "dependabot-alerts",
      severity: "medium",
      title: "Dependabot alerts are off",
      why: "When a package the app depends on has a known vulnerability, GitHub won't tell you.",
      fix: {
        steps: "On GitHub, open the repository's Settings → Advanced Security (Code security on older accounts), and click Enable next to Dependabot alerts. Enable Dependabot security updates there too, so fixes come as pull requests.",
        link: settings("security_analysis", "Open the repository's security settings"),
      },
    });
  }

  // Security updates: no answer (404) is off too. Not said again when the
  // alerts are off: that finding's fix turns both on.
  const fixesOff = securityFixes.ok ? !securityFixes.value.enabled : securityFixes.status === 404;
  if (!securityFixes.ok && securityFixes.status !== 404) unseen.push("Dependabot security updates");
  if (fixesOff && !alertsOff) {
    findings.push({
      key: "dependabot-security-updates",
      severity: "low",
      title: "Dependabot security updates are off",
      why: "When a dependency has a known vulnerability, you have to find and apply the fix yourself; with security updates on, Dependabot opens a pull request with it.",
      fix: {
        steps: "On GitHub, open the repository's Settings → Advanced Security (Code security on older accounts), and click Enable next to Dependabot security updates.",
        link: settings("security_analysis", "Open the repository's security settings"),
      },
    });
  }

  // The GITHUB_TOKEN every workflow run gets.
  if (!workflow.ok) unseen.push("workflow permissions");
  else if (workflow.value.default_workflow_permissions === "write") {
    findings.push({
      key: "workflow-token-write",
      severity: "medium",
      title: "Workflows get write access by default",
      why: "Every workflow run's GITHUB_TOKEN can push code, edit releases and change issues, whether it needs to or not. A compromised action or dependency in any workflow gets the same.",
      fix: {
        steps: "On GitHub, open the repository's Settings → Actions → General, under Workflow permissions choose Read repository contents and packages permissions, and click Save. A workflow that needs more can ask for it with a permissions: block.",
        link: settings("actions", "Open the repository's Actions settings"),
        code: "permissions:\n  contents: write # only in a workflow that pushes",
      },
    });
  }

  if (unseen.length) notes.push(`Add Administration: Read to the GitHub token to check ${listOf(unseen)}`);
  return { findings, notes };
}

const listOf = (items: string[]) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export const github: Integration = {
  ...described("github"),

  // "owner/star-map" goes by "star-map"; connected on its default branch,
  // the whole repository until folders are chosen.
  resourceName: (r) => r.id.split("/")[1] ?? r.id,
  suggestedSettings: (_app, r) => ({ branch: r.settings?.branch ?? "main", paths: "" }),

  parse({ resource, settings }) {
    const repo = requiredText(resource, "Repository", 200);
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw badRequest("Repository must look like owner/name");
    const s = (settings ?? {}) as Record<string, unknown>;
    const branch = text(s.branch, "Branch", { max: 200, optional: true }) ?? "main";
    if (!/^[\w./-]+$/.test(branch) || branch.includes("..")) throw badRequest("That isn't a valid branch name");
    const rawPaths = Array.isArray(s.paths) ? s.paths : typeof s.paths === "string" ? s.paths.split(",") : [];
    const paths = rawPaths
      .map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    if (paths.some((p) => p.split("/").includes("..") || p.length > 200)) throw badRequest("Paths must be folders inside the repository");
    if (paths.length > 10) throw badRequest("At most 10 paths");
    return { resource: repo, settings: { branch, paths } };
  },

  async testService(auth): Promise<KeyTest> {
    const { body: user, headers } = await getJsonFresh<{ login: string }>(`${API}/user`, { token: await auth.token(), headers: HEADERS, provider: "GitHub" });
    const expiresAt = tokenExpiry(headers.get("github-authentication-token-expiration"));
    return { message: `Connected as ${user.login}`, ...(expiresAt ? { expiresAt } : {}) };
  },

  async listResources(auth) {
    // GitHub gives at most 100 repos a page: keep asking until a page comes
    // back short, up to a cap so a huge organisation can't stall the picker.
    const repos: GhRepo[] = [];
    for (let page = 1; page <= REPO_PAGES; page++) {
      const batch = await gh<GhRepo[]>(auth, `/user/repos?per_page=100&page=${page}&sort=pushed&affiliation=owner,collaborator,organization_member`);
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    return repos.map((r) => ({
      id: r.full_name,
      label: r.full_name,
      detail: [r.private ? "private" : "public", r.pushed_at && `pushed ${ago(r.pushed_at)}`].filter(Boolean).join(" · "),
      settings: { branch: r.default_branch, paths: [] },
    }));
  },

  async latestCommit(conn, auth) {
    return (await commits(conn, auth, 1))[0];
  },

  commitUrl: (conn, sha) => `https://github.com/${conn.resource}/commit/${sha}`,

  async contains(conn, auth, head, base) {
    if (head === base) return true;
    const { status } = await gh<{ status: string }>(auth, `/repos/${conn.resource}/compare/${enc(base)}...${enc(head)}`);
    return status === "ahead" || status === "identical";
  },

  async sameContent(conn, auth, a, b) {
    if (a === b) return true;
    const { files } = await gh<{ files?: { filename: string }[] }>(auth, `/repos/${conn.resource}/compare/${enc(a)}...${enc(b)}`);
    // GitHub lists at most 300 changed files: past that, never call them the same.
    if (!files || files.length >= 300) return false;
    const { paths } = settingsOf(conn);
    const inPaths = (f: string) => !paths.length || paths.some((p) => f === p || f.startsWith(`${p.replace(/\/$/, "")}/`));
    return !files.some((f) => inPaths(f.filename));
  },

  async buildChecks(conn, auth, checkName) {
    // Newest first, one call per commit, stopping at the first success:
    // usually that's the newest commit, so one call.
    const out: BuildCheck[] = [];
    for (const c of await commits(conn, auth, CHECK_COMMITS)) {
      const [run] = verdictRuns((await checkRuns(conn, auth, c.sha)).filter((r) => r.name === checkName));
      if (!run) continue;
      out.push({
        sha: c.sha,
        message: c.message,
        at: c.at,
        status: run.status,
        ...(run.conclusion ? { conclusion: run.conclusion } : {}),
        ...(run.completed_at ? { completedAt: run.completed_at } : {}),
        url: run.details_url ?? run.html_url ?? `https://github.com/${conn.resource}/commit/${c.sha}`,
      });
      if (succeeded(run)) break;
    }
    return out;
  },

  // Up unless CI's newest run of some workflow failed on the branch, or
  // Cloudflare's newest build of a Worker from it failed.
  //
  // Why failed Workers Builds count here: a Worker's own check only has the
  // Cloudflare key, and Cloudflare's deployments list only builds that went
  // live (its Builds API needs an Edit permission). The build's outcome is
  // on GitHub, so this check sees it, and it opens a "ci" incident: the
  // site still serves the last good version, so it's never an outage, and
  // the notification says which build failed.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No GitHub service connected" };
    const { branch } = settingsOf(conn);
    try {
      const [latest, all] = await Promise.all([this.latestCommit!(conn, auth), runs(conn, auth)]);
      // A token that can't read checks still gets its CI verdict.
      let buildsUnread = false;
      const builds = await failedWorkersBuilds(conn, auth, latest).catch((): FailedBuild[] => {
        buildsUnread = true;
        return [];
      });
      const current = latestPerWorkflow(all);
      const failing = current.filter((r) => runState(r) === "failing");
      const running = all.some((r) => runState(r) === "running");
      const change = latest ? `latest change ${latest.sha.slice(0, 7)} ${ago(latest.at)}` : "no commits";
      if (failing.length || builds.length) {
        const names = failing.map((r) => r.name ?? "a workflow").join(", ");
        // A workflow called "CI" isn't named twice: "CI failing on main".
        const ci = /^ci$/i.test(names) ? `CI failing on ${branch}` : `CI failing on ${branch}: ${names}`;
        const reasons = [...(failing.length ? [ci] : []), ...builds.map((b) => b.reason)];
        // One click to why: the failing run on GitHub, or the failed build.
        const run = failing.find((r) => r.html_url);
        const build = builds.find((b) => b.url);
        const link = run ? { url: run.html_url!, label: "Open the failed run on GitHub" } : build ? { url: build.url!, label: "Open the failed build on Cloudflare" } : undefined;
        return { state: "down", at, detail: reasons.join("; "), summary: `${failing.length ? "CI failing" : "Cloudflare build failed"} · ${change}`, ...(link ? { link } : {}) };
      }
      // Only runs still going, none finished to judge by: no verdict yet.
      if (current.length === 0 && running) return { state: "unknown", at, detail: "CI is running; no run has finished yet", summary: `CI running · ${change}` };
      const ci = current.length === 0 ? "No CI" : running ? "CI running" : "CI passing";
      // "Passing" shouldn't vouch for builds it couldn't read.
      return { state: "up", at, summary: `${ci} · ${change}${buildsUnread ? " · builds couldn't be read" : ""}` };
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  // The failures check() reports, with the end of each failed job's log.
  async failureLog(conn, auth): Promise<FailureLog> {
    const { branch } = settingsOf(conn);
    const [latest, all] = await Promise.all([this.latestCommit!(conn, auth), runs(conn, auth)]);
    const builds = await failedWorkersBuilds(conn, auth, latest).catch((): FailedBuild[] => []);
    const failing = latestPerWorkflow(all).filter((r) => runState(r) === "failing");
    let logsLeft = LOG_JOBS;
    const out: FailureLog["runs"] = [];
    for (const r of failing) {
      const jobs: FailureLog["runs"][number]["jobs"] = [];
      for (const job of await failedJobs(conn, auth, r)) {
        const step = job.steps?.find((s) => buildFailed(s));
        const log = logsLeft-- > 0 ? await jobLog(conn, auth, job) : { logProblem: `Only the first ${LOG_JOBS} failed jobs' logs are given: open this one on GitHub` };
        jobs.push({ name: job.name, conclusion: job.conclusion!, ...(step ? { failedStep: step.name } : {}), url: job.html_url ?? r.html_url, ...log });
      }
      out.push({ workflow: r.name ?? `Workflow ${r.workflow_id}`, sha: r.head_sha, at: r.created_at, url: r.html_url, jobs });
    }
    return { branch, runs: out, builds };
  },

  async details(conn, auth) {
    const { branch } = settingsOf(conn);
    const [list, all] = await Promise.all([commits(conn, auth, 10), runs(conn, auth)]);
    return {
      shape: "commits",
      commits: list,
      runs: all.slice(0, 10).map(toRun),
      link: { url: `https://github.com/${conn.resource}`, label: "All on GitHub" },
      branch,
    };
  },

  async audit(conn, auth) {
    if (!auth) return { findings: [], notes: ["No GitHub service connected"] };
    return auditRepo(conn, auth);
  },

  notice(event, app, reason) {
    const build = reason.startsWith("Cloudflare's build");
    if (event === "down") return { title: build ? `${app}: a Cloudflare build failed` : `${app}: CI is failing`, body: reason };
    return build
      ? { title: `${app}: Cloudflare builds are working again`, body: "The latest build succeeded." }
      : { title: `${app}: CI is passing again`, body: "The latest runs succeeded." };
  },
};
