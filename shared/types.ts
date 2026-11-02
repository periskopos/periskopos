// Shapes shared by the server and the web UI. The server runs this file
// directly (Node type stripping), so: types only, no enums.

export type User = {
  id: string;
  name: string;
  email?: string;
  createdAt: string;
};

export type Connection = {
  id: string;
  appId: string;
  type: string; // integration type: "site", "link", …
  serviceId?: string; // absent for keyless checks
  resource: string; // a URL for site and link
  settings?: Record<string, unknown>; // link: { label }
};

export type App = {
  id: string;
  slug: string; // unique per user, used in URLs
  ownerId: string;
  name: string;
  url: string;
  icon?: string;
  notes?: string;
  // false while the app isn't launched yet: its site and certificate aren't
  // checked, so it never shows as down or sends an alert (PRD FR-A7).
  live: boolean;
  checkIntervalMin: number;
  protocol?: { endpoint: string; secretRef: string };
  connections: Connection[];
};

export type CheckState = "up" | "down" | "unknown";

export type CheckResult = {
  state: CheckState;
  at: string; // ISO time of the check
  ms?: number;
  httpStatus?: number;
  detail?: string; // why it isn't up, in plain words
  summary?: string; // one line whatever the state: "Live: be0dc09 · 2 h ago"
  link?: DetailsLink; // where to see more: the failed build, say
};

// "none" = nothing to check. "attention" = the site is up but something
// around it isn't (a failed deploy, failing CI). "prelaunch" = not live yet,
// on purpose: nothing about it is wrong.
export type AppState = CheckState | "attention" | "none" | "prelaunch";

// outage: the app itself is down, counts against uptime.
// deploy / ci / expiry / dependency: something to fix, but the app is
// still serving (a failed deploy, red CI, a certificate or domain about to
// expire, an unhealthy database).
// "slow": the site answers, but over the response time set for it.
// "search": the site serves, but far fewer people reach it from search.
// "errors": the site serves, but a new error is hitting its users (Sentry).
// "security": a leaked secret or a serious vulnerable dependency (GitHub).
// "payments": payments failing, or the app not hearing about them (webhooks).
// "traffic": far fewer visitors than usual (Google Analytics).
// "spend": an API bill past the budget set for it (OpenAI).
export type IncidentKind = "outage" | "deploy" | "ci" | "expiry" | "dependency" | "slow" | "search" | "errors" | "security" | "payments" | "traffic" | "spend";

// ── The app protocol (PRD §10.5) ────────────────────────────────────────

export type AppMetric = { id: string; label: string; value: number | string; hint?: string };

export type ProtocolManifest = {
  protocol: number;
  app: { name: string; version?: string; commit?: string };
  capabilities: string[];
};

// What an app reports about itself, read live through its endpoint.
export type ProtocolView = {
  configured: boolean;
  endpoint?: string;
  secretRef?: string;
  secretState: "set" | "missing"; // the secret in .env.local, never its value
  manifest?: ProtocolManifest;
  metrics?: { items: AppMetric[]; at?: string };
  actions?: { id: string; label: string; description?: string; confirm: boolean; danger: boolean }[];
  extras?: { name: string; json: string }[]; // x- capabilities: a generic view
  problems?: string[]; // a capability that failed, the others still shown
  error?: string; // the endpoint as a whole didn't answer
  checkedAt?: string;
};

// What the generator hands back. The secret is in here once, deliberately:
// it has to be installed on the app's side.
export type GeneratedProtocol = {
  runtime: string;
  secretRef: string;
  secret: string;
  files: { path: string; content: string }[];
  commands: string[];
  endpointHint?: string;
};

// Something I can ask an app's services to do (PRD §7.8).
export type ActionDef = {
  id: string; // "redeploy:<connection id>"
  label: string;
  description: string;
  danger: boolean;
  connectionId: string;
  service: string; // the account that does it
};

export type BlockedAction = { label: string; reason: string };

export type ActionResult = { ok: boolean; message: string };

// An agent's action waiting for me to approve or decline it on screen.
export type Approval = {
  id: string;
  appSlug: string;
  appName: string;
  actionId: string;
  label: string;
  service: string;
  agent: string; // which AI assistant is asking
  // Which of my assistants it is (server/agents/agents.ts), so approving can also
  // let it run this action without asking for a while.
  agentId?: string;
  appId?: string;
  requestedAt: string;
  expiresAt: string;
};

