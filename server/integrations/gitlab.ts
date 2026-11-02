import { duration } from "../../shared/format.ts";
import type { CheckResult, CiRun, Commit, Connection, FailureLog } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { getJson, getJsonFresh, getText } from "../http.ts";
import { requiredText, text } from "../validate.ts";
import { firstLine, LOG_LINES } from "./github.ts";
import { described } from "./types.ts";
import type { Integration, KeyTest, ServiceAuth } from "./types.ts";

// GitLab as a source: commits and CI pipelines, gitlab.com only. A personal
// access token with read_api is sent as a Bearer token, which GitLab accepts.

const WEB = "https://gitlab.com";
const API = `${WEB}/api/v4`;
// Pages of 100 projects read for the picker: 1,000 projects is plenty.
const PROJECT_PAGES = 10;

type GlProject = { id: number; path_with_namespace: string; default_branch: string | null; visibility?: string; last_activity_at?: string };
type GlCommit = { id: string; title: string; message: string; committed_date: string; web_url: string };
type GlPipeline = { id: number; iid: number; name?: string | null; status: string; source?: string; ref: string; sha: string; created_at: string; web_url: string };
type GlJob = { id: number; name: string; stage: string; status: string; allow_failure: boolean; failure_reason?: string; web_url: string };

async function gl<T>(auth: ServiceAuth, path: string): Promise<T> {
  return getJson<T>(`${API}${path}`, { token: await auth.token(), provider: "GitLab" });
}

const enc = encodeURIComponent;

const settingsOf = (conn: Connection) => ({
  branch: String(conn.settings?.branch ?? "main"),
  paths: Array.isArray(conn.settings?.paths) ? (conn.settings.paths as string[]) : [],
  projectId: typeof conn.settings?.projectId === "number" ? conn.settings.projectId : undefined,
});

// How the API names the project: its numeric id when known (it survives a
// rename or a move to another group), else its path with the "/" encoded.
const project = (conn: Connection) => `/projects/${settingsOf(conn).projectId ?? enc(conn.resource)}`;

// A token's expiry as GitLab gives it, a date ("2026-11-01"): the token
// stops working on that day (UTC), so that day's start is when it expires.
export function tokenExpiry(date: string | null | undefined): string | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const at = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

const toCommit = (c: GlCommit): Commit => ({
  sha: c.id,
  message: firstLine(c.title || c.message),
  at: c.committed_date,
  url: c.web_url,
});

// Commits on the branch that touch the app's folders, newest first.
async function commits(conn: Connection, auth: ServiceAuth, perPath = 10): Promise<Commit[]> {
  const { branch, paths } = settingsOf(conn);
  const lists = await Promise.all(
    (paths.length ? paths : [undefined]).map((p) =>
      gl<GlCommit[]>(auth, `${project(conn)}/repository/commits?ref_name=${enc(branch)}&per_page=${perPage(perPath)}${p ? `&path=${enc(p)}` : ""}`),
    ),
  );
  const bySha = new Map<string, Commit>();
  for (const c of lists.flat()) bySha.set(c.id, toCommit(c));
  return [...bySha.values()].sort((a, b) => b.at.localeCompare(a.at)).slice(0, perPath);
}
const perPage = (n: number) => Math.min(100, Math.max(1, n));

// A pipeline that hasn't reached a verdict: waiting, queued, going, or
// stopping. "scheduled" is a delayed job still to run.
const UNFINISHED = new Set(["created", "waiting_for_resource", "preparing", "waiting_for_callback", "pending", "running", "canceling", "scheduled"]);

function pipelineState(p: Pick<GlPipeline, "status">): CiRun["state"] {
  if (UNFINISHED.has(p.status)) return "running";
  if (p.status === "success") return "passing";
  if (p.status === "failed") return "failing";
  return "other"; // canceled, skipped, manual (waiting on someone)
}

const pipelineName = (p: GlPipeline) => p.name || `Pipeline #${p.iid}`;

const toRun = (p: GlPipeline): CiRun => ({
  id: p.id,
  name: pipelineName(p),
  state: pipelineState(p),
  conclusion: p.status,
  sha: p.sha,
  at: p.created_at,
  url: p.web_url,
});

// The branch's pipelines, newest first (GitLab's default order).
async function pipelines(conn: Connection, auth: ServiceAuth): Promise<GlPipeline[]> {
  const { branch } = settingsOf(conn);
  return gl<GlPipeline[]>(auth, `${project(conn)}/pipelines?ref=${enc(branch)}&per_page=30`);
}

// The newest finished pipeline: what "CI on main" means right now. GitLab
// runs one pipeline per push (not one per workflow, as GitHub does), so one
// pipeline decides. One still going has no verdict yet, so it neither
// clears a failure (no false "CI is passing again") nor hides one.
export function latestFinished(list: GlPipeline[]): GlPipeline | undefined {
  return list.find((p) => pipelineState(p) !== "running");
}

