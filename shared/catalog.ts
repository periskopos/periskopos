import type { ConnectionDetails, IncidentKind, ServiceType, SuggestionKind } from "./types.ts";

// What each kind of account and connection is, in one place: its name, its
// key, its status page, what it gives an app and how to set it up. Only
// descriptions live here, so the window and the server share them; what a
// connection does (checks, deploys, actions) is its integration's
// (server/integrations).

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// ── Connections: what an app is connected to ───────────────────────────

export type ConnectionInfo = {
  label: string;
  account?: ServiceType; // the account it's connected through, if any
  // What a failing check means: the app is down ("outage"), or something
  // to fix while the site still serves.
  incidentKind: IncidentKind;
  // "source" knows commits, "host" knows deploys: together they answer
  // "is my last push live?" whatever the providers are.
  role?: "source" | "host";
  // A fixed interval, whatever the app's own (expiry dates, checked daily).
  everyMs?: number;
  // What it shows of itself on the app's page (its integration's details).
  shows?: ConnectionDetails["shape"];
  // As offered from its account: "Get more from this app", and "Connect it
  // as" when the account offers more than one kind.
  offer?: { gives: string; noun: string; connectAs?: string };
};

export const CONNECTIONS: Record<string, ConnectionInfo> = {
  site: { label: "Status check", incidentKind: "outage" },
  link: { label: "Link", incidentKind: "outage" },
  github: {
    label: "GitHub",
    account: "github",
    incidentKind: "ci",
    role: "source",
    shows: "commits",
    offer: { gives: "Commits, CI and whether your last push is live", noun: "repository", connectAs: "Repository · commits and CI" },
  },
  "github-security": {
    label: "GitHub security alerts",
    account: "github",
    incidentKind: "security",
    // Alerts change when GitHub finds something or I fix it: a few times a
    // day is plenty, and spares the API.
    everyMs: 6 * HOUR_MS,
    offer: { gives: "Leaked secrets and vulnerable dependencies (Dependabot): an alert for anything serious", noun: "repository", connectAs: "Repository · security alerts" },
  },
  render: {
    label: "Render",
    account: "render",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Deploys, whether your last push is live, failed-deploy alerts and Redeploy", noun: "service", connectAs: "Service · deploys" },
  },
  cloudflare: {
    label: "Cloudflare Pages & Workers",
    account: "cloudflare",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Deploys and whether your last push is live", noun: "Worker or Pages project", connectAs: "Worker or Pages project · deploys" },
  },
  "cloudflare-zone": {
    label: "Cloudflare domain",
    account: "cloudflare",
    // A problem around the site (Cloudflare paused, errors piling up); the
    // status check is what says the site is down.
    incidentKind: "dependency",
    shows: "traffic",
    offer: { gives: "Traffic, visitors, error alerts, domain health and Purge cache", noun: "domain", connectAs: "Domain · traffic, visitors, cache" },
  },
  supabase: {
    label: "Supabase",
    account: "supabase",
    incidentKind: "dependency",
    offer: { gives: "Project health: a warning when it's paused or unhealthy", noun: "project", connectAs: "Project · health" },
  },
  "search-console": {
    label: "Search Console",
    account: "search-console",
    // The site still serves; fewer people find it.
    incidentKind: "search",
    // Search numbers change once a day, a few days late: every few hours is
    // plenty, and spares the API.
    everyMs: 6 * HOUR_MS,
    shows: "search",
    offer: { gives: "Search clicks, impressions, position and top queries, and an alert when clicks fall sharply", noun: "property" },
  },
  digitalocean: {
    label: "DigitalOcean App Platform",
    account: "digitalocean",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Deploys, whether your last push is live, failed-deploy alerts and Redeploy", noun: "app", connectAs: "App · deploys" },
  },
  vercel: {
    label: "Vercel",
    account: "vercel",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Production deploys, whether your last push is live, failed-deploy alerts and Redeploy", noun: "project", connectAs: "Project · deploys" },
  },
  netlify: {
    label: "Netlify",
    account: "netlify",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Production deploys, whether your last push is live, failed-deploy alerts and Redeploy", noun: "site" },
  },
  fly: {
    label: "Fly.io",
    account: "fly",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Releases, Machines that failed or are failing their health checks", noun: "app", connectAs: "App · releases" },
  },
  railway: {
    label: "Railway",
    account: "railway",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Deploys, whether your last push is live, failed or crashed deploy alerts and Redeploy", noun: "service", connectAs: "Service · deploys" },
  },
  sentry: {
    label: "Sentry",
    account: "sentry",
    // The site serves; something in it is breaking for people.
    incidentKind: "errors",
    shows: "errors",
    offer: { gives: "Unresolved errors, which are new since the last deploy, and an alert when a new one takes off", noun: "project" },
  },
  stripe: {
    label: "Stripe",
    account: "stripe",
    incidentKind: "payments",
    everyMs: 15 * 60_000,
    shows: "payments",
    offer: { gives: "Revenue, failed payments and failing webhooks, with an alert when payments start failing", noun: "account" },
  },
  paddle: {
    label: "Paddle",
    account: "paddle",
    incidentKind: "payments",
    everyMs: 15 * 60_000,
    shows: "payments",
    offer: { gives: "Revenue, failed payments, past-due subscriptions and failing webhooks, with an alert when payments start failing", noun: "account" },
  },
  resend: {
    label: "Resend",
    account: "resend",
    // The app still serves; its emails stop arriving.
    incidentKind: "dependency",
    offer: { gives: "Email sending: an alert when the domain the app sends from stops being verified", noun: "sending domain" },
  },
  gitlab: {
    label: "GitLab",
    account: "gitlab",
    incidentKind: "ci",
    role: "source",
    shows: "commits",
    offer: { gives: "Commits, CI pipelines and whether your last push is live", noun: "project" },
  },
  amplify: {
    label: "AWS Amplify",
    account: "aws",
    incidentKind: "deploy",
    role: "host",
    shows: "deploys",
    offer: { gives: "Deploys, whether your last push is live, failed-deploy alerts and Redeploy", noun: "app branch" },
  },
  neon: {
    label: "Neon",
    account: "neon",
    incidentKind: "dependency",
    offer: { gives: "Database health: a warning when its compute is stuck or the project hits a limit", noun: "project" },
  },
  mongodb: {
    label: "MongoDB Atlas",
    account: "mongodb",
    incidentKind: "dependency",
    offer: { gives: "Cluster health and Atlas's own open alerts for it", noun: "cluster" },
  },
  sendgrid: {
    label: "SendGrid",
    account: "sendgrid",
    // The app still serves; its emails stop arriving.
    incidentKind: "dependency",
    offer: { gives: "Email sending: an alert when the domain the app sends from stops being authenticated, or when the account's bounce or spam-report rate gets too high", noun: "sending domain" },
  },
  "google-analytics": {
    label: "Google Analytics",
    account: "google-analytics",
    // The site still serves; far fewer people are on it.
    incidentKind: "traffic",
    // Analytics numbers settle over hours: every few hours is plenty.
    everyMs: 6 * HOUR_MS,
    offer: { gives: "Visitors over 7 and 28 days, and an alert when traffic falls sharply", noun: "property" },
  },
  clerk: {
    label: "Clerk",
    account: "clerk",
    // The site still serves; nobody can sign in.
    incidentKind: "dependency",
    offer: { gives: "Whether sign-in works for the app, and its users and sign-ups", noun: "application" },
  },
  openai: {
    label: "OpenAI",
    account: "openai",
    incidentKind: "spend",
    // Costs are counted by the day: hourly is plenty.
    everyMs: HOUR_MS,
    offer: { gives: "API spend this month, and an alert when it passes the budget you set", noun: "project" },
  },
  "vercel-logs": {
    label: "Vercel logs",
    account: "vercel",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "project", connectAs: "Project · runtime errors" },
  },
  "render-logs": {
    label: "Render logs",
    account: "render",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "service", connectAs: "Service · runtime errors" },
  },
  "railway-logs": {
    label: "Railway logs",
    account: "railway",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "service", connectAs: "Service · runtime errors" },
  },
  "cloudflare-logs": {
    label: "Cloudflare Worker logs",
    account: "cloudflare",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "Worker", connectAs: "Worker · runtime errors" },
  },
  "supabase-logs": {
    label: "Supabase logs",
    account: "supabase",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "project", connectAs: "Project · runtime errors" },
  },
  "digitalocean-logs": {
    label: "DigitalOcean logs",
    account: "digitalocean",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "app", connectAs: "App · runtime errors" },
  },
  "fly-logs": {
    label: "Fly.io logs",
    account: "fly",
    // The site may still serve; its code is failing for some requests.
    incidentKind: "errors",
    shows: "logs",
    offer: { gives: "Runtime errors from its logs, the most frequent first, and an alert when they spike", noun: "app", connectAs: "App · runtime errors" },
  },
  ssl: { label: "SSL certificate", incidentKind: "expiry", everyMs: DAY_MS },
  domain: { label: "Domain", incidentKind: "expiry", everyMs: DAY_MS },
};