// AI assistants, one each, with what they may do (server/agents/agents.ts).
export type AgentAccess = "read" | "ask"; // only read, or also ask for actions
export type AgentRule = "ask" | "allow" | "never"; // per action
export type AgentGrant = { appId: string; actionId: string; until: string }; // runs without asking until then
export type AgentView = {
  id: string;
  name: string;
  legacy: boolean; // the shared token file, used by MCP servers set up before assistants had their own
  createdAt: string;
  lastUsedAt?: string;
  apps: "all" | string[]; // app ids it can see
  access: AgentAccess;
  rules: Record<string, AgentRule>; // `${appId}:${actionId}`
  grants: AgentGrant[]; // live ones
};
// Settings → AI assistants' status line: whether the MCP server can run, how
// to set it up without a token, and the last request any assistant made.
export type McpStatus = {
  installed: boolean; // mcp/main.ts is in the app
  node: { version: string; ok: boolean } | null; // the `node` on PATH, which assistants start it with
  setup: { claudeCode: string; json: string; claudeDesktop: string };
  thisPcOff: boolean; // "This PC" was turned off
  lastRequest?: { agentName: string; client?: string; at: string };
};
export type AgentAuditEntry = {
  id: number;
  at: string;
  agentId: string;
  agentName: string;
  client?: string; // the tool it said it was (MCP's clientInfo)
  method: string;
  path: string;
  appSlug?: string;
  outcome: string; // "read", "approved", "declined", "allowed by rule"…
  status: number;
  detail?: string;
};

export type ActivityEntry = {
  id: string;
  appId: string;
  at: string;
  actionId: string;
  label: string;
  source: "ui" | "mcp";
  agent?: string; // which AI assistant, when source is "mcp" ("Claude Code", "Cursor"…)
  ok: boolean;
  message: string;
};

// A provider's public status page (FR-I3).
export type ProviderIndicator = "none" | "minor" | "major" | "critical" | "maintenance" | "unknown";

// "Get more from this app": something an account could still add.
export type SuggestionKind = "github" | "render" | "cloudflare" | "cloudflare-zone" | "supabase" | "search-console" | "resend" | "digitalocean" | "vercel" | "netlify" | "fly" | "railway" | "sentry" | "github-security" | "stripe" | "paddle" | "gitlab" | "amplify" | "neon" | "mongodb" | "sendgrid" | "google-analytics" | "clerk" | "openai" | "vercel-logs" | "render-logs" | "railway-logs" | "cloudflare-logs" | "supabase-logs" | "digitalocean-logs" | "fly-logs";
export type Suggestion = {
  serviceId: string;
  serviceName: string;
  serviceType: ServiceType;
  kind: SuggestionKind;
  // Present only when exactly one thing in the account is plainly the app's.
  match?: { resource: string; label: string; settings: Record<string, unknown> };
  // Present instead when several things are named like the app: you choose.
  choices?: { resource: string; label: string; settings: Record<string, unknown> }[];
};

export type ProviderIncident = {
  name: string;
  impact: string; // "none", "minor", "major", "critical"
  url?: string;
  status?: string; // "investigating", "identified", "monitoring"…
  startedAt?: string;
  parts?: string[]; // the parts of the provider it affects ("Workers", "Actions"…)
  affectsYou?: boolean; // in a part my apps use (or it doesn't say which)
  update?: { body: string; at?: string }; // the provider's latest word on it
};

export type ProviderMaintenance = { name: string; status: string; scheduledFor?: string; scheduledUntil?: string; url?: string; parts?: string[] };

// One part of a provider that my apps use ("Workers", "Actions"), as its
// status page has it now: the worst of its copies when it's listed once per
// region, and the regions that aren't operational.
export type ProviderPartState = "operational" | "degraded" | "partial" | "major" | "maintenance" | "unknown";
export type ProviderPart = { name: string; state: ProviderPartState; where?: string[] };

export type ProviderStatus = {
  id: string; // "github", "render", "supabase", "cloudflare"
  label: string;
  pageUrl: string;
  indicator: ProviderIndicator; // the whole provider, as its page says
  // Only what touches the parts my apps use: this drives the banners on my
  // apps and the notifications ("none" while the trouble is elsewhere).
  relevantIndicator: ProviderIndicator;
  description: string; // "All Systems Operational", "Partial outage"…
  incidents: ProviderIncident[];
  maintenance?: ProviderMaintenance[]; // scheduled or in progress
  parts?: ProviderPart[]; // the parts my apps use, and their state (none while no app uses it)
  checkedAt?: string;
  apps: { slug: string; name: string }[]; // my apps that depend on it (may be none)
};