const ago = (iso: string) => `${duration(Date.now() - Date.parse(iso))} ago`;

// ── Why CI failed: the end of each failed job's log ────────────────────

const LOG_JOBS = 3;

// A job's log as plain lines, ending where it failed. GitLab colours its
// lines, marks collapsible sections with "section_start:…" markers, redraws
// progress lines with a carriage return, and after the failure may come
// clean-up output: none of that says why it failed. The runner writes the
// failure itself as "ERROR: Job failed…", so the tail ends at the last one.
const SECTION = /section_(start|end):\d+:[\w.-]+(\[[^\]]*\])?/g;
export function logTail(raw: string, lines = LOG_LINES): string {
  const all = raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .flatMap((l) => {
      const marked = SECTION.test(l);
      SECTION.lastIndex = 0;
      // What a terminal would show: the text after the last redraw.
      const shown = l.replace(SECTION, "").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split("\r").filter(Boolean).at(-1) ?? "";
      // A line that only held a section marker isn't a blank line in the log.
      return marked && !shown.trim() ? [] : [shown.slice(0, 500)];
    });
  const lastError = all.findLastIndex((l) => l.startsWith("ERROR: Job failed"));
  const kept = lastError >= 0 ? all.slice(0, lastError + 1) : all;
  while (kept.length && kept.at(-1)!.trim() === "") kept.pop();
  return kept.slice(-lines).join("\n");
}

// The jobs that failed the pipeline: their latest attempt (GitLab leaves
// retried ones out by default), not the ones allowed to fail.
async function failedJobs(conn: Connection, auth: ServiceAuth, p: GlPipeline): Promise<GlJob[]> {
  const jobs = await gl<GlJob[]>(auth, `${project(conn)}/pipelines/${p.id}/jobs?scope[]=failed&per_page=100`);
  return (jobs ?? []).filter((j) => j.status === "failed" && !j.allow_failure);
}

async function jobLog(conn: Connection, auth: ServiceAuth, job: GlJob): Promise<{ log: string } | { logProblem: string }> {
  try {
    const raw = await getText(`${API}${project(conn)}/jobs/${job.id}/trace`, { token: await auth.token(), provider: "GitLab" });
    return { log: logTail(raw) };
  } catch (err) {
    return { logProblem: `Couldn't read the log: ${(err as Error).message}` };
  }
}

