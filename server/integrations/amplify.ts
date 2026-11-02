import { createHash, createHmac } from "node:crypto";
import { hostnameOf } from "../../shared/format.ts";
import type { App, CheckResult, Connection, Deploy, Resource } from "../../shared/types.ts";
import { badRequest } from "../errors.ts";
import { ProviderError } from "../http.ts";
import { requiredText } from "../validate.ts";
import { firstLine } from "./github.ts";
import { deployHealth, deployNotice, short } from "./render.ts";
import { described, deploysDetails } from "./types.ts";
import type { Integration, ServiceAuth } from "./types.ts";
import { APP_USER_AGENT } from "../config.ts";

// AWS Amplify as a host: each app's branches, their build jobs (each with
// the commit it built), so "is my last push live?" and failed-deploy alerts
// work as they do for Render; Redeploy (a RELEASE job) when the account
// allows actions. AWS takes no bearer token: every request is signed with
// the IAM user's access key (Signature Version 4, node:crypto), so this
// integration has its own small fetch rather than server/http.ts's.

const SERVICE = "amplify";
const USER_AGENT = APP_USER_AGENT;

// ── The key: ACCESS_KEY_ID:SECRET:REGION ────────────────────────────────

export type AwsKey = { accessKeyId: string; secretAccessKey: string; region: string };