// A confirmed problem: from the first failed check of two in a row until
// the first check that passes.
// The title bar's notifications (GET /api/notifications): what needs
// looking at now, and what recovered lately.
export type NotificationItem = {
  state: "down" | "attention";
  title: string; // the app or the account
  text: string; // what's wrong
  href: string; // where to look: "#/apps/star-map", "#/services"
  since?: string; // when it started
};
export type RecoveredItem = { title: string; text: string; href: string; startedAt: string; endedAt: string };
export type NotificationsView = { now: NotificationItem[]; earlier: RecoveredItem[] };

export type Incident = {
  id: string;
  appId: string;
  connectionId?: string;
  kind: IncidentKind;
  startedAt: string;
  endedAt?: string;
  reason: string;
  falseAlarm?: true; // I marked it: the app was fine, the check wasn't
};

export type Commit = {
  sha: string;
  message: string; // first line
  at: string;
  url?: string;
};

// "Is my last push live?" (FR-I4)
export type DeployState = {
  state: "live" | "deploying" | "not-deployed" | "unknown";
  latest?: Commit; // newest commit that should deploy (on the branch, in the paths)
  live?: Commit; // what the host is serving
  detail?: string;
};

export type AppStatus = {
  slug: string;
  state: AppState;
  checks: Record<string, CheckResult>; // latest, by connection id
  incident?: Incident; // the open one that matters most, if any
  uptime30d?: number; // %, over watched time; absent if never watched
  deploy?: DeployState; // when the app has both source control and a host
  metrics?: AppMetric[]; // the first few numbers the app reports about itself
};

// ── Services (my accounts) ──────────────────────────────────────────────

export type ServiceType = "github" | "render" | "cloudflare" | "supabase" | "search-console" | "resend" | "digitalocean" | "vercel" | "netlify" | "fly" | "railway" | "sentry" | "stripe" | "paddle" | "gitlab" | "aws" | "neon" | "mongodb" | "sendgrid" | "google-analytics" | "clerk" | "openai";

export type Service = {
  id: string;
  ownerId: string;
  type: ServiceType;
  name: string;
  secretRef?: string; // env var in .env.local; github without one uses `gh`
  canWrite: boolean;
  // The last test of its key (Test, or the watcher's daily one); cleared
  // when the key changes. expiresAt: when the key expires, if the provider says.
  lastTest?: { ok: boolean; message: string; at: string; expiresAt?: string };
  // For an account whose free plan has a limit (Cloudflare Workers): set
  // when I say it's on the paid plan, which has none to watch.
  paidPlan?: true;
  // How much of the free plan's limit it used, as last read.
  planUsage?: PlanUsage;
};

// One limit of a free plan, and how much of it is used in the current
// period: Cloudflare Workers' 100,000 requests a day.
export type UsageMeter = { label: string; used: number; limit: number; resetsAt: string };
export type PlanUsage = { at: string; meters: UsageMeter[] } | { at: string; error: string };

export type ServiceView = Service & {
  keyState: "set" | "missing" | "gh";
  apps: { slug: string; name: string }[]; // apps connected to it
};

// Something in a service an app can connect to: a repo, a Render service.
export type Resource = {
  id: string;
  label: string;
  detail?: string;
  settings?: Record<string, unknown>; // suggested connection settings
};

// What an app page shows for one connection, by integration.
export type Deploy = {
  id: string;
  status: string; // the host's own word: live, build_failed, …
  phase: "live" | "in-progress" | "failed" | "other";
  commit?: Commit;
  startedAt: string;
  finishedAt?: string;
  url?: string;
};

export type CiRun = {
  id: number;
  name: string; // workflow
  state: "passing" | "failing" | "running" | "other";
  conclusion?: string;
  sha: string;
  at: string;
  url: string;
};

// What a connection shows of itself, by what it is rather than who provides
// it: a host's deploys, a source's commits, a domain's traffic, a site's
// search results. The catalog
// says which a connection shows (shared/catalog.ts); the integration fills
// it in, down to the words of the link to the provider's own page.
export type ConnectionDetails = DeploysDetails | CommitsDetails | TrafficDetails | SearchDetails | ErrorsDetails | PaymentsDetails | LogsDetails;

// "All in Cloudflare", "All on GitHub": the provider's page for the rest.
export type DetailsLink = { url: string; label: string };

export type DeploysDetails = { shape: "deploys"; deploys: Deploy[]; link?: DetailsLink };