export const gitlab: Integration = {
  ...described("gitlab"),

  // "group/star-map" goes by "star-map"; connected on its default branch,
  // the whole project until folders are chosen.
  resourceName: (r) => r.id.split("/").at(-1) ?? r.id,
  suggestedSettings: (_app, r) => ({ projectId: r.settings?.projectId, branch: r.settings?.branch ?? "main", paths: "" }),

  parse({ resource, settings }) {
    const path = requiredText(resource, "Project", 255);
    // Groups nest: "group/subgroup/project" is as valid as "user/project".
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(path)) throw badRequest("Project must look like group/name");
    const s = (settings ?? {}) as Record<string, unknown>;
    const branch = text(s.branch, "Branch", { max: 200, optional: true }) ?? "main";
    if (!/^[\w./-]+$/.test(branch) || branch.includes("..")) throw badRequest("That isn't a valid branch name");
    const rawPaths = Array.isArray(s.paths) ? s.paths : typeof s.paths === "string" ? s.paths.split(",") : [];
    const paths = rawPaths
      .map((p) => String(p).trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""))
      .filter(Boolean);
    if (paths.some((p) => p.split("/").includes("..") || p.length > 200)) throw badRequest("Paths must be folders inside the project");
    if (paths.length > 10) throw badRequest("At most 10 paths");
    // The numeric id comes from the picker; typed by hand, the path is enough.
    const rawId = s.projectId;
    let projectId: number | undefined;
    if (rawId !== undefined && rawId !== null && rawId !== "") {
      projectId = Number(rawId);
      if (!Number.isSafeInteger(projectId) || projectId <= 0) throw badRequest("Project ID must be a positive whole number");
    }
    return { resource: path, settings: { ...(projectId ? { projectId } : {}), branch, paths } };
  },

  async testService(auth): Promise<KeyTest> {
    const token = await auth.token();
    const { body: user } = await getJsonFresh<{ username: string }>(`${API}/user`, { token, provider: "GitLab" });
    // The token's own details say when it expires. Only personal (and
    // project/group) access tokens have them: anything else just goes without.
    const self = await getJsonFresh<{ expires_at?: string | null }>(`${API}/personal_access_tokens/self`, { token, provider: "GitLab" }).catch(() => undefined);
    const expiresAt = tokenExpiry(self?.body.expires_at);
    return { message: `Connected as ${user.username}`, ...(expiresAt ? { expiresAt } : {}) };
  },

  async listResources(auth) {
    // GitLab gives at most 100 projects a page: keep asking until a page
    // comes back short, up to a cap so a huge group can't stall the picker.
    // Only projects I'm a member of: without membership=true, gitlab.com
    // lists every public project there is.
    const projects: GlProject[] = [];
    for (let page = 1; page <= PROJECT_PAGES; page++) {
      const batch = await gl<GlProject[]>(auth, `/projects?membership=true&archived=false&order_by=last_activity_at&sort=desc&per_page=100&page=${page}`);
      projects.push(...batch);
      if (batch.length < 100) break;
    }
    return projects.map((p) => ({
      id: p.path_with_namespace,
      label: p.path_with_namespace,
      detail: [p.visibility, p.last_activity_at && `active ${ago(p.last_activity_at)}`].filter(Boolean).join(" · "),
      settings: { projectId: p.id, branch: p.default_branch ?? "main", paths: [] },
    }));
  },

  async latestCommit(conn, auth) {
    return (await commits(conn, auth, 1))[0];
  },

  commitUrl: (conn, sha) => `${WEB}/${conn.resource}/-/commit/${sha}`,

  // Compared from head to base, GitLab lists the commits base has that head
  // doesn't (from their merge base). None means head already holds base.
  async contains(conn, auth, head, base) {
    if (head === base) return true;
    const { commits: missing } = await gl<{ commits?: unknown[] }>(auth, `${project(conn)}/repository/compare?from=${enc(head)}&to=${enc(base)}`);
    return Array.isArray(missing) && missing.length === 0;
  },

  // Up unless the branch's newest finished pipeline failed.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No GitLab service connected" };
    const { branch } = settingsOf(conn);
    try {
      const [latest, all] = await Promise.all([this.latestCommit!(conn, auth), pipelines(conn, auth)]);
      const newest = latestFinished(all);
      const running = all.some((p) => pipelineState(p) === "running");
      const change = latest ? `latest change ${latest.sha.slice(0, 7)} ${ago(latest.at)}` : "no commits";
      if (newest && pipelineState(newest) === "failing") {
        const name = newest.name ? `${newest.name} (#${newest.iid})` : `pipeline #${newest.iid}`;
        return {
          state: "down",
          at,
          detail: `CI failing on ${branch}: ${name}`,
          summary: `CI failing · ${change}`,
          // One click to why: the failed pipeline on GitLab.
          link: { url: newest.web_url, label: "Open the failed pipeline on GitLab" },
        };
      }
      // Only pipelines still going, none finished to judge by: no verdict yet.
      if (!newest && running) return { state: "unknown", at, detail: "CI is running; no pipeline has finished yet", summary: `CI running · ${change}` };
      const ci = !newest ? "No CI" : running ? "CI running" : newest.status === "success" ? "CI passing" : `Last pipeline ${newest.status}`;
      return { state: "up", at, summary: `${ci} · ${change}` };
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  // The failure check() reports, with the end of each failed job's log.
  async failureLog(conn, auth): Promise<FailureLog> {
    const { branch } = settingsOf(conn);
    const newest = latestFinished(await pipelines(conn, auth));
    const out: FailureLog["runs"] = [];
    if (newest && pipelineState(newest) === "failing") {
      let logsLeft = LOG_JOBS;
      const jobs: FailureLog["runs"][number]["jobs"] = [];
      for (const job of await failedJobs(conn, auth, newest)) {
        const log = logsLeft-- > 0 ? await jobLog(conn, auth, job) : { logProblem: `Only the first ${LOG_JOBS} failed jobs' logs are given: open this one on GitLab` };
        jobs.push({ name: `${job.stage}: ${job.name}`, conclusion: job.failure_reason || job.status, url: job.web_url || newest.web_url, ...log });
      }
      out.push({ workflow: pipelineName(newest), sha: newest.sha, at: newest.created_at, url: newest.web_url, jobs });
    }
    return { branch, runs: out, builds: [] };
  },

  async details(conn, auth) {
    const { branch } = settingsOf(conn);
    const [list, all] = await Promise.all([commits(conn, auth, 10), pipelines(conn, auth)]);
    return {
      shape: "commits",
      commits: list,
      runs: all.slice(0, 10).map(toRun),
      link: { url: `${WEB}/${conn.resource}`, label: "All on GitLab" },
      branch,
    };
  },

  notice(event, app, reason) {
    if (event === "down") return { title: `${app}: CI is failing`, body: reason };
    return { title: `${app}: CI is passing again`, body: "The latest pipeline succeeded." };
  },
};