// A connection's name, by what it is: a Cloudflare connection is a Worker
// or (older ones, without a kind) a Pages project. An extra URL checked for
// an app goes by the name it was given ("API health").
export function connectionLabel(c: { type: string; settings?: Record<string, unknown> }): string {
  if (c.type === "cloudflare") return c.settings?.kind === "worker" ? "Cloudflare Worker" : "Cloudflare Pages";
  if (c.type === "site" && typeof c.settings?.label === "string") return c.settings.label;
  return CONNECTIONS[c.type]?.label ?? c.type;
}

// An app's own status check follows its URL. Any other status check is an
// extra URL checked for the same app: an API's /health, a second page.
export const isExtraSite = (app: { url: string }, c: { type: string; resource: string }) => c.type === "site" && c.resource !== app.url;

export function mainSite<C extends { type: string; resource: string }>(app: { url: string; connections: C[] }): C | undefined {
  return app.connections.find((c) => c.type === "site" && !isExtraSite(app, c)) ?? app.connections.find((c) => c.type === "site");
}

// How often a connection is checked, in words: its own fixed interval, or
// the app's.
export function checkEvery(type: string, appEveryMin: number): string {
  const fixed = CONNECTIONS[type]?.everyMs;
  if (fixed === undefined) return `every ${appEveryMin} min`;
  if (fixed === DAY_MS) return "daily";
  return fixed % HOUR_MS === 0 ? `every ${fixed / HOUR_MS} h` : `every ${Math.round(fixed / 60_000)} min`;
}

