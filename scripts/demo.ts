// A demo Periskopos for screenshots and videos: made-up apps with a month
// of history, on its own data folder and port, with every provider answered
// from here and the network shut. Nothing in it is anyone's real app, and
// nothing it does reaches the internet.
//
//   node scripts/demo.ts [--port 4199] [--fresh] [--dir data/demo]
//
// The session key is written to <dir>/session-key, for the capture script
// (scripts/demo-capture.ts, which runs its own in data/demo-capture) and for
// opening it in a browser by hand. --dir keeps two demos apart.

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CheckResult,
  Commit,
  CommitsDetails,
  Connection,
  ConnectionDetails,
  Deploy,
  ErrorsDetails,
  PaymentsDetails,
  Service,
  TrafficDetails,
  TrafficPoint,
} from "../shared/types.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const DIR = process.argv.includes("--dir") ? path.resolve(ROOT, arg("--dir")) : path.join(ROOT, "data", "demo");
// --fresh empties it: only ever a folder under data/.
const inData = path.relative(path.join(ROOT, "data"), DIR);
if (!inData || inData.startsWith("..") || path.isAbsolute(inData)) throw new Error(`--dir must be a folder inside data/, not ${DIR}`);
const PORT = process.argv.includes("--port") ? Number(arg("--port")) : 4199;
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error(`--port takes a port from 1024 to 65535, not "${arg("--port")}"`);

if (process.argv.includes("--fresh")) rmSync(DIR, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });
// Before anything reads them: the demo's own registry and keys file, so the
// real ones are never opened.
process.env.PERISKOPOS_DATA_DIR = DIR;
process.env.PERISKOPOS_ENV_FILE = path.join(DIR, ".env.local");
process.env.PERISKOPOS_PORT = String(PORT);

// The network is shut: a provider call that wasn't answered below fails
// here instead of leaving the PC.
globalThis.fetch = async (input) => {
  throw new TypeError(`The demo is offline (${String(input instanceof Request ? input.url : input).split("?")[0]})`);
};

const { serve } = await import("@hono/node-server");
const { createAgent } = await import("../server/agents/agents.ts");
const { createApp } = await import("../server/app.ts");
const { DIST_WEB } = await import("../server/config.ts");
const { openDb } = await import("../server/db.ts");
const { recordCheck } = await import("../server/history.ts");
const { integrations } = await import("../server/integrations/index.ts");
const { silentNotifier } = await import("../server/alerts/notify.ts");
const { updateSettings } = await import("../server/settings.ts");
const { loadOrCreateToken, newSessionKey } = await import("../server/security.ts");
const store = await import("../server/store.ts");
const { Watcher } = await import("../server/watcher.ts");

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const ago = (ms: number) => iso(NOW - ms);
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const longDate = (ms: number) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// A steady pseudo-random series, so a reseed looks the same.
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

// ── The apps ────────────────────────────────────────────────────────────

type Plan = {
  name: string;
  url: string;
  live?: boolean;
  ms: number; // usual response time
  repo: string;
  host?: "vercel" | "render" | "fly" | "railway";
  hostResource?: string;
  extras?: { type: string; resource: string }[];
  commits: [string, number][]; // message, how long ago; newest first
  liveIndex?: number; // which commit is live (default the newest)
  deploying?: boolean; // the newest is being deployed
  sslDays: number;
  domainDays: number;
};