// An error tracker's view of an app (Sentry): its unresolved issues, most
// frequent in the last 24 hours first, and how many of them are new.
export type ErrorIssue = {
  id: string;
  shortId: string; // SHOP-1A
  title: string;
  culprit?: string; // where it's thrown
  level: string; // error, fatal, warning…
  count: number; // events, ever
  users: number;
  firstSeen: string;
  lastSeen: string;
  url: string;
};
export type ErrorsDetails = { shape: "errors"; project: string; issues: ErrorIssue[]; newIn24h: number; link: DetailsLink };

// A payment provider's view of an app (Stripe, Paddle…), in one shape
// whatever the provider: amounts in the currency's smallest unit (cents).
// A provider that can't say something leaves it out.
export type PaymentsRevenue = { currency: string; last7d: number; prev7d: number; last30d: number };
export type PaymentsDetails = {
  shape: "payments";
  provider: string; // "Stripe"
  mode: "live" | "test";
  revenue: PaymentsRevenue[]; // biggest first
  payments7d?: number; // successful payments, last 7 days
  failed: { last24h: number; prev7d: number }; // failed payments
  webhooks?: { failing24h: number; disabledEndpoints?: number };
  pastDue?: number; // subscriptions whose payment failed
  partial?: boolean; // more payments than were read: revenue is a floor
  link: DetailsLink;
};

export type CommitsDetails = { shape: "commits"; commits: Commit[]; runs: CiRun[]; branch: string; link: DetailsLink };

// Why a source's CI is failing, in its own words: the end of each failed
// job's log (GitHub masks the repository's secrets in it as ***). Builds
// another service records (a Workers Build) keep their logs there, so only
// their page is given.
export type FailureLog = {
  branch: string;
  runs: {
    workflow: string;
    sha: string;
    at: string;
    url: string;
    jobs: { name: string; conclusion: string; failedStep?: string; url: string; log?: string; logProblem?: string }[];
  }[];
  // A failed build of another service (Cloudflare's Workers Builds), with
  // the end of its log when the app's connection to that service can read it.
  builds: { reason: string; url?: string; log?: string; logProblem?: string }[];
};

// ── A domain on Cloudflare (a zone): its traffic and its visitors ───────

// One hour or one day of what Cloudflare's edge served for the domain.
export type TrafficPoint = {
  at: string; // the hour (ISO) or the day ("2026-10-16", UTC)
  requests: number;
  cachedRequests: number;
  bytes: number;
  visitors: number; // Cloudflare's unique visitors (distinct IPs) in that hour or day
  errors5xx: number;
};

export type TrafficTotals = {
  requests: number;
  cachedPct?: number; // absent when there were no requests
  bytes: number;
  // Daily unique visitors added up: a person who came on two days counts twice.
  visitors: number;
  errors5xx: number;
  errorPct?: number;
};

export type ZoneTraffic = {
  hours: TrafficPoint[]; // the last 24 hours, oldest first
  days: TrafficPoint[]; // the last 30 days (today included), oldest first
  totals: { day: TrafficTotals; week: TrafficTotals; month: TrafficTotals };
};

export type TopPage = { path: string; views: number };

// Cloudflare Web Analytics (real browsers running its beacon), when on.
export type ZoneVisitors =
  | {
      state: "on";
      days: { date: string; visits: number; pageViews: number }[]; // 30, oldest first
      topPages: { week: TopPage[]; month: TopPage[] };
      dashboardUrl?: string;
    }
  | { state: "off" | "none" | "unavailable"; message: string; howTo?: string; dashboardUrl?: string };

// A domain's traffic and visitors, and the state of the domain itself.
export type TrafficDetails = {
  shape: "traffic";
  zone: string;
  status: string; // "active", "pending", …
  paused: boolean;
  developmentMode: boolean;
  dashboardUrl?: string;
  traffic?: ZoneTraffic;
  trafficError?: string; // why the traffic couldn't be read, in plain words
  visitors: ZoneVisitors;
};

// ── A site in search results: how often it's shown and clicked ──────────

// One day of the site in search results (the search engine's own day).
export type SearchDay = {
  date: string; // "2026-10-16"
  clicks: number;
  impressions: number;
  position?: number; // average position, 1 = the top; absent when never shown
};

export type SearchTotals = {
  clicks: number;
  impressions: number;
  ctrPct?: number; // clicks per impression; absent when never shown
  position?: number; // average position, weighted by impressions
};

export type SearchQuery = { query: string; clicks: number; impressions: number; position: number };

// A sharp fall in clicks, week over week (the rule is the integration's).
export type SearchDrop = { clicks: number; before: number; dropPct: number };