// Connections that host an app, and so know its deploys.
export const HOST_TYPES: readonly string[] = Object.keys(CONNECTIONS).filter((t) => CONNECTIONS[t]!.role === "host");
export const isHostType = (type: string) => HOST_TYPES.includes(type);

// A failure means the app is down, not just something to look at.
export const isOutageType = (type: string) => (CONNECTIONS[type]?.incidentKind ?? "outage") === "outage";

// ── Accounts: connected once, used by every app ────────────────────────

// What an account is for, so a list of them reads by kind. The order is
// the order they're shown in.
export const ACCOUNT_KINDS = [
  { key: "code", label: "Code" },
  { key: "hosting", label: "Hosting" },
  { key: "domains", label: "Domains" },
  { key: "database", label: "Database" },
  { key: "auth", label: "Sign-in" },
  { key: "errors", label: "Errors" },
  { key: "payments", label: "Payments" },
  { key: "email", label: "Email" },
  { key: "analytics", label: "Analytics" },
  { key: "search", label: "Search" },
  { key: "ai", label: "AI" },
] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number]["key"];
export const kindLabel = (k: AccountKind) => ACCOUNT_KINDS.find((x) => x.key === k)!.label;

export type AccountInfo = {
  label: string;
  // What it's for; the first is where it's listed (Cloudflare hosts and
  // runs domains, and is listed under Hosting).
  kinds: [AccountKind, ...AccountKind[]];
  keyName: string; // the variable a pasted key is saved under
  // The kinds of connection it offers an app, in the order they're offered.
  offers: SuggestionKind[];
  // Its public status page. `parts` always count for my apps; the
  // connections add theirs (server/integrations). Without parts, every part
  // counts: Supabase lists only regions. Without a status page (Google
  // publishes none in the usual summary format), nothing is watched.
  status?: { pageUrl: string; summaryUrl: string; parts?: string[] };
  // How to get its key, step by step, for the setup page.
  guide: {
    gives: string;
    link: { href: string; text: string };
    steps: string[];
    looksLike?: string; // how a real key starts, so a wrong copy is easy to spot
    keyIs?: string; // what is pasted, when it isn't a short token ("the JSON key file")
    actions?: string; // what "Allow actions" lets it do, for accounts that have any
  };
  // A free plan with a limit Periskopos watches, and the paid plan
  // that lifts it (switched on the Accounts page).
  plan?: { free: string; paid: string };
};

const statusPage = (pageUrl: string) => ({ pageUrl, summaryUrl: `${pageUrl}/api/v2/summary.json` });