const ORG = "nova-labs";
const PLANS: Plan[] = [
  {
    name: "Nova-Shop",
    url: "https://nova-shop.example.org",
    ms: 212,
    repo: `${ORG}/nova-shop`,
    host: "vercel",
    hostResource: "prj_nova_shop",
    extras: [
      { type: "cloudflare-zone", resource: "nova-shop.example.org" },
      { type: "sentry", resource: "nova-labs/nova-shop" },
      { type: "stripe", resource: "acct_nova_shop" },
    ],
    commits: [
      ["Checkout: remember the shipping address", 2 * HOUR],
      ["Product page: faster image loading", 9 * HOUR],
      ["Fix the cart badge on mobile", 26 * HOUR],
      ["Gift cards at checkout", 2 * DAY + 3 * HOUR],
      ["Bump next to 16.2", 3 * DAY + 5 * HOUR],
      ["Search: typo-tolerant matching", 5 * DAY],
    ],
    sslDays: 63,
    domainDays: 284,
  },
  {
    name: "Moon-Base",
    url: "https://moon-base.example.net",
    ms: 164,
    repo: `${ORG}/moon-base`,
    host: "render",
    hostResource: "srv-moonbase",
    commits: [
      ["Dashboard: weekly report email", 6 * MIN],
      ["Team invites expire after 7 days", 20 * HOUR],
      ["Upgrade to Node 24", 2 * DAY],
      ["Rate-limit the login form", 4 * DAY],
    ],
    liveIndex: 1,
    deploying: true,
    sslDays: 71,
    domainDays: 201,
  },
  {
    name: "Comet-Mail",
    url: "https://comet-mail.example.com",
    ms: 146,
    repo: `${ORG}/comet-mail`,
    host: "fly",
    hostResource: "comet-mail",
    extras: [
      { type: "resend", resource: "mail.comet-mail.example.com" },
      { type: "supabase", resource: "cometmail-db" },
    ],
    commits: [
      ["Unsubscribe link in every digest", 2 * DAY],
      ["Retry bounced sends once", 3 * DAY],
      ["Templates: dark mode", 6 * DAY],
    ],
    sslDays: 9,
    domainDays: 145,
  },
  {
    name: "Orbit-API",
    url: "https://api.orbit.example.org",
    ms: 88,
    repo: `${ORG}/orbit-api`,
    host: "railway",
    hostResource: "orbit-api-production",
    extras: [
      { type: "neon", resource: "orbit-db" },
      { type: "sentry", resource: "nova-labs/orbit-api" },
    ],
    commits: [
      ["v2 endpoints: cursor pagination", 5 * HOUR],
      ["Cache tokens for 60 s", 30 * HOUR],
      ["OpenAPI: describe the error bodies", 3 * DAY],
    ],
    sslDays: 48,
    domainDays: 230,
  },
  {
    name: "Lander",
    url: "https://lander.example.com",
    live: false,
    ms: 0,
    repo: `${ORG}/lander`,
    commits: [
      ["Hero copy, second pass", 4 * HOUR],
      ["Pricing table", 1 * DAY],
    ],
    sslDays: 88,
    domainDays: 352,
  },
];

const commitsOf = (p: Plan): Commit[] =>
  p.commits.map(([message, when]) => {
    const s = sha(`${p.name} ${message}`);
    return { sha: s, message, at: ago(when), url: `https://github.com/${p.repo}/commit/${s}` };
  });
const planOf = (conn: Connection) => {
  const p = byApp.get(conn.appId);
  if (!p) throw new Error(`No demo plan for ${conn.appId}`);
  return p;
};
const byApp = new Map<string, Plan>();

// ── What each provider answers ─────────────────────────────────────────

const HOST_LABEL = { vercel: "Vercel", render: "Render", fly: "Fly.io", railway: "Railway" } as const;

function deploysOf(p: Plan): Deploy[] {
  const commits = commitsOf(p);
  const liveAt = p.liveIndex ?? 0;
  return commits.map((commit, i): Deploy => {
    const started = Date.parse(commit.at) + 40_000;
    if (p.deploying && i < liveAt) return { id: `dep_${commit.sha.slice(0, 8)}`, status: "building", phase: "in-progress", commit, startedAt: iso(started) };
    return {
      id: `dep_${commit.sha.slice(0, 8)}`,
      status: i === liveAt ? "live" : "deactivated",
      phase: i === liveAt ? "live" : "other",
      commit,
      startedAt: iso(started),
      finishedAt: iso(started + (70 + Math.round(rand() * 90)) * 1000),
    };
  });
}