// A site's search performance over the last 7 and 28 days of data. Search
// numbers come in a few days late, so "the last 7 days" ends on `through`,
// the newest day there is data for, not today.
export type SearchDetails = {
  shape: "search";
  site: string; // the property as people know it: "example.org"
  through?: string; // the newest day with data; absent when there's none yet
  days: SearchDay[]; // the 28 days up to `through`, oldest first
  totals: { week: SearchTotals; previousWeek: SearchTotals; month: SearchTotals };
  topQueries: { week: SearchQuery[]; month: SearchQuery[] };
  drop?: SearchDrop;
  dashboardUrl?: string;
};

// ── Logs: what an app's running code wrote as errors ─────────────────────

// One error line as the host keeps it, before grouping.
export type LogLine = {
  at: string; // ISO
  level: "error" | "fatal" | "warning";
  message: string;
  source?: string; // the function, route, instance or component it came from
};

// The same error, however often: lines alike but for numbers, ids and
// addresses are counted as one.
export type LogGroup = {
  message: string; // the newest line of the group, as written
  level: LogLine["level"];
  count: number;
  firstAt: string;
  lastAt: string;
  source?: string;
};

// A sharp rise in errors (the rule is server/integrations/logs.ts's).
export type LogSpike = { recent: number; usual: number; windowMin: number };

// A host's error lines over the last hour, grouped, most frequent first.
export type LogsDetails = {
  shape: "logs";
  provider: string; // "Vercel"
  windowMin: number; // how far back it read
  total: number; // error lines in the window
  last15m: number;
  groups: LogGroup[];
  spike?: LogSpike;
  partial?: boolean; // more lines than were read: counts are a floor
  link?: DetailsLink;
};

// ── Configuration: what's set up wrong, and how to put it right ─────────

export type FindingSeverity = "high" | "medium" | "low";

// How to fix it: steps in words, where to do it, and what to paste (a DNS
// record, a header) when there's something to paste.
export type FindingFix = { steps: string; link?: DetailsLink; code?: string };

// What a check found, before it's kept: `key` is stable across runs
// ("dmarc-missing", "branch-protection:main"), so a finding is recognised
// the next day, and ignoring it sticks.
export type FindingDraft = { key: string; severity: FindingSeverity; title: string; why: string; fix: FindingFix };

// What one source (the site, a connection) found, and what it couldn't
// check and why ("the token can't read branch protection").
export type AuditResult = { findings: FindingDraft[]; notes?: string[] };

export type Finding = FindingDraft & {
  id: string; // `${source}:${key}`, unique in the app
  source: string; // "site", "dns" or a connection type
  sourceLabel: string; // "The site", "GitHub"
  connectionId?: string;
  firstSeen: string;
  lastSeen: string;
  ignored: boolean;
};

export type ConfigReport = {
  findings: Finding[]; // worst first
  notes: { source: string; text: string }[];
  checkedAt?: string; // the last full check; absent before the first
};

// A stretch when the watcher wasn't running (PC off, asleep, offline).
export type Gap = { from: string; to: string };

export type DayStat = {
  day: string; // local date, "2026-10-06"
  uptimePct?: number; // absent if not watched that day
  watchedMin: number;
  incidents: number;
  avgMs?: number;
  maxMs?: number;
};

export type AppHistory = {
  from: string;
  to: string;
  uptimePct?: number;
  watchedMin: number;
  incidents: Incident[]; // newest first
  gaps: Gap[]; // newest first
  days: DayStat[]; // oldest first
};

export type Settings = {
  watcherEnabled: boolean;
  notificationsEnabled: boolean;
  // A provider's incident in a part my apps use sounds an alarm until dismissed.
  incidentAlarm: boolean;
  // Claude (or any MCP client) may use Periskopos through the agent token.
  agentAccess: boolean;
  // Phone alerts: where the same notifications also go (keys in the keys file).
  phoneChannel: "off" | "ntfy" | "telegram" | "email";
  ntfyServer: string; // https://ntfy.sh, or my own
  telegramChatId: string;
  emailFrom: string; // a sender on a domain verified with Resend
  emailTo: string;
};

// The database's daily copies (server/backup.ts). Never the keys: those
// live only in the keys file.
export type BackupFile = { name: string; at: string; bytes: number };
export type BackupStatus = {
  dir: string;
  keep: number;
  last?: BackupFile;
  count: number;
  error?: string; // the last automatic backup failed, and why
};

export type StartupStatus = {
  supported: boolean;
  enabled: boolean;
  managedBy?: "desktop"; // the desktop app owns it: change it from the tray icon
};