export const ACCOUNTS: Record<ServiceType, AccountInfo> = {
  github: {
    label: "GitHub",
    kinds: ["code"],
    keyName: "GITHUB_TOKEN",
    offers: ["github", "github-security"],
    status: { ...statusPage("https://www.githubstatus.com"), parts: ["Git Operations", "Actions", "API Requests", "Webhooks"] },
    guide: {
      gives: "Each app's commits, its CI runs, and whether your last push is live.",
      link: { href: "https://github.com/settings/personal-access-tokens/new", text: "Open GitHub: new fine-grained token" },
      steps: [
        "Name the token Periskopos and pick an expiry date.",
        "Under Repository access, choose your apps' repositories (or All repositories).",
        "Under Permissions → Repositories, set Actions and Contents to Read-only (Metadata is added by itself). For security alerts, also set Dependabot alerts and Secret scanning alerts to Read-only. For configuration checks (branch protection, Dependabot, workflow permissions), also set Administration to Read-only.",
        "Click Generate token, copy it, and paste it below.",
      ],
      looksLike: "github_pat_",
    },
  },
  render: {
    label: "Render",
    kinds: ["hosting"],
    keyName: "RENDER_API_KEY",
    offers: ["render", "render-logs"],
    status: {
      ...statusPage("https://status.render.com"),
      // Render lists these per region; the same names count in any region.
      parts: ["Web Services", "Web Services - Free Tier", "Builds and Deploys", "Static Sites", "Custom Domains", "Cron Jobs", "Background Workers", "PostgreSQL", "Redis", "Render REST API"],
    },
    guide: {
      gives: "Your Render services' deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://dashboard.render.com/u/settings#api-keys", text: "Open Render: Account settings → API keys" },
      steps: ["Click Create API Key and name it Periskopos.", "Copy the key Render shows (it's shown only once) and paste it below."],
      looksLike: "rnd_",
      actions: "Periskopos can redeploy your apps on Render, always after you confirm on screen.",
    },
  },
  cloudflare: {
    label: "Cloudflare",
    kinds: ["hosting", "domains"],
    keyName: "CLOUDFLARE_API_TOKEN",
    offers: ["cloudflare", "cloudflare-zone", "cloudflare-logs"],
    status: { ...statusPage("https://www.cloudflarestatus.com"), parts: ["Network", "Infrastructure"] },
    plan: { free: "Workers Free: 100,000 requests a day, for Workers and Pages Functions together", paid: "Workers Paid" },
    guide: {
      gives: "Your Workers and Pages projects' deploys and whether your last push is live; your domains' health, traffic, errors and visitors; and Purge cache if you allow actions.",
      link: { href: "https://dash.cloudflare.com/profile/api-tokens", text: "Open Cloudflare: My Profile → API Tokens" },
      steps: [
        "Click Create Token, then Get started next to Create Custom Token, and name it Periskopos.",
        "Add these Account permissions, all Read: Account Settings, Workers Scripts, Workers Builds Configuration, Cloudflare Pages, Account Analytics. For Workers runtime errors, also add Workers Observability → Edit (Cloudflare only accepts Edit for reading Workers Logs; Periskopos only reads).",
        "Add these Zone permissions, all Read: Zone, Zone Settings, DNS, Analytics, SSL and Certificates, Bot Management, Email Routing Rules, and Zone Security Center Insights (for Cloudflare's Security Insights on the Configuration tab). To allow Purge cache, also add Zone → Cache Purge → Purge. (To allow redeploying Pages projects, choose Edit instead of Read for Cloudflare Pages.)",
        "Under Account Resources choose All accounts, and under Zone Resources choose All zones: the token only sees what you pick here.",
        "Click Continue to summary, then Create Token. Copy it and paste it below.",
      ],
      actions: "Periskopos can purge your domains' cache, and redeploy Pages projects, always after you confirm on screen. The token needs Cache Purge (and Cloudflare Pages: Edit for redeploys).",
    },
  },
  supabase: {
    label: "Supabase",
    kinds: ["database"],
    keyName: "SUPABASE_ACCESS_TOKEN",
    offers: ["supabase", "supabase-logs"],
    status: statusPage("https://status.supabase.com"),
    guide: {
      gives: "Whether your Supabase projects are healthy, and a warning when one is paused.",
      link: { href: "https://supabase.com/dashboard/account/tokens", text: "Open Supabase: Account → Access Tokens" },
      steps: [
        "Click Generate new token and name it Periskopos.",
        "Copy the token and paste it below. (Supabase tokens can't be limited to reading, so Periskopos only ever reads with it.)",
      ],
      looksLike: "sbp_",
    },
  },
  digitalocean: {
    label: "DigitalOcean",
    kinds: ["hosting"],
    keyName: "DIGITALOCEAN_TOKEN",
    offers: ["digitalocean", "digitalocean-logs"],
    status: {
      ...statusPage("https://status.digitalocean.com"),
      // App Platform and the API it's driven through, in any region (the
      // page names parts by region, under each product).
      parts: ["API", "App Platform", "Container Registry"],
    },
    guide: {
      gives: "Your App Platform apps' deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://cloud.digitalocean.com/account/api/tokens", text: "Open DigitalOcean: API → Tokens" },
      steps: [
        "Click Generate New Token, name it Periskopos, and pick an expiration.",
        "Under Scopes choose Custom Scopes, and tick account: read and app: read. To allow Redeploy, also tick app: update.",
        "Click Generate Token, copy it (it's shown only once), and paste it below.",
      ],
      looksLike: "dop_v1_",
      actions: "Periskopos can redeploy your App Platform apps, always after you confirm on screen. The token needs app: update.",
    },
  },
  vercel: {
    label: "Vercel",
    kinds: ["hosting"],
    keyName: "VERCEL_TOKEN",
    offers: ["vercel", "vercel-logs"],
    // Vercel's page names few parts an app could pick; every part counts.
    status: statusPage("https://www.vercel-status.com"),
    guide: {
      gives: "Your Vercel projects' production deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://vercel.com/account/settings/tokens", text: "Open Vercel: Account Settings → Tokens" },
      steps: [
        "Under Create Token, name it Periskopos, choose the scope (your account, or the team your projects are in) and an expiration.",
        "Click Create, copy the token (it's shown only once), and paste it below. Vercel tokens can't be limited to reading, so Periskopos only reads with it, unless you allow actions.",
      ],
      actions: "Periskopos can redeploy a project's live deploy to production, always after you confirm on screen.",
    },
  },
  netlify: {
    label: "Netlify",
    kinds: ["hosting"],
    keyName: "NETLIFY_AUTH_TOKEN",
    offers: ["netlify"],
    status: statusPage("https://www.netlifystatus.com"),
    guide: {
      gives: "Your Netlify sites' production deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://app.netlify.com/user/applications#personal-access-tokens", text: "Open Netlify: User settings → Applications" },
      steps: [
        "Under Personal access tokens, click New access token, name it Periskopos and pick an expiration.",
        "Click Generate token, copy it (it's shown only once), and paste it below. Netlify tokens can't be limited to reading, so Periskopos only reads with it, unless you allow actions.",
      ],
      looksLike: "nfp_",
      actions: "Periskopos can start a new production build of a site, always after you confirm on screen.",
    },
  },
  fly: {
    label: "Fly.io",
    kinds: ["hosting"],
    keyName: "FLY_API_TOKEN",
    offers: ["fly", "fly-logs"],
    status: statusPage("https://status.flyio.net"),
    guide: {
      gives: "Your Fly.io apps' releases, and a warning when a Machine fails or fails its health checks.",
      link: { href: "https://fly.io/docs/flyctl/tokens-create-readonly/", text: "Open Fly.io: fly tokens create readonly" },
      steps: [
        "In a terminal with flyctl signed in, run: fly tokens create readonly personal",
        "Copy the whole token it prints, starting with FlyV1, and paste it below. It can only read, and only your personal organization's apps are listed.",
      ],
      looksLike: "FlyV1 ",
    },
  },
  railway: {
    label: "Railway",
    kinds: ["hosting"],
    keyName: "RAILWAY_TOKEN",
    offers: ["railway", "railway-logs"],
    // Railway's status page isn't in the usual summary format: not watched.
    guide: {
      gives: "Your Railway services' deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://railway.com/account/tokens", text: "Open Railway: Account → Tokens" },
      steps: [
        "Under Create New Token, name it Periskopos and leave the workspace on No workspace, so it can see all your projects.",
        "Click Create, copy the token, and paste it below. Railway tokens can't be limited to reading, so Periskopos only reads with it, unless you allow actions.",
      ],
      actions: "Periskopos can redeploy a service's live deploy, always after you confirm on screen.",
    },
  },
  sentry: {
    label: "Sentry",
    kinds: ["errors"],
    keyName: "SENTRY_AUTH_TOKEN",
    offers: ["sentry"],
    status: statusPage("https://status.sentry.io"),
    guide: {
      gives: "Each app's unresolved errors, which ones are new since its last deploy, and an alert when a new error takes off.",
      link: { href: "https://sentry.io/settings/account/api/auth-tokens/", text: "Open Sentry: User Settings → Personal Tokens" },
      steps: [
        "Click Create New Token and name it Periskopos.",
        "Give it Read on Organization, Project and Issue & Event, and nothing else.",
        "Click Create Token, copy it (it's shown only once), and paste it below.",
      ],
      looksLike: "sntryu_",
    },
  },
  stripe: {
    label: "Stripe",
    kinds: ["payments"],
    keyName: "STRIPE_API_KEY",
    offers: ["stripe"],
    // Stripe's status page isn't in the usual summary format: not watched.
    guide: {
      gives: "Revenue over 7 and 30 days, failed payments and failing webhooks, with an alert when payments start failing or webhooks stop arriving.",
      link: { href: "https://dashboard.stripe.com/apikeys/create", text: "Open Stripe: Developers → API keys → Create restricted key" },
      steps: [
        "Choose Create restricted key (not your secret key), name it Periskopos.",
        "Set these to Read, and leave everything else at None: Balance, Charges, Events, Webhook Endpoints.",
        "Click Create key, copy it, and paste it below. A test-mode key works too, and shows as test.",
      ],
      looksLike: "rk_live_",
    },
  },
  paddle: {
    label: "Paddle",
    kinds: ["payments"],
    keyName: "PADDLE_API_KEY",
    offers: ["paddle"],
    guide: {
      gives: "Revenue over 7 and 30 days, failed payments, past-due subscriptions and failing webhooks, with an alert when payments start failing.",
      link: { href: "https://vendors.paddle.com/authentication-v2", text: "Open Paddle: Developer tools → Authentication" },
      steps: [
        "Under API keys, click New API key and name it Periskopos.",
        "Give it Read on Transactions, Subscriptions and Notifications, and nothing else.",
        "Click Save, copy the key, and paste it below. A sandbox key works too, and shows as test.",
      ],
      looksLike: "pdl_live_apikey_",
    },
  },
  resend: {
    label: "Resend",
    kinds: ["email"],
    keyName: "RESEND_API_KEY",
    offers: ["resend"],
    status: {
      ...statusPage("https://resend-status.com"),
      // Sending and its API; not the dashboard, the website or Resend's MCP server.
      parts: ["Single Email", "Batch Emails", "Broadcast Emails", "Scheduled Emails", "SMTP", "General API", "Email Events", "Webhooks"],
    },
    guide: {
      gives: "Whether each app's sending domain is still verified: a warning before its emails stop arriving because a DNS record broke or changed.",
      link: { href: "https://resend.com/api-keys", text: "Open Resend: API Keys" },
      steps: [
        "Click Create API Key and name it Periskopos.",
        "Choose Full access: a Sending access key can't read your domains. Periskopos only ever reads with it.",
        "Click Add, copy the key Resend shows (it's shown only once), and paste it below.",
      ],
      looksLike: "re_",
    },
  },
  "search-console": {
    label: "Google Search Console",
    kinds: ["search"],
    keyName: "GOOGLE_SEARCH_CONSOLE_KEY",
    offers: ["search-console"],
    guide: {
      gives: "How often your sites show up and get clicked in Google Search, their average position and top queries, and an alert when clicks fall sharply.",
      link: { href: "https://console.cloud.google.com/iam-admin/serviceaccounts", text: "Open Google Cloud: IAM & Admin → Service accounts" },
      steps: [
        "Pick or create a Google Cloud project, then turn on the Google Search Console API for it (APIs & Services → Library → Google Search Console API → Enable).",
        "In Service accounts, click Create service account and name it Periskopos. Skip the optional roles and access steps: it needs no Google Cloud permissions.",
        "Open the new service account, go to Keys → Add key → Create new key, choose JSON, and click Create. A .json file downloads.",
        "Copy the service account's email (it ends in .iam.gserviceaccount.com). In Search Console, open each site's property → Settings → Users and permissions → Add user, paste the email, and choose Restricted: Periskopos only reads.",
        "Open the downloaded .json file in a text editor, copy all of it, and paste it below. Periskopos only ever asks Google for read-only access to Search Console (webmasters.readonly).",
      ],
      looksLike: '{"type": "service_account"',
      keyIs: "the whole JSON key file",
    },
  },
  gitlab: {
    label: "GitLab",
    kinds: ["code"],
    keyName: "GITLAB_TOKEN",
    offers: ["gitlab"],
    guide: {
      gives: "Each app's commits, its CI pipelines, and whether your last push is live.",
      link: { href: "https://gitlab.com/-/user_settings/personal_access_tokens", text: "Open GitLab: Personal access tokens" },
      steps: [
        "Open the Generate token menu and choose Legacy token. Name it Periskopos and pick an expiry date (at most a year away).",
        "Tick read_api only: Periskopos only reads.",
        "Click Generate token, copy it, and paste it below.",
      ],
      looksLike: "glpat-",
    },
  },
  aws: {
    label: "AWS",
    kinds: ["hosting"],
    keyName: "AWS_AMPLIFY_KEY",
    offers: ["amplify"],
    guide: {
      gives: "Your Amplify apps' deploys and whether your last push is live, plus Redeploy if you allow actions.",
      link: { href: "https://console.aws.amazon.com/iam/home#/users", text: "Open AWS: IAM → Users" },
      steps: [
        "Click Create user and name it periskopos. It doesn't need console access.",
        "Choose Attach policies directly → Create policy → JSON, and allow these actions on Resource \"*\": amplify:ListApps, amplify:ListBranches, amplify:ListJobs, and amplify:StartJob (only needed for Redeploy). Name it PeriskoposAmplify and attach it to the user.",
        "Open the user → Security credentials → Create access key → Third-party service, and copy the access key ID (it starts with AKIA) and its secret. The secret is shown only once.",
        "Paste them below on one line as ACCESS_KEY_ID:SECRET:REGION, where REGION is the region your Amplify apps are in (us-east-1, eu-west-1…). One key watches one region.",
      ],
      looksLike: "AKIA",
      keyIs: "the access key ID, its secret and the region, as ID:SECRET:REGION",
      actions: "Redeploy: start a new build of a branch's latest commit (apps connected to a Git repository only).",
    },
  },
  neon: {
    label: "Neon",
    kinds: ["database"],
    keyName: "NEON_API_KEY",
    offers: ["neon"],
    guide: {
      gives: "Whether your Neon databases are healthy: a warning when a project's compute is stuck or it hits a plan limit.",
      link: { href: "https://console.neon.tech/app/settings/api-keys", text: "Open Neon: Account settings → API keys" },
      steps: [
        "Click Create new, name the key Periskopos, and create it. (A key made under your organization's Settings → API keys works too. A project-scoped key only sees its one project.)",
        "Copy the key (it's shown only once) and paste it below. Neon keys can't be limited to reading, so Periskopos only ever reads with it.",
      ],
      looksLike: "napi_",
    },
  },
  mongodb: {
    label: "MongoDB Atlas",
    kinds: ["database"],
    keyName: "MONGODB_ATLAS_KEY",
    offers: ["mongodb"],
    status: { ...statusPage("https://status.mongodb.com"), parts: ["MongoDB Cloud"] },
    guide: {
      gives: "Whether your Atlas clusters are healthy, and the alerts Atlas has open for them.",
      link: { href: "https://cloud.mongodb.com/v2#/preferences/organizations", text: "Open MongoDB Atlas: your organizations" },
      steps: [
        "Open your organization, then Identity & Access → Applications, and click Add new Service Account. Name it Periskopos.",
        "Under Organization Permissions choose Organization Read Only, and nothing else. Pick a Client Secret Expiration, then click Create.",
        "Copy the client secret now (it's shown only once), and the client ID.",
        "Under API Access List, click Add Access List Entry → Use Current IP Address → Save. Atlas only accepts the account from addresses on this list; if your IP changes, add the new one.",
        "Paste the client ID and secret below on one line, as CLIENT_ID:CLIENT_SECRET.",
      ],
      keyIs: "the service account's client ID and secret, as CLIENT_ID:CLIENT_SECRET",
    },
  },
  sendgrid: {
    label: "SendGrid",
    kinds: ["email"],
    keyName: "SENDGRID_API_KEY",
    offers: ["sendgrid"],
    status: { ...statusPage("https://status.twilio.com"), parts: ["SendGrid Mail Sending", "SendGrid API", "SendGrid Webhooks"] },
    guide: {
      gives: "Whether each app's sending domain is still authenticated, and the account's bounce and spam-report rates over the last 7 days: a warning before its emails stop arriving.",
      link: { href: "https://app.sendgrid.com/settings/api_keys", text: "Open SendGrid: Settings → API Keys" },
      steps: [
        "Click Create API Key, name it Periskopos and choose Restricted Access.",
        "Give Read Access to Sender Authentication and to Stats, and nothing else.",
        "Click Create & View, copy the key (it's shown only once), and paste it below. (Accounts in SendGrid's EU region aren't supported yet.)",
      ],
      looksLike: "SG.",
    },
  },
  "google-analytics": {
    label: "Google Analytics",
    kinds: ["analytics"],
    keyName: "GOOGLE_ANALYTICS_KEY",
    offers: ["google-analytics"],
    guide: {
      gives: "How many people visit each site over 7 and 28 days, and an alert when traffic falls sharply.",
      link: { href: "https://console.cloud.google.com/iam-admin/serviceaccounts", text: "Open Google Cloud: IAM & Admin → Service accounts" },
      steps: [
        "Pick or create a Google Cloud project, then turn on the Google Analytics Data API and the Google Analytics Admin API for it (APIs & Services → Library). The Admin API lists your properties; the Data API reads their visitors.",
        "In Service accounts, click Create service account and name it Periskopos. Skip the optional roles and access steps. (The one you made for Search Console works too: turn both Analytics APIs on in its project, and paste its key here as well.)",
        "Open the service account, go to Keys → Add key → Create new key, choose JSON, and click Create. A .json file downloads.",
        "Copy the service account's email. In Google Analytics, open Admin → Property access management (under Property) → + → Add users, paste the email, untick Notify new users by email, choose Viewer and click Add. Do this for each property you want watched.",
        "Open the downloaded .json file, copy all of it, and paste it below. Periskopos only ever asks Google for read-only access to Analytics.",
      ],
      looksLike: '{"type": "service_account"',
      keyIs: "the whole JSON key file",
    },
  },
  clerk: {
    label: "Clerk",
    kinds: ["auth"],
    keyName: "CLERK_SECRET_KEY",
    offers: ["clerk"],
    status: { ...statusPage("https://status.clerk.com"), parts: ["Authentication & User", "Session management", "Hosted UIs (Account Portal)"] },
    guide: {
      gives: "Whether your app's sign-in is working, its users and its sign-ups this week.",
      link: { href: "https://dashboard.clerk.com/last-active?path=api-keys", text: "Open Clerk: Configure → API keys" },
      steps: [
        "Pick the application and the Production instance (each instance has its own key; a Development key, sk_test_…, only sees test users).",
        "Copy the Secret key and paste it below. Clerk keys can't be limited to reading, so Periskopos only ever reads with it.",
      ],
      looksLike: "sk_live_",
    },
  },
  openai: {
    label: "OpenAI",
    kinds: ["ai"],
    keyName: "OPENAI_ADMIN_KEY",
    offers: ["openai"],
    status: {
      ...statusPage("https://status.openai.com"),
      // The API; not ChatGPT.
      parts: ["Chat Completions", "Responses", "Embeddings", "Realtime", "Batch", "Files"],
    },
    guide: {
      gives: "What each project spends on the API this month, and an alert when it passes the budget you set.",
      link: { href: "https://platform.openai.com/settings/organization/admin-keys", text: "Open OpenAI: Organization → Admin keys" },
      steps: [
        "Click Create new admin key and name it Periskopos. Only an organization owner can create one. (Only an admin key can read costs; a project key can't.)",
        "Copy the key (it's shown only once) and paste it below. Periskopos only ever reads with it.",
      ],
      looksLike: "sk-admin-",
    },
  },
};

// The account a host connection belongs to, by name ("All in Cloudflare").
export function hostLabel(type: string): string {
  const account = CONNECTIONS[type]?.account;
  return account ? ACCOUNTS[account].label : type;
}

// Connections with something more to show on the app's page.
export const hasDetails = (type: string) => CONNECTIONS[type]?.shows !== undefined;

// A status check's slow-response alert: over a number of milliseconds for
// this many checks in a row (server/integrations/site.ts).
export const SLOW_MS_RANGE = [100, 9_000] as const; // under the check's timeout, which is an outage
export const SLOW_CHECKS_RANGE = [2, 10] as const;
export const SLOW_CHECKS_DEFAULT = 3;