function trafficOf(p: Plan): TrafficDetails {
  const point = (at: string, scale: number, wave: number): TrafficPoint => {
    const requests = Math.round(scale * (0.75 + 0.25 * wave) * (0.9 + rand() * 0.2));
    return {
      at,
      requests,
      cachedRequests: Math.round(requests * (0.62 + rand() * 0.08)),
      bytes: requests * 41_000,
      visitors: Math.round(requests / 9),
      errors5xx: Math.round(requests * 0.0004 * rand()),
    };
  };
  const hours = Array.from({ length: 24 }, (_, i) => {
    const t = NOW - (23 - i) * HOUR;
    return point(iso(t - (t % HOUR)), 2600, Math.sin(((new Date(t).getHours() - 8) / 24) * 2 * Math.PI));
  });
  const days = Array.from({ length: 30 }, (_, i) => {
    const t = NOW - (29 - i) * DAY;
    const weekend = [0, 6].includes(new Date(t).getDay());
    return point(day(t), 52_000 + i * 900, weekend ? -0.6 : 0.4);
  });
  const totals = (list: TrafficPoint[]) => {
    const sum = (k: keyof TrafficPoint) => list.reduce((n, x) => n + (x[k] as number), 0);
    const requests = sum("requests");
    return {
      requests,
      cachedPct: Math.round((sum("cachedRequests") / requests) * 1000) / 10,
      bytes: sum("bytes"),
      visitors: sum("visitors"),
      errors5xx: sum("errors5xx"),
      errorPct: Math.round((sum("errors5xx") / requests) * 10000) / 100,
    };
  };
  const pages = (scale: number) => [
    { path: "/", views: Math.round(9800 * scale) },
    { path: "/products/aurora-lamp", views: Math.round(4100 * scale) },
    { path: "/cart", views: Math.round(3300 * scale) },
    { path: "/products/orbit-mug", views: Math.round(2600 * scale) },
    { path: "/checkout", views: Math.round(1900 * scale) },
  ];
  return {
    shape: "traffic",
    zone: new URL(p.url).hostname,
    status: "active",
    paused: false,
    developmentMode: false,
    dashboardUrl: "https://dash.cloudflare.com/",
    traffic: { hours, days, totals: { day: totals(hours), week: totals(days.slice(-7)), month: totals(days) } },
    visitors: {
      state: "on",
      days: days.map((d) => ({ date: d.at, visits: Math.round(d.visitors * 0.8), pageViews: Math.round(d.visitors * 2.6) })),
      topPages: { week: pages(1), month: pages(4.2) },
      dashboardUrl: "https://dash.cloudflare.com/",
    },
  };
}

function errorsOf(conn: Connection): ErrorsDetails {
  const shop = conn.resource.endsWith("nova-shop");
  const prefix = shop ? "NOVA-SHOP" : "ORBIT-API";
  const issues = shop
    ? [
        ["TypeError: Cannot read properties of undefined (reading 'price')", "app/cart/line-item.tsx", 41, 18, 3 * HOUR],
        ["ChunkLoadError: Loading chunk 812 failed", "webpack/runtime", 17, 15, 2 * DAY],
        ["AbortError: The user aborted a request", "lib/search.ts", 9, 7, 5 * DAY],
      ]
    : [["TimeoutError: upstream took longer than 8000 ms", "routes/v2/orders.ts", 12, 3, 30 * HOUR]];
  return {
    shape: "errors",
    project: conn.resource.split("/")[1]!,
    newIn24h: shop ? 1 : 0,
    issues: issues.map(([title, culprit, count, users, first], i) => ({
      id: String(4100 + i),
      shortId: `${prefix}-${(26 + i * 7).toString(36).toUpperCase()}`,
      title: title as string,
      culprit: culprit as string,
      level: "error",
      count: count as number,
      users: users as number,
      firstSeen: ago(first as number),
      lastSeen: ago((first as number) / 6),
      url: "https://sentry.io/",
    })),
    link: { url: "https://sentry.io/", label: "All in Sentry" },
  };
}

const payments: PaymentsDetails = {
  shape: "payments",
  provider: "Stripe",
  mode: "live",
  revenue: [{ currency: "usd", last7d: 1_284_350, prev7d: 1_102_900, last30d: 4_906_120 }],
  payments7d: 214,
  failed: { last24h: 1, prev7d: 9 },
  webhooks: { failing24h: 0 },
  pastDue: 2,
  link: { url: "https://dashboard.stripe.com/", label: "All in Stripe" },
};

