import { CONNECTIONS } from "../../shared/catalog.ts";
import type {
  App,
  AuditResult,
  CheckResult,
  Commit,
  Connection,
  ConnectionDetails,
  Deploy,
  DeploysDetails,
  FailureLog,
  IncidentKind,
  Resource,
  Service,
  ServiceType,
  UsageMeter,
} from "../../shared/types.ts";

export type ConnectionInput = { resource: unknown; settings: unknown };
export type ParsedConnection = { resource: string; settings?: Record<string, unknown> };

// A connected account and a way to get its key without exposing it.
export type ServiceAuth = { service: Service; token: () => Promise<string> };

export type Notice = { title: string; body: string };

// What testing a key found: whose it is, and when it expires, when the
// provider says (GitHub fine-grained tokens, Cloudflare tokens).
export type KeyTest = { message: string; expiresAt?: string };

// A host's build of one commit, as the source records it (a GitHub check run
// such as "Workers Builds: star-map"): for hosts that don't say which commit
// they serve, this is how "is my last push live?" is answered.
export type BuildCheck = {
  sha: string;
  message: string; // the commit's first line
  at: string; // when the commit was made
  status: string; // queued, in_progress, completed…
  conclusion?: string; // once completed: success, failure, cancelled…
  completedAt?: string; // once completed
  url: string; // the build on the host's dashboard
};

// What the catalog says about a connection type (shared/catalog.ts), in the
// shape integrations carry it: every integration starts from this, so its
// name, account and incident kind are written once.
export function described(type: string): Pick<Integration, "type" | "label" | "needsService" | "serviceType" | "incidentKind" | "role" | "everyMs"> {
  const info = CONNECTIONS[type];
  if (!info) throw new Error(`${type} isn't in the catalog`);
  return {
    type,
    label: info.label,
    needsService: info.account !== undefined,
    ...(info.account ? { serviceType: info.account } : {}),
    incidentKind: info.incidentKind,
    ...(info.role ? { role: info.role } : {}),
    ...(info.everyMs ? { everyMs: info.everyMs } : {}),
  };
}

// A host's recent deploys, with its dashboard for the rest ("All in Render").
export function deploysDetails(deploys: Deploy[], dashboardUrl: string | undefined, provider: string): DeploysDetails {
  return { shape: "deploys", deploys: deploys.slice(0, 10), ...(dashboardUrl ? { link: { url: dashboardUrl, label: `All in ${provider}` } } : {}) };
}

// One kind of service (PRD §10.4).
export type Integration = {
  type: string;
  label: string;
  needsService: boolean;
  serviceType?: ServiceType; // the account type it needs
  // What a failing check means: the app is down, or something to fix.
  incidentKind: IncidentKind;
  // Failed checks in a row before an incident opens (default 2: one
  // failure is only a failure). Daily checks use 1.
  confirmFailures?: number;
  // Checks the running site itself (its response, its certificate): left
  // alone while the app is marked not live yet.
  needsLiveApp?: boolean;
  // A fixed check interval, overriding the app's own (daily SSL/domain).
  everyMs?: number;
  // When a connection's answers count as slow: over overMs for this many
  // checks in a row opens a "slow" incident (attention, not an outage).
  slowness?(conn: Connection): { overMs: number; checks: number } | undefined;
  // "source" knows commits, "host" knows deploys: together they answer
  // "is my last push live?" whatever the providers are.
  role?: "source" | "host";

  parse(input: ConnectionInput): ParsedConnection; // throws HttpError(400)
  check?(conn: Connection, auth?: ServiceAuth): Promise<CheckResult>;
  details?(conn: Connection, auth: ServiceAuth): Promise<ConnectionDetails>;
  // Things it can do for me (only offered when the service allows actions).
  actions?(conn: Connection): { id: string; label: string; description: string; danger?: boolean }[];
  run?(conn: Connection, auth: ServiceAuth, actionId: string): Promise<{ ok: boolean; message: string }>;
  // The words for a notification when an incident opens or closes.
  notice?(event: "down" | "up", app: string, reason: string, downForMs: number): Notice;

  // Accounts: checking a key works, listing what the account holds.
  testService?(auth: ServiceAuth): Promise<KeyTest>;
  // A key that isn't one line of text (a JSON key file), checked and turned
  // into the one line saved in the keys file; throws what's wrong with it.
  // Without this, a pasted key must be a plain token.
  keyFromPaste?(pasted: unknown): string;
  listResources?(auth: ServiceAuth): Promise<Resource[]>;
  // How much of its free plan's limits the account has used (the catalog's
  // `plan`); not asked while it's marked as on the paid plan.
  planUsage?(auth: ServiceAuth): Promise<UsageMeter[]>;

  // role "source"
  latestCommit?(conn: Connection, auth: ServiceAuth): Promise<Commit | undefined>;
  // Is `head` the same as, or newer than, `base` on this repo?
  contains?(conn: Connection, auth: ServiceAuth, head: string, base: string): Promise<boolean>;
  commitUrl?(conn: Connection, sha: string): string;
  // The check of the given name on the app's newest commits (branch and
  // paths), newest first; stops at the newest one that succeeded, since
  // nothing older matters. Commits the check never ran on are left out.
  buildChecks?(conn: Connection, auth: ServiceAuth, checkName: string): Promise<BuildCheck[]>;
  // Whether two commits hold the same files (in the connection's paths):
  // an empty commit, or one that only touched other folders.
  sameContent?(conn: Connection, auth: ServiceAuth, a: string, b: string): Promise<boolean>;
  // Why its check is failing: the end of each failed CI job's log.
  failureLog?(conn: Connection, auth: ServiceAuth): Promise<FailureLog>;
  // The end of a failed build's log, given the build's page on this host's
  // dashboard; undefined when the page isn't one of this connection's builds.
  buildLog?(conn: Connection, auth: ServiceAuth, url: string): Promise<{ log: string } | { logProblem: string } | undefined>;
  // role "host"
  deploys?(conn: Connection, auth: ServiceAuth): Promise<Deploy[]>;
  // The source's check that records this host's builds, when the host itself
  // can't say which commit it serves (a Worker built by Workers Builds).
  buildCheckName?(conn: Connection): string | undefined;

  // Configuration checks (server/audits/audit.ts): what's set up wrong on the
  // provider's side for this connection, and how to fix it. Reads only;
  // what the key isn't allowed to read goes in `notes`, not in a throw.
  audit?(conn: Connection, auth: ServiceAuth | undefined, app: App): Promise<AuditResult>;

  // The parts of its provider's status page this connection relies on,
  // besides the ones every app of that account does (shared/catalog.ts).
  statusParts?(conn: Connection): string[];

  // "Get more from this app" (server/suggestions.ts). The name a resource
  // goes by, to compare with the app's (default: its label).
  resourceName?(r: Resource): string;
  // Which of an account's resources is plainly the app's, when the usual
  // matching by name and address doesn't fit (a domain the app is on).
  // Returning one makes it a match; with this hook, nothing else does.
  matchApp?(app: App, resources: Resource[]): Resource | undefined;
  // Offered only when one resource matches (a domain the account doesn't
  // hold isn't something it could add).
  suggestOnlyMatched?: boolean;
  // The settings a matched resource is connected with in one click
  // (default: the resource's own).
  suggestedSettings?(app: App, r: Resource): Record<string, unknown>;
};