const KEY_ID = /^AKIA[A-Z0-9]{16}$/;
const TEMP_KEY_ID = /^ASIA[A-Z0-9]{16}$/;
const SECRET = /^[A-Za-z0-9/+=]{40}$/;
// The commercial regions' shape (us-east-1, ap-southeast-2, eu-central-1…):
// Amplify isn't in GovCloud or China, whose endpoints differ anyway.
const REGION = /^(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d{1,2}$/;

// What was pasted, as the one line saved: ID:SECRET:REGION. Tolerates
// spaces around it, and the CSV IAM offers to download (its header line and
// commas) with the region added anywhere, by picking each part by its shape.
export function keyFromPaste(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste the key first");
  if (value.length > 2000) throw new Error("That's too long to be an access key: check what was copied");
  const parts = value
    .split(/[\s,:;"']+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.some((p) => TEMP_KEY_ID.test(p))) {
    throw new Error("That's a temporary access key (ASIA…): it expires and needs a session token. Create an access key for an IAM user instead (it starts with AKIA)");
  }
  const ids = parts.filter((p) => KEY_ID.test(p));
  if (ids.length !== 1) throw new Error("No access key ID found: it starts with AKIA and is 20 characters. Paste ACCESS_KEY_ID:SECRET:REGION");
  const secrets = parts.filter((p) => SECRET.test(p) && !KEY_ID.test(p));
  if (secrets.length !== 1) throw new Error("No secret access key found (40 characters, shown once when the key is created). Paste ACCESS_KEY_ID:SECRET:REGION");
  const regions = parts.filter((p) => REGION.test(p.toLowerCase()));
  if (regions.length !== 1) {
    const last = parts.at(-1) ?? "";
    if (!regions.length && last !== ids[0] && last !== secrets[0] && /^[a-z]{2}-/i.test(last)) throw new Error(`"${last}" isn't an AWS region: it looks like us-east-1 or eu-west-2`);
    throw new Error("Add the region your Amplify apps are in, after a colon: ACCESS_KEY_ID:SECRET:REGION (us-east-1, eu-west-1…)");
  }
  return `${ids[0]}:${secrets[0]}:${regions[0]!.toLowerCase()}`;
}

// The saved line, read back. Strict: it's what keyFromPaste wrote, or a
// line typed into the keys file by hand in the same shape.
export function readKey(saved: string): AwsKey {
  const [accessKeyId = "", secretAccessKey = "", region = "", ...rest] = saved.trim().split(":");
  if (rest.length || !KEY_ID.test(accessKeyId) || !SECRET.test(secretAccessKey) || !REGION.test(region)) {
    throw new Error("The saved AWS key isn't ACCESS_KEY_ID:SECRET:REGION. Choose Change key and paste it again");
  }
  return { accessKeyId, secretAccessKey, region };
}

// ── Signature Version 4 ─────────────────────────────────────────────────

export type SignInput = {
  method: string;
  host: string;
  path: string; // as sent: each segment already percent-encoded
  query?: [string, string][]; // decoded names and values
  headers?: Record<string, string>; // besides host and x-amz-date
  body?: string;
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (key: string | Buffer, s: string) => createHmac("sha256", key).update(s, "utf8").digest();

// RFC 3986 encoding, as SigV4 wants it: everything but A–Z a–z 0–9 - . _ ~,
// hex in capitals (encodeURIComponent leaves ! ' ( ) * alone).
export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

const amzDate = (now: Date) => now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

// The signed request's parts (AWS's own steps: canonical request → string
// to sign → signature), and the headers to send with it. Every AWS service
// but S3 encodes each path segment once more for the canonical URI, so a
// branch named feature/x, sent as feature%2Fx, is signed as feature%252Fx.
export function signV4(req: SignInput, key: Omit<AwsKey, "region">, region: string, service: string, now = new Date()) {
  const stamp = amzDate(now);
  const day = stamp.slice(0, 8);
  const headers: Record<string, string> = { host: req.host, "x-amz-date": stamp };
  for (const [name, value] of Object.entries(req.headers ?? {})) headers[name.toLowerCase()] = value;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalUri = req.path.split("/").map(uriEncode).join("/") || "/";
  const canonicalQuery = (req.query ?? [])
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [req.method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, sha256(req.body ?? "")].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretAccessKey}`, day), region), service), "aws4_request");
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization = `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const sent: Record<string, string> = { ...headers, authorization };
  return { canonicalRequest, stringToSign, signature, headers: sent };
}

// ── Calls ───────────────────────────────────────────────────────────────

// Reads are cached briefly, like server/http.ts's (FR-I2): the watcher, the
// Fleet and an app page asking at once make one call. The key is part of
// the cache key, so two accounts never share answers.
const cache = new Map<string, { until: number; value: Promise<unknown> }>();

export function clearAmplifyCache() {
  cache.clear();
}

// Why AWS said no, in words: which permission the IAM user lacks (AWS names
// it), or which part of the key it didn't accept.
function refusal(status: number, body: string, errorType: string, action: string): string {
  let message = "";
  try {
    const j = JSON.parse(body) as { message?: string; Message?: string };
    message = j.message ?? j.Message ?? "";
  } catch {
    // not JSON
  }
  const type = (errorType || message).split(":")[0] ?? "";
  if (/UnrecognizedClient|InvalidClientTokenId/i.test(type) || /security token included in the request is invalid/i.test(message)) {
    return "AWS doesn't know this access key (403): it may be mistyped, deleted or deactivated. Check IAM → Users → Security credentials";
  }
  if (/SignatureDoesNotMatch|InvalidSignature/i.test(type) || /signature we calculated does not match/i.test(message)) {
    return "AWS rejected the secret access key (403): the access key ID is right but its secret isn't. Paste the key again";
  }
  if (status === 403 || status === 401 || /AccessDenied|Unauthorized/i.test(type)) {
    const needed = message.match(/perform:\s*(amplify:[A-Za-z]+)/)?.[1] ?? action;
    return `AWS refused ${needed} (${status}): the IAM user's policy doesn't allow it. Add "${needed}" to its policy`;
  }
  if (status === 404) return `Amplify doesn't know this app or branch (404): it may have been deleted, or be in another region`;
  return `Amplify answered HTTP ${status}${message ? `: ${message}` : ""}`;
}

async function signedFetch<T>(saved: string, action: string, method: "GET" | "POST", path: string, query: [string, string][] = [], body?: unknown): Promise<T> {
  const key = readKey(saved);
  const host = `amplify.${key.region}.amazonaws.com`;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const signed = signV4(
    { method, host, path, query, ...(payload !== undefined ? { headers: { "content-type": "application/json" }, body: payload } : {}) },
    key,
    key.region,
    SERVICE,
  );
  const headers = { ...signed.headers };
  delete headers.host; // fetch sets Host itself
  const qs = query.map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join("&");
  let res: Response;
  try {
    res = await fetch(`https://${host}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: { ...headers, accept: "application/json", "user-agent": USER_AGENT },
      ...(payload !== undefined ? { body: payload } : {}),
      signal: AbortSignal.timeout(method === "GET" ? 15_000 : 20_000),
    });
  } catch (err) {
    throw new ProviderError(0, `Can't reach AWS Amplify: ${(err as Error).message}`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ProviderError(res.status, refusal(res.status, text, res.headers.get("x-amzn-errortype") ?? "", action), text);
  }
  return (await res.json().catch(() => ({}))) as T;
}

async function get<T>(auth: ServiceAuth, action: string, path: string, query: [string, string][] = [], ttlMs = 60_000): Promise<T> {
  const saved = await auth.token();
  const id = createHash("sha256").update(`${saved}\n${path}\n${JSON.stringify(query)}`).digest("hex");
  const hit = cache.get(id);
  if (hit && hit.until > Date.now()) return hit.value as Promise<T>;
  const value = signedFetch<T>(saved, action, "GET", path, query);
  if (cache.size >= 500) cache.clear();
  cache.set(id, { until: Date.now() + ttlMs, value });
  value.catch(() => cache.delete(id)); // never cache a failure
  return value;
}

// ── Amplify's answers ───────────────────────────────────────────────────

type AApp = { appId: string; name: string; defaultDomain?: string; repository?: string; productionBranch?: { branchName?: string } };
type ABranch = { branchName: string; displayName?: string; stage?: string; customDomains?: string[]; activeJobId?: string };
type AJob = {
  jobId: string;
  jobType?: string; // RELEASE, RETRY, MANUAL, WEB_HOOK
  status: string; // CREATED, PENDING, PROVISIONING, RUNNING, FAILED, SUCCEED, CANCELLING, CANCELLED
  commitId?: string;
  commitMessage?: string;
  commitTime?: number | string;
  startTime: number | string;
  endTime?: number | string;
};

const IN_PROGRESS = new Set(["CREATED", "PENDING", "PROVISIONING", "RUNNING", "CANCELLING"]);

// Amplify's JSON times are epoch seconds (fractions allowed).
function isoOf(t: number | string | undefined): string | undefined {
  if (t === undefined || t === null || t === "") return undefined;
  const ms = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const appIdOf = (conn: Connection) => conn.resource.split("/")[0]!;
const branchOf = (conn: Connection) => conn.resource.slice(conn.resource.indexOf("/") + 1);
const regionOf = (conn: Connection) => (typeof conn.settings?.region === "string" && REGION.test(conn.settings.region) ? conn.settings.region : undefined);
const jobsPath = (conn: Connection) => `/apps/${encodeURIComponent(appIdOf(conn))}/branches/${encodeURIComponent(branchOf(conn))}/jobs`;

// The Amplify console's page for an app, a branch or one job.
function consoleUrl(region: string | undefined, appId: string, branch?: string, jobId?: string): string | undefined {
  if (!region) return undefined;
  const hash = [appId, branch, jobId].filter((p) => p !== undefined).map((p) => encodeURIComponent(p!)).join("/");
  return `https://console.aws.amazon.com/amplify/home?region=${region}#/${hash}`;
}

// Newest first. Every SUCCEED job stays SUCCEED: the newest one is live,
// the ones before it were replaced.
export function toDeploys(jobs: AJob[], link?: (jobId: string) => string | undefined): Deploy[] {
  const sorted = [...jobs].sort((a, b) => (Date.parse(isoOf(b.startTime) ?? "") || 0) - (Date.parse(isoOf(a.startTime) ?? "") || 0) || Number(b.jobId) - Number(a.jobId));
  let liveSeen = false;
  return sorted.map((j) => {
    let phase: Deploy["phase"] = "other";
    let status = j.status.toLowerCase();
    if (IN_PROGRESS.has(j.status)) phase = "in-progress";
    else if (j.status === "FAILED") phase = "failed";
    else if (j.status === "SUCCEED") {
      if (!liveSeen) {
        liveSeen = true;
        phase = "live";
        status = "live";
      } else status = "superseded";
    }
    const sha = j.commitId && /^[0-9a-f]{7,40}$/i.test(j.commitId) ? j.commitId : undefined;
    const startedAt = isoOf(j.startTime) ?? new Date(0).toISOString();
    const finishedAt = phase !== "in-progress" ? isoOf(j.endTime) : undefined;
    const url = link?.(j.jobId);
    return {
      id: j.jobId,
      status,
      phase,
      ...(sha ? { commit: { sha, message: firstLine(j.commitMessage ?? "") || `commit ${sha.slice(0, 7)}`, at: isoOf(j.commitTime) ?? startedAt } } : {}),
      startedAt,
      ...(finishedAt ? { finishedAt } : {}),
      ...(url ? { url } : {}),
    };
  });
}

async function jobs(conn: Connection, auth: ServiceAuth, limit: number, ttlMs?: number): Promise<AJob[]> {
  const { jobSummaries } = await get<{ jobSummaries?: AJob[] }>(auth, "amplify:ListJobs", jobsPath(conn), [["maxResults", String(limit)]], ttlMs);
  return jobSummaries ?? [];
}

const deploysOf = (conn: Connection, list: AJob[]) => toDeploys(list, (jobId) => consoleUrl(regionOf(conn), appIdOf(conn), branchOf(conn), jobId));

// Every page of a list, up to a sane number of pages.
async function allPages<T>(read: (next?: string) => Promise<{ items: T[]; nextToken?: string | null }>, pages = 10): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined;
  for (let i = 0; i < pages; i++) {
    const page = await read(next);
    out.push(...page.items);
    if (!page.nextToken) break;
    next = page.nextToken;
  }
  return out;
}

const listApps = (auth: ServiceAuth) =>
  allPages(async (next) => {
    const r = await get<{ apps?: AApp[]; nextToken?: string | null }>(auth, "amplify:ListApps", "/apps", [["maxResults", "100"], ...(next ? [["nextToken", next] as [string, string]] : [])]);
    return { items: r.apps ?? [], nextToken: r.nextToken ?? null };
  });

const listBranches = (auth: ServiceAuth, appId: string) =>
  allPages(async (next) => {
    const r = await get<{ branches?: ABranch[]; nextToken?: string | null }>(auth, "amplify:ListBranches", `/apps/${encodeURIComponent(appId)}/branches`, [
      ["maxResults", "50"],
      ...(next ? [["nextToken", next] as [string, string]] : []),
    ]);
    return { items: r.branches ?? [], nextToken: r.nextToken ?? null };
  });

// The names an app goes by, as server/suggestions.ts reads them.
function namesOf(app: App): Set<string> {
  const host = hostnameOf(app.url).replace(/^www\./, "");
  const simple = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return new Set([app.slug, host.split(".")[0] ?? "", simple(app.name)].filter(Boolean));
}

export const amplify: Integration = {
  ...described("amplify"),

  keyFromPaste,

  parse({ resource, settings }) {
    const id = requiredText(resource, "Amplify branch", 300);
    const m = id.match(/^(d[a-z0-9]{1,19})\/(.{1,255})$/s);
    if (!m) throw badRequest("Pick the branch from the list: an Amplify branch looks like d1a2b3c4/main");
    const s = (settings ?? {}) as Record<string, unknown>;
    const appName = typeof s.appName === "string" ? s.appName.slice(0, 100) : undefined;
    const region = typeof s.region === "string" && REGION.test(s.region) ? s.region : undefined;
    return { resource: id, settings: { appId: m[1], branchName: m[2], ...(appName ? { appName } : {}), ...(region ? { region } : {}) } };
  },

  async testService(auth) {
    const { region } = readKey(await auth.token());
    const { apps, nextToken } = await get<{ apps?: AApp[]; nextToken?: string }>(auth, "amplify:ListApps", "/apps", [["maxResults", "100"]], 0);
    const n = apps?.length ?? 0;
    return { message: `Connected to AWS Amplify in ${region}: ${nextToken ? "100+" : n} app${n === 1 && !nextToken ? "" : "s"}` };
  },

  // Every app's branches in the key's region. A branch's addresses (its
  // default domain and custom domains) travel in the detail, so the one
  // serving the app's URL is its match.
  async listResources(auth) {
    const { region } = readKey(await auth.token());
    const apps = await listApps(auth);
    const lists = await Promise.all(
      apps.map(async (a) => {
        const branches = await listBranches(auth, a.appId);
        return branches.map((b): Resource => {
          const production = b.stage === "PRODUCTION" || a.productionBranch?.branchName === b.branchName;
          const addresses = [a.defaultDomain ? `${b.displayName || b.branchName}.${a.defaultDomain}` : undefined, ...(b.customDomains ?? [])].filter(Boolean).slice(0, 3);
          return {
            id: `${a.appId}/${b.branchName}`,
            label: `${a.name}/${b.branchName}`,
            detail: [...addresses, production && "production"].filter(Boolean).join(" · "),
            settings: { appId: a.appId, branchName: b.branchName, appName: a.name, region, ...(production ? { production: true } : {}) },
          };
        });
      }),
    );
    const all = lists.flat();
    if (!all.length) throw new Error(`This AWS key sees no Amplify app branches in ${region}. Check the region in the key: apps in another region need a key line with that region`);
    return all;
  },

  resourceName: (r) => (typeof r.settings?.appName === "string" ? r.settings.appName : r.label.split("/")[0]!),

  // An app has a branch per environment: the branch serving the app's
  // address is its match; failing that, the production branch of the one
  // Amplify app named like it.
  matchApp(app, resources) {
    const host = hostnameOf(app.url).replace(/^www\./, "");
    const served = resources.filter((r) => host && (r.detail ?? "").toLowerCase().split(/[\s·,]+/).some((d) => d.replace(/^www\./, "") === host));
    if (served.length === 1) return served[0];
    if (served.length > 1) return undefined;
    const names = namesOf(app);
    const named = resources.filter((r) => r.settings?.production === true && names.has(String(r.settings?.appName ?? "").toLowerCase()));
    return named.length === 1 ? named[0] : undefined;
  },

  suggestedSettings: (_app, r) => {
    const { production: _p, ...settings } = r.settings ?? {};
    return settings;
  },

  async deploys(conn, auth) {
    return deploysOf(conn, await jobs(conn, auth, 20));
  },

  // Down when the newest job failed, or has run far longer than usual.
  async check(conn, auth): Promise<CheckResult> {
    const at = new Date().toISOString();
    if (!auth) return { state: "unknown", at, detail: "No AWS account connected" };
    try {
      const list = await this.deploys!(conn, auth);
      const result = deployHealth(list, at);
      if (result.state !== "down") return result;
      // The build to look at: the one taking too long, or the failed one.
      const build = result.detail?.startsWith("Deploy running") ? list[0] : list.find((d) => d.phase === "failed");
      return build?.url ? { ...result, link: { url: build.url, label: "Open the build in Amplify" } } : result;
    } catch (err) {
      return { state: "unknown", at, detail: (err as Error).message };
    }
  },

  async details(conn, auth) {
    return deploysDetails(await this.deploys!(conn, auth), consoleUrl(regionOf(conn), appIdOf(conn), branchOf(conn)), "Amplify");
  },

  actions: () => [
    {
      id: "redeploy",
      label: "Redeploy",
      description: "Starts a new build of the branch's latest commit on Amplify. The live site keeps serving until the new build is deployed.",
    },
  ],

  async run(conn, auth, actionId) {
    if (actionId !== "redeploy") throw new Error(`Amplify has no action "${actionId}"`);
    // Never stack a second build on one that's already running; look fresh.
    const recent = await jobs(conn, auth, 5, 0);
    const running = deploysOf(conn, recent).find((d) => d.phase === "in-progress");
    if (running) return { ok: false, message: `A build is already running (${short(running)}, ${running.status}). Wait for it to finish.` };
    // A RELEASE job builds from the repository: an app deployed by hand
    // (drag and drop, a zip) has none.
    if (recent.length && recent.every((j) => j.jobType === "MANUAL")) {
      return { ok: false, message: "This branch is deployed by hand, not from a repository, so there's nothing for Amplify to rebuild. Deploy it again the way you did before." };
    }
    const { jobSummary } = await signedFetch<{ jobSummary?: AJob }>(await auth.token(), "amplify:StartJob", "POST", jobsPath(conn), [], {
      jobType: "RELEASE",
      jobReason: "Redeploy from Periskopos",
    });
    return {
      ok: true,
      message: `Redeploy started${jobSummary?.jobId ? ` (job ${jobSummary.jobId}${jobSummary.status ? `, ${jobSummary.status.toLowerCase()}` : ""})` : ""}. It will show under Deploys.`,
    };
  },

  notice: deployNotice,
};