function commitsDetails(p: Plan): CommitsDetails {
  const commits = commitsOf(p);
  return {
    shape: "commits",
    commits,
    runs: commits.slice(0, 4).map((c, i) => ({
      id: 9000 + i,
      name: "CI",
      state: p.deploying && i === 0 ? "running" : "passing",
      ...(p.deploying && i === 0 ? {} : { conclusion: "success" }),
      sha: c.sha,
      at: c.at,
      url: `https://github.com/${p.repo}/actions`,
    })),
    branch: "main",
    link: { url: `https://github.com/${p.repo}`, label: "All on GitHub" },
  };
}

const rel = (when: number) => (when < HOUR ? `${Math.max(1, Math.round(when / MIN))} min ago` : when < DAY ? `${Math.round(when / HOUR)} h ago` : `${Math.round(when / DAY)} d ago`);

function checkOf(conn: Connection): CheckResult {
  const p = planOf(conn);
  const at = iso(NOW - Math.round(rand() * 4 * MIN));
  const commits = commitsOf(p);
  const liveCommit = commits[p.liveIndex ?? 0]!;
  const liveLine = `Live: ${liveCommit.sha.slice(0, 7)} · ${rel(NOW - Date.parse(liveCommit.at))}`;
  switch (conn.type) {
    case "site":
      return { state: "up", at, ms: Math.round(p.ms * (0.85 + rand() * 0.3)), httpStatus: 200 };
    case "ssl": {
      const until = longDate(NOW + p.sslDays * DAY);
      return p.sslDays <= 14
        ? { state: "down", at, detail: `Certificate expires in ${p.sslDays} days (${until}). Renewal failed: DNS challenge`, summary: `Expires in ${p.sslDays} d` }
        : { state: "up", at, summary: `Valid until ${until} · ${p.sslDays} days left · Let's Encrypt` };
    }
    case "domain":
      return { state: "up", at, summary: `Registered until ${new Date(NOW + p.domainDays * DAY).toLocaleDateString("en-GB", { timeZone: "UTC" })} · ${p.domainDays} days left` };
    case "github": {
      const newest = commits[0]!;
      const change = `${newest.sha.slice(0, 7)} ${rel(NOW - Date.parse(newest.at))}`;
      return { state: "up", at, summary: `${p.deploying ? "CI running" : "CI passing"} · ${change}` };
    }
    case "vercel":
    case "render":
    case "fly":
    case "railway":
      return { state: "up", at, summary: p.deploying ? `Deploying ${commits[0]!.sha.slice(0, 7)} · ${liveLine}` : liveLine };
    case "cloudflare-zone":
      return { state: "up", at, summary: "Active · 0.04% errors today" };
    case "sentry":
      return { state: "up", at, summary: "No new errors taking off" };
    case "stripe":
      return { state: "up", at, summary: "214 payments this week · no failing webhooks" };
    case "resend":
      return { state: "up", at, summary: "Verified · us-east-1" };
    case "supabase":
      return { state: "up", at, summary: "Running · eu-central-1" };
    case "neon":
      return { state: "up", at, summary: "Active · aws-eu-central-1" };
    default:
      return { state: "up", at };
  }
}

function detailsOf(conn: Connection): ConnectionDetails {
  const p = planOf(conn);
  switch (conn.type) {
    case "github":
      return commitsDetails(p);
    case "cloudflare-zone":
      return trafficOf(p);
    case "sentry":
      return errorsOf(conn);
    case "stripe":
      return payments;
    default: {
      const host = p.host!;
      const provider = HOST_LABEL[host];
      return { shape: "deploys", deploys: deploysOf(p).slice(0, 10), link: { url: "https://example.com/", label: `All in ${provider}` } };
    }
  }
}

for (const integration of Object.values(integrations)) {
  if (integration.check) integration.check = async (conn) => checkOf(conn);
  if (integration.details) integration.details = async (conn) => detailsOf(conn);
  if (integration.listResources) integration.listResources = async () => [];
  if (integration.testService) integration.testService = async (auth) => ({ message: `Works · ${auth.service.name}, read-only` });
  if (integration.planUsage) integration.planUsage = async () => [{ label: "Workers requests today", used: 23_400, limit: 100_000, resetsAt: iso(NOW + 9 * HOUR) }];
  if (integration.latestCommit) integration.latestCommit = async (conn) => commitsOf(planOf(conn))[0];
  if (integration.contains) {
    // Is `head` the same as, or newer than, `base`? Newest first in the plan.
    integration.contains = async (conn, _auth, head, base) => {
      const shas = commitsOf(planOf(conn)).map((c) => c.sha);
      return shas.indexOf(head) <= shas.indexOf(base);
    };
  }
  if (integration.commitUrl) integration.commitUrl = (conn, s) => `https://github.com/${planOf(conn).repo}/commit/${s}`;
  if (integration.deploys) integration.deploys = async (conn) => deploysOf(planOf(conn));
  delete integration.buildCheckName;
  delete integration.buildChecks;
}

// ── The registry ────────────────────────────────────────────────────────

const fresh = !existsSync(path.join(DIR, "periskopos.db"));
const db = openDb(path.join(DIR, "periskopos.db"));

if (fresh) {
  const SERVICES = [
    ["github", "GitHub · nova-labs", "DEMO_GITHUB_TOKEN"],
    ["vercel", "Vercel · Nova Labs", "DEMO_VERCEL_TOKEN"],
    ["render", "Render · Nova Labs", "DEMO_RENDER_KEY"],
    ["fly", "Fly.io · nova-labs", "DEMO_FLY_TOKEN"],
    ["railway", "Railway · Nova Labs", "DEMO_RAILWAY_TOKEN"],
    ["cloudflare", "Cloudflare · Nova Labs", "DEMO_CLOUDFLARE_TOKEN"],
    ["sentry", "Sentry · nova-labs", "DEMO_SENTRY_TOKEN"],
    ["stripe", "Stripe · Nova Shop", "DEMO_STRIPE_KEY"],
    ["resend", "Resend · Comet Mail", "DEMO_RESEND_KEY"],
    ["supabase", "Supabase · Nova Labs", "DEMO_SUPABASE_TOKEN"],
    ["neon", "Neon · Nova Labs", "DEMO_NEON_KEY"],
  ] as const;
  // Placeholder keys, so every account counts as connected: the providers
  // are answered above and never see them.
  writeFileSync(process.env.PERISKOPOS_ENV_FILE, SERVICES.map(([, , ref]) => `${ref}=demo-not-a-real-key`).join("\n") + "\n");

  const user = store.createUser(db, "Alex");
  db.prepare("UPDATE users SET created_at = ? WHERE id = ?").run(ago(40 * DAY), user.id);
  const services = new Map<string, Service>(
    SERVICES.map(([type, name, ref]) => {
      const s = store.createService(db, user.id, { type, name, secretRef: ref, canWrite: type === "vercel" || type === "cloudflare" });
      store.setServiceLastTest(db, s, { ok: true, message: `Works · ${name}, read-only`, at: ago(3 * HOUR) });
      return [type, s] as const;
    }),
  );
  store.setServicePlanUsage(db, services.get("cloudflare")!, { at: ago(20 * MIN), meters: [{ label: "Workers requests today", used: 23_400, limit: 100_000, resetsAt: iso(NOW + 9 * HOUR) }] });

  // Watched for the last 30 days, but for two nights the PC was off.
  const periods: [number, number][] = [
    [NOW - 30 * DAY, NOW - 18 * DAY - 7 * HOUR],
    [NOW - 18 * DAY, NOW - 9 * DAY - 6 * HOUR],
    [NOW - 9 * DAY, NOW],
  ];
  for (const [from, to] of periods) db.prepare("INSERT INTO watch_periods (started_at, last_seen_at) VALUES (?, ?)").run(iso(from), iso(to));
  const watched = (t: number) => periods.some(([a, b]) => t >= a && t <= b);

  const incident = db.prepare("INSERT INTO incidents (id, app_id, connection_id, started_at, ended_at, reason, kind) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const finding = db.prepare(
    `INSERT INTO findings (app_id, id, source, connection_id, key, severity, title, why, fix, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const activity = db.prepare("INSERT INTO activity (id, app_id, at, action_id, label, source, ok, message, agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const newId = (prefix: string) => `${prefix}_${randomBytes(8).toString("base64url")}`;

  for (const plan of PLANS) {
    const app = store.createApp(db, user.id, { name: plan.name, url: plan.url, ...(plan.live === false ? { live: false } : {}) });
    db.prepare("UPDATE apps SET created_at = ? WHERE id = ?").run(ago(40 * DAY), app.id);
    byApp.set(app.id, plan);
    store.addConnection(db, app, { type: "github", resource: plan.repo, serviceId: services.get("github")!.id, settings: { branch: "main" } });
    if (plan.host) store.addConnection(db, app, { type: plan.host, resource: plan.hostResource!, serviceId: services.get(plan.host)!.id });
    for (const extra of plan.extras ?? []) {
      const account = extra.type === "cloudflare-zone" ? "cloudflare" : extra.type;
      store.addConnection(db, app, { type: extra.type, resource: extra.resource, serviceId: services.get(account)!.id });
    }
    const conns = store.getApp(db, user.id, app.slug)!.connections;
    const conn = (type: string) => conns.find((c) => c.type === type)!;

    // A month of status checks, every 10 minutes while watched.
    if (plan.live !== false) {
      const site = conn("site");
      db.exec("BEGIN");
      for (let t = NOW - 30 * DAY; t < NOW - 10 * MIN; t += 10 * MIN) {
        if (!watched(t)) continue;
        const wobble = 0.85 + rand() * 0.3 + (rand() < 0.02 ? rand() : 0);
        recordCheck(db, app.id, site.id, { state: "up", at: iso(t), ms: Math.round(plan.ms * wobble), httpStatus: 200 });
      }
      db.exec("COMMIT");
    }
    // The latest of everything, as the providers answer it now.
    for (const c of conns) {
      if (plan.live === false && (c.type === "site" || c.type === "ssl")) continue;
      recordCheck(db, app.id, c.id, checkOf(c));
    }

    const at = (ms: number) => ago(ms);
    if (plan.name === "Nova-Shop") {
      incident.run(newId("i"), app.id, conn("site").id, at(12 * DAY + 3 * HOUR), at(12 * DAY + 3 * HOUR - 4 * MIN), "Timed out after 10 s", "outage");
      incident.run(newId("i"), app.id, conn("vercel").id, at(3 * DAY + 6 * HOUR), at(3 * DAY + 5 * HOUR), "Deploy failed (error): Bump next to 16.2", "deploy");
      finding.run(app.id, "cloudflare-zone:rocket-loader-csp", "cloudflare-zone", conn("cloudflare-zone").id, "rocket-loader-csp", "high",
        "Rocket Loader is on, but the site's Content-Security-Policy blocks its script",
        "Rocket Loader rewrites the page's script tags and starts them from an inline script of its own. The site's policy doesn't allow inline scripts, so none of the page's JavaScript runs for visitors.",
        JSON.stringify({ steps: "Turn Rocket Loader off for this domain (Speed → Settings → Content Optimization), or allow its script in the policy.", link: { url: "https://dash.cloudflare.com/", label: "Open in Cloudflare" } }),
        at(2 * DAY), at(2 * HOUR));
      finding.run(app.id, "github:branch-protection:main", "github", conn("github").id, "branch-protection:main", "medium",
        "main can be force-pushed and deleted",
        "Anyone with write access can rewrite or delete the branch your site deploys from, by mistake or otherwise.",
        JSON.stringify({ steps: "Add a ruleset for main that blocks force pushes and deletion.", link: { url: `https://github.com/${plan.repo}/settings/rules`, label: "Open in GitHub" } }),
        at(9 * DAY), at(2 * HOUR));
      finding.run(app.id, "site:referrer-policy", "site", null, "referrer-policy", "low",
        "No Referrer-Policy header",
        "Without one, older browsers send the full address of the page, query string included, to every site it links to.",
        JSON.stringify({ steps: "Send this header with every page.", code: "Referrer-Policy: strict-origin-when-cross-origin" }),
        at(9 * DAY), at(2 * HOUR));
      activity.run(newId("act"), app.id, at(26 * HOUR), "purge-cache", "Purge cache", "ui", 1, "Purged everything for nova-shop.example.org", null);
      activity.run(newId("act"), app.id, at(3 * DAY + 5 * HOUR + 10 * MIN), "redeploy", "Redeploy", "mcp", 1, "Redeploying the live deploy", "Claude");
    }
    if (plan.name === "Comet-Mail") {
      incident.run(newId("i"), app.id, conn("ssl").id, at(5 * DAY), null, `Certificate expires in ${plan.sslDays} days. Renewal failed: DNS challenge`, "expiry");
      finding.run(app.id, "dns:dmarc-missing", "dns", null, "dmarc-missing", "medium",
        "No DMARC record",
        "Comet-Mail sends from this domain. Without DMARC, inboxes have no policy for mail that fails SPF and DKIM, and anyone can send in its name.",
        JSON.stringify({ steps: "Add this TXT record at _dmarc.comet-mail.example.com.", code: "v=DMARC1; p=quarantine; rua=mailto:dmarc@comet-mail.example.com" }),
        at(14 * DAY), at(3 * HOUR));
      finding.run(app.id, "site:csp-missing", "site", null, "csp-missing", "medium",
        "No Content-Security-Policy",
        "A policy limits where scripts can come from, so an injected script can't run or send your users' data elsewhere.",
        JSON.stringify({ steps: "Start from a strict policy and loosen it only where the site needs it.", code: "Content-Security-Policy: default-src 'self'; frame-ancestors 'none'" }),
        at(14 * DAY), at(3 * HOUR));
    }
    if (plan.name === "Orbit-API") {
      incident.run(newId("i"), app.id, conn("site").id, at(6 * DAY + 2 * HOUR), at(6 * DAY + 2 * HOUR - 14 * MIN), "Answered HTTP 502", "outage");
      incident.run(newId("i"), app.id, conn("site").id, at(21 * DAY + 9 * HOUR), at(21 * DAY + 9 * HOUR - 6 * MIN), "Answered HTTP 503", "outage");
    }
    if (plan.name === "Moon-Base") {
      finding.run(app.id, "dns:caa-missing", "dns", null, "caa-missing", "low",
        "No CAA record",
        "Any certificate authority may issue certificates for this domain. A CAA record names the ones you use.",
        JSON.stringify({ steps: "Add a CAA record for the authority that issues your certificate.", code: 'moon-base.example.net. CAA 0 issue "letsencrypt.org"' }),
        at(20 * DAY), at(4 * HOUR));
    }
    db.prepare("INSERT INTO audits (app_id, checked_at, notes) VALUES (?, ?, '[]')").run(app.id, at(4 * HOUR));
  }
  // Assistants switched on, with two for the Settings → AI assistants page:
  // one sees every app and may ask for actions, one only reads Nova-Shop.
  const appIds = Object.fromEntries(store.listApps(db, store.getLocalUser(db)!.id).map((a) => [a.name, a.id]));
  createAgent(db, { name: "Claude Code", access: "ask", apps: "all" });
  createAgent(db, { name: "Cursor", access: "read", apps: [appIds["Nova-Shop"]] });
  updateSettings(db, store.getLocalUser(db)!.id, { agentAccess: true });
} else {
  const user = store.getLocalUser(db)!;
  for (const app of store.listApps(db, user.id)) {
    const plan = PLANS.find((p) => p.name === app.name);
    if (plan) byApp.set(app.id, plan);
  }
}

// ── The server ──────────────────────────────────────────────────────────

const OPERATIONAL = { indicator: "none" as const, description: "All Systems Operational", incidents: [] };
const token = newSessionKey();
const watcher = new Watcher({
  db,
  notifier: silentNotifier,
  baseUrl: `http://localhost:${PORT}`,
  isOnline: async () => true,
  fetchProvider: async () => OPERATIONAL,
});
const app = createApp({ db, token, agentToken: loadOrCreateToken(DIR), port: PORT, distDir: DIST_WEB, notifier: silentNotifier, watcher });
// Written down, unlike the app's own key: this one opens only the demo's
// made-up data, and the capture script needs it.
writeFileSync(path.join(DIR, "session-key"), token);

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, () => {
  // The watcher stays off: the history above is the demo's, and a check
  // runs only on Check now.
  console.log(`Demo Periskopos at http://localhost:${PORT} (session key in ${path.relative(ROOT, path.join(DIR, "session-key"))})`);
});
