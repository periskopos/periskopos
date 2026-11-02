import assert from "node:assert/strict";
import { describe, test } from "node:test";
// First: it puts the DOM in place, which ui.ts needs as it loads.
import { text, unnamed, until } from "./dom-helpers.ts";
import { getMoreSection } from "../web/src/views/app/getMore.ts";
import type { App, AppHistory, AppStatus, ConnectionDetails, SearchDetails, TrafficDetails, TrafficTotals } from "../shared/types.ts";
import { mount } from "../web/src/dom.ts";
import type { Child } from "../web/src/dom.ts";
import { banner as bannerOf, header } from "../web/src/views/app/header.ts";
import { history } from "../web/src/views/app/history.ts";
import { actionsTab, deploysTab, tabsOf, trafficTab } from "../web/src/views/app/tabs.ts";
import { overview } from "../web/src/views/app/overview.ts";
import type { AppPage } from "../web/src/views/app/page.ts";
import { settingsTab } from "../web/src/views/app/settings.ts";
import { configTab } from "../web/src/views/app/config.ts";

// The app page's tabs, drawn into a DOM from fixed data: what's on screen
// for each kind of connection, without a server, an account or a window.
// The details come in their shapes (deploys, commits, traffic, search), so these
// cover the panels whatever provider fills them.

// Whether an element is there, as a plain yes or no for assert: a failing
// assert prints what it was given in full, and a node reaches the whole
// document, so printing it never ends and the test hangs instead of failing.
const isThere = (el: Element | null | undefined) => el != null;

const NOW = new Date().toISOString();
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

const app: App = {
  id: "a_1",
  slug: "star-map",
  ownerId: "u_1",
  name: "Star-Map",
  url: "https://example.org/",
  live: true,
  checkIntervalMin: 5,
  connections: [
    { id: "c_site", appId: "a_1", type: "site", resource: "https://example.org/" },
    { id: "c_gh", appId: "a_1", type: "github", serviceId: "s_gh", resource: "acme/apps", settings: { branch: "main", paths: ["apps/star-map"] } },
    { id: "c_cf", appId: "a_1", type: "cloudflare", serviceId: "s_cf", resource: "star-map", settings: { kind: "worker", name: "star-map", accountId: "a".repeat(32) } },
    { id: "c_zone", appId: "a_1", type: "cloudflare-zone", serviceId: "s_cf", resource: "example.org", settings: { zoneId: "z".repeat(32), accountId: "a".repeat(32), host: "example.org" } },
    { id: "c_gsc", appId: "a_1", type: "search-console", serviceId: "s_gsc", resource: "sc-domain:example.org" },
  ],
};

const status: AppStatus = {
  slug: "star-map",
  state: "attention",
  checks: {
    c_site: { state: "up", at: NOW, ms: 347, httpStatus: 200 },
    c_gh: { state: "down", at: NOW, detail: "Cloudflare's build of star-map failed on 3de65c7", summary: "Cloudflare build failed", link: { url: "https://dash.cloudflare.com/x/builds/d1", label: "Open the failed build on Cloudflare" } },
  },
};

const totals: TrafficTotals = { requests: 1200, cachedPct: 40, bytes: 5_000_000, visitors: 90, errors5xx: 2, errorPct: 0.2 };
const point = (at: string) => ({ at, requests: 50, cachedRequests: 20, bytes: 1000, visitors: 4, errors5xx: 0 });
const traffic: TrafficDetails = {
  shape: "traffic",
  zone: "example.org",
  status: "active",
  paused: false,
  developmentMode: false,
  traffic: {
    hours: Array.from({ length: 24 }, (_, i) => point(ago((24 - i) * 60))),
    days: Array.from({ length: 30 }, (_, i) => point(`2026-09-${String(i + 1).padStart(2, "0")}`)),
    totals: { day: totals, week: totals, month: totals },
  },
  visitors: { state: "off", message: "Web Analytics is off for this site." },
};

const searchDay = (i: number) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, clicks: 10, impressions: 200, position: 6.5 });
const search: SearchDetails = {
  shape: "search",
  site: "example.org",
  through: "2026-09-28",
  days: Array.from({ length: 28 }, (_, i) => searchDay(i)),
  totals: {
    week: { clicks: 70, impressions: 1400, ctrPct: 5, position: 6.5 },
    previousWeek: { clicks: 56, impressions: 1400, ctrPct: 4, position: 7 },
    month: { clicks: 280, impressions: 5600, ctrPct: 5, position: 6.8 },
  },
  topQueries: {
    week: [{ query: "star map", clicks: 40, impressions: 300, position: 1.2 }],
    month: [
      { query: "star map", clicks: 150, impressions: 1200, position: 1.3 },
      { query: "exoplanet viewer", clicks: 30, impressions: 2000, position: 8.4 },
    ],
  },
  dashboardUrl: "https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Aexample.org",
};

const commit = (sha: string, message: string) => ({ sha, message, at: ago(30) });
const details = (): Map<string, ConnectionDetails | Error> =>
  new Map<string, ConnectionDetails | Error>([
    [
      "c_gh",
      {
        shape: "commits",
        commits: [commit("3de65c7aaaa", "Release 0.11.0"), commit("b5a4897bbbb", "Perf audit")],
        runs: [{ id: 1, name: "CI", state: "passing", sha: "3de65c7aaaa", at: ago(20), url: "https://github.com/acme/apps/actions/runs/1" }],
        branch: "main",
        link: { url: "https://github.com/acme/apps", label: "All on GitHub" },
      },
    ],
    [
      "c_cf",
      {
        shape: "deploys",
        deploys: [{ id: "d1", status: "live", phase: "live", startedAt: ago(40) }],
        link: { url: "https://dash.cloudflare.com/x/workers/services/view/star-map/production", label: "All in Cloudflare" },
      },
    ],
    ["c_zone", traffic],
    ["c_gsc", search],
  ]);

const hist: AppHistory = {
  from: ago(30 * 24 * 60),
  to: NOW,
  uptimePct: 100,
  watchedMin: 7000,
  incidents: [{ id: "i1", appId: "a_1", connectionId: "c_gh", kind: "ci", startedAt: ago(500), endedAt: ago(40), reason: "Cloudflare's build of star-map failed on 3de65c7" }],
  gaps: [],
  days: Array.from({ length: 30 }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, "0")}`, watchedMin: i < 20 ? 0 : 1440, incidents: 0, ...(i < 20 ? {} : { uptimePct: 100 }) })),
};

function page(over: Partial<AppPage> = {}): AppPage {
  return {
    slug: "star-map",
    tab: "overview",
    settingsPart: "general",
    base: "#/apps/star-map",
    apiBase: "/apps/star-map",
    app,
    status,
    hist,
    services: [
      { id: "s_gh", ownerId: "u_1", type: "github", name: "My GitHub", canWrite: false, keyState: "gh", apps: [] },
      { id: "s_cf", ownerId: "u_1", type: "cloudflare", name: "My Cloudflare", canWrite: false, keyState: "set", apps: [] },
    ],
    details: details(),
    providers: [],
    protocolState: {},
    activity: [],
    trafficRange: "week",
    searchRange: "week",
    gapsOpen: false,
    draw: () => {},
    afterSubmit: async () => true,
    openAction: () => {},
    connectSuggested: async () => {},
    gone: () => {},
    ...over,
  };
}

// The tab, drawn into a fresh container to query, the way the page mounts it.
// A section is found by its heading's id: [aria-labelledby=s-deploys].
function draw(nodes: Child[]): HTMLElement {
  const root = document.createElement("div");
  mount(root, ...nodes);
  return root;
}

describe("Overview", () => {
  test("Payments: revenue, failed payments and webhooks, in the account's currency, for any provider", () => {
    const withStripe: App = { ...app, connections: [...app.connections, { id: "c_pay", appId: "a_1", type: "stripe", serviceId: "s_st", resource: "acct_1", settings: { name: "Star Shop" } }] };
    const d = details();
    d.set("c_pay", {
      shape: "payments",
      provider: "Stripe",
      mode: "test",
      revenue: [{ currency: "EUR", last7d: 125000, prev7d: 100000, last30d: 480000 }, { currency: "USD", last7d: 0, prev7d: 0, last30d: 9900 }],
      payments7d: 42,
      failed: { last24h: 2, prev7d: 9 },
      webhooks: { failing24h: 0 },
      link: { url: "https://dashboard.stripe.com/test/payments", label: "All in Stripe" },
    });
    const root = draw(overview(page({ app: withStripe, details: d }), withStripe));
    const pay = root.querySelector("[aria-labelledby=s-payments]");
    assert.ok(pay, "Payments");
    const t = text(pay);
    assert.match(t, /All in Stripe/);
    assert.match(t, /1,250\.00/);
    assert.match(t, /\+25% on the week before/);
    assert.match(t, /42 payments this week/);
    assert.match(t, /2.*9 in the 7 days before/);
    assert.match(t, /Delivered/);
    assert.match(t, /Test mode: no real money\..*Also, last 30 days: .*99\.00/);
    assert.deepEqual(unnamed(root), []);

    const failed = details();
    failed.set("c_pay", new Error("Stripe rejected the key (401)"));
    assert.match(text(draw(overview(page({ app: withStripe, details: failed }), withStripe)).querySelector("[aria-labelledby=s-payments]")), /Stripe rejected the key/);
  });

  test("Errors (Sentry): unresolved issues, those since the last deploy marked, a link to Sentry", () => {
    const withSentry: App = { ...app, connections: [...app.connections, { id: "c_sentry", appId: "a_1", type: "sentry", serviceId: "s_sn", resource: "acme/star-map", settings: { name: "star-map" } }] };
    const d = details();
    const issue = (id: string, firstMin: number) => ({ id, shortId: `EXO-${id}`, title: `TypeError ${id}`, culprit: "src/app.ts", level: "error", count: 1200, users: 40, firstSeen: ago(firstMin), lastSeen: ago(1), url: `https://sentry.io/issues/${id}/` });
    d.set("c_sentry", { shape: "errors", project: "acme/star-map", issues: [issue("1", 20), issue("2", 9000)], newIn24h: 1, link: { url: "https://sentry.io/organizations/acme/projects/star-map/", label: "All in Sentry" } });
    const root = draw(deploysTab(page({ app: withSentry, details: d }), withSentry));
    const errors = root.querySelector("[aria-labelledby=s-errors]");
    assert.ok(errors, "Errors");
    assert.match(text(errors), /All in Sentry/);
    assert.match(text(errors), /1 new in 24 h · 1 since the last deploy/, "the live deploy went out 40 min ago");
    const items = [...errors.querySelectorAll("li")].map(text);
    assert.match(items[0]!, /TypeError 1.*new since the last deploy.*1\.2k events · 40 users/);
    assert.doesNotMatch(items[1]!, /since the last deploy/);
    assert.deepEqual(unnamed(root), []);

    const empty = details();
    empty.set("c_sentry", { shape: "errors", project: "acme/star-map", issues: [], newIn24h: 0, link: { url: "https://sentry.io/", label: "All in Sentry" } });
    assert.match(text(draw(deploysTab(page({ app: withSentry, details: empty }), withSentry)).querySelector("[aria-labelledby=s-errors]")), /No unresolved errors/);
    assert.equal(isThere(draw(deploysTab(page(), app)).querySelector("[aria-labelledby=s-errors]")), false, "no Sentry, no panel");
  });

  test("each shape gets its panel, with its provider's own link", () => {
    const root = draw(deploysTab(page(), app));
    const trafficRoot = draw(trafficTab(page(), app));
    const deploys = root.querySelector("[aria-labelledby=s-deploys]");
    const commits = root.querySelector("[aria-labelledby=s-commits]");
    assert.ok(deploys, "Deploys");
    assert.ok(commits, "Commits");
    assert.ok(trafficRoot.querySelector("[aria-labelledby=s-traffic]"), "Traffic");
    assert.equal(deploys.querySelector("a")?.textContent?.includes("All in Cloudflare"), true);
    assert.match(text(commits), /All on GitHub/);
    assert.match(text(commits), /3de65c7.*Release 0\.11\.0/);
    assert.equal(commits.querySelectorAll("li").length, 2);
  });

  test("still loading says so; a provider that failed says why, in its panel", () => {
    const loading = draw(deploysTab(page({ details: new Map() }), app));
    const loadingTraffic = draw(trafficTab(page({ details: new Map() }), app));
    assert.match(text(loading.querySelector("[aria-labelledby=s-deploys]")), /Loading…/);
    assert.match(text(loadingTraffic.querySelector("[aria-labelledby=s-traffic]")), /Loading…/);

    const failed = details();
    failed.set("c_cf", new Error("Cloudflare refused access (403)"));
    const root = draw(deploysTab(page({ details: failed }), app));
    assert.match(text(root.querySelector("[aria-labelledby=s-deploys]")), /Cloudflare refused access \(403\)/);
    assert.match(text(root.querySelector("[aria-labelledby=s-commits]")), /Release 0\.11\.0/, "one failure doesn't blank the others");
  });

  test("checks: a failing build needs attention, it isn't an outage", () => {
    const checks = draw(overview(page(), app)).querySelector("[aria-labelledby=s-checks]");
    assert.ok(checks);
    const github = [...checks.querySelectorAll("li")].find((li) => text(li).startsWith("GitHub"));
    assert.ok(github?.querySelector(".lamp--attention"), "attention, not down");
    assert.match(text(github), /failed on 3de65c7/);
    assert.equal(github?.querySelector("a[href='https://dash.cloudflare.com/x/builds/d1']")?.textContent?.includes("Open the failed build on Cloudflare"), true);
    assert.match(text(checks), /347 ms/);
  });

  test("no host or source: no empty panels, a pointer to connect them", () => {
    const bare: App = { ...app, connections: [app.connections[0]!] };
    const root = draw(overview(page({ app: bare, details: new Map() }), bare));
    assert.equal(isThere(root.querySelector("[aria-labelledby=s-deploys]")), false);
    assert.equal(isThere(root.querySelector("[aria-labelledby=s-traffic]")), false);
    assert.match(text(root.querySelector("[aria-labelledby=s-deploys-and-commits]")), /Connect GitHub and your host/);
  });
});

describe("the Search panel", () => {
  const panel = (over: Partial<AppPage> = {}) => draw(trafficTab(page(over), app)).querySelector("[aria-labelledby=s-search]");

  test("7 days: clicks against the week before, the chart, top queries, a link to Search Console", () => {
    const s = panel();
    assert.ok(s, "Search");
    assert.match(text(s), /Clicks\s*70\s*\+25% on the week before/);
    assert.match(text(s), /Click rate\s*5%/);
    assert.match(text(s), /Avg position\s*6\.5/);
    assert.equal(s.querySelectorAll(".tchart-col").length, 7);
    assert.match(text(s), /example\.org in Google Search, through .+: search numbers come in a few days late/);
    assert.equal(s.querySelectorAll(".top-pages li").length, 1);
    assert.match(text(s.querySelector(".top-pages")), /star map\s*40 clicks · 300 shown · #1\.2/);
    assert.ok(s.querySelector("a[href^='https://search.google.com/search-console/']"));
    assert.equal(isThere(s.querySelector(".notice")), false, "no drop, no notice");
  });

  test("28 days: the month's figures, chart and queries", () => {
    const s = panel({ searchRange: "month" });
    assert.match(text(s), /Clicks\s*280\s*from search results/);
    assert.equal(s?.querySelectorAll(".tchart-col").length, 28);
    assert.equal(s?.querySelectorAll(".top-pages li").length, 2);
    assert.equal(s?.querySelector("[aria-pressed=true]")?.textContent, "28 days");
  });

  test("a sharp drop is flagged; no data yet, still loading and a failure each say so", () => {
    const dropped = details();
    dropped.set("c_gsc", { ...search, drop: { clicks: 20, before: 70, dropPct: 71 } });
    assert.match(text(panel({ details: dropped })?.querySelector(".notice")), /Clicks fell 71% on the week before: 20 against 70/);

    const none = details();
    none.set("c_gsc", { ...search, through: undefined, days: [] });
    assert.match(text(panel({ details: none })), /No search data for example\.org yet/);

    assert.match(text(panel({ details: new Map() })), /Loading…/);

    const failed = details();
    failed.set("c_gsc", new Error("Search Console refused access (403)"));
    assert.match(text(panel({ details: failed })), /Search Console refused access \(403\)/);
  });

  test("an app without Search Console has no Search panel", () => {
    const bare: App = { ...app, connections: app.connections.filter((c) => c.type !== "search-console") };
    assert.equal(isThere(draw(trafficTab(page({ app: bare }), bare)).querySelector("[aria-labelledby=s-search]")), false);
  });
});

describe("every control has a name", () => {
  test("on every tab, and in the header", () => {
    const tabs = {
      overview: draw(overview(page(), app)),
      deploys: draw(deploysTab(page({ tab: "deploys" }), app)),
      traffic: draw(trafficTab(page({ tab: "traffic" }), app)),
      actions: draw(actionsTab(page({ tab: "actions" }))),
      history: draw(history(page({ tab: "history" }))),
      settings: draw(settingsTab(page({ tab: "settings" }), app)),
      header: draw([header(page(), { ...app, icon: "/i.png" }, document.createElement("button"))]),
    };
    // The "Check now" button is made by the page itself; here it's a stand-in.
    tabs.header.querySelector(".actions button")?.remove();
    for (const [tab, root] of Object.entries(tabs)) assert.deepEqual(unnamed(root), [], tab);
  });

  test("the check itself catches what it should", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button></button><a href="#"><span aria-hidden="true">↗</span></a><input name="x"><img src="x.png"><button aria-label="Close"></button><label>Name <input name="y"></label><img src="d.png" alt="">`;
    assert.equal(unnamed(root).length, 4);
  });
});

describe("the incident banner", () => {
  const banner = (reason: string) => {
    const incident = { id: "i2", appId: "a_1", connectionId: "c_gh", kind: "ci" as const, startedAt: ago(30), reason };
    return text(draw([header(page(), app, document.createElement("button")), bannerOf(page({ status: { ...status, incident } }))]).querySelector(".banner"));
  };
  test("says the kind only when the reason doesn't already", () => {
    assert.match(banner("CI failing on main"), /CI failing on main/, "the banner is drawn");
    assert.doesNotMatch(banner("CI failing on main"), /· CI/);
    assert.match(banner("Cloudflare's build of star-map failed on 3de65c7"), /· CI$/);
  });
});

describe("the figures strip", () => {
  test("failing CI needs attention: amber, like the banner, not the outage red", () => {
    const failing = details();
    const gh = failing.get("c_gh");
    if (gh && !(gh instanceof Error) && gh.shape === "commits") gh.runs = [{ ...gh.runs[0]!, state: "failing", conclusion: "failure" }];
    const strip = draw(overview(page({ details: failing }), app)).querySelector(".figures");
    const ci = [...(strip?.querySelectorAll(".figure") ?? [])].find((f) => text(f).startsWith("CI"));
    assert.match(text(ci), /Failing/);
    assert.ok(ci?.querySelector(".lamp--attention"), "attention");
    assert.equal(isThere(ci?.querySelector(".lamp--down")), false, "not down");
  });
});

describe("History and Settings", () => {
  test("History: 30 days of bars, the incident with its kind", () => {
    const root = draw(history(page({ tab: "history" })));
    assert.equal(root.querySelectorAll(".bars .bar").length, 30);
    assert.equal(root.querySelectorAll(".bar--up").length, 10);
    assert.match(text(root.querySelector("[aria-labelledby=s-incidents]")), /CI.*failed on 3de65c7/);
  });

  test("Settings: each connection named by what it is, with where it points", () => {
    const root = draw(settingsTab(page({ tab: "settings", settingsPart: "connections" }), app));
    const connections = text(root.querySelector("[aria-labelledby=s-connections]"));
    assert.match(connections, /Cloudflare Worker/);
    assert.match(connections, /Cloudflare domain/);
    assert.match(connections, /acme\/apps · branch main · apps\/star-map · via My GitHub/);
    // The status check is listed once, under Status checks.
    assert.doesNotMatch(connections, /Status check/);
    assert.match(text(root.querySelector("[aria-labelledby=s-status-checks]")), /Status check/);
  });

  test("the header: name, state, and the app's letter until it has an icon", () => {
    const el = header(page(), app, document.createElement("button"));
    assert.match(text(el), /Star-Map/);
    assert.equal(el.querySelector(".app-icon--letter")?.textContent, "S");
    const withIcon = header(page(), { ...app, icon: "/api/apps/star-map/icon?v=1" }, document.createElement("button"));
    assert.equal(withIcon.querySelector("img.app-icon")?.getAttribute("src"), "/api/apps/star-map/icon?v=1");
  });
});

describe("status checks in Settings", () => {
  // The app's own check expects a word and alerts when slow; an extra URL
  // checks its API's health field.
  const withChecks: App = {
    ...app,
    connections: [
      { ...app.connections[0]!, settings: { expectText: "Welcome", slowMs: 1500, slowChecks: 3 } },
      { id: "c_api", appId: "a_1", type: "site", resource: "https://api.example.org/health", settings: { label: "API health", expectJson: "status=ok" } },
      ...app.connections.slice(1),
    ],
  };
  const settings = () => draw(settingsTab(page({ tab: "settings", settingsPart: "connections", app: withChecks }), withChecks));

  test("each URL with what it expects; the app's own follows its URL, an extra one can be removed", () => {
    const section = settings().querySelector("[aria-labelledby=s-status-checks]");
    assert.ok(section);
    const [own, api] = [...section.querySelectorAll<HTMLElement>("li[data-connection]")];
    assert.match(text(own), /Status check.*example\.org.*Expects: contains “Welcome” · slow over 1500 ms × 3.*follows the app's URL/);
    assert.match(text(api), /API health.*api\.example\.org\/health.*Expects: JSON status=ok/);
    assert.equal(isThere(own?.querySelector(".btn--danger")), false);
    assert.equal(api?.querySelector(".btn--danger")?.getAttribute("aria-label"), "Remove the API health check");
    assert.match(text(section), /Check another URL/);
  });

  test("its settings form shows what's saved, and blank means off", () => {
    const own = settings().querySelector<HTMLElement>("li[data-connection=c_site]")!;
    assert.equal(own.querySelector<HTMLInputElement>("input[name=expectText]")?.value, "Welcome");
    assert.equal(own.querySelector<HTMLInputElement>("input[name=slowMs]")?.value, "1500");
    assert.equal(own.querySelector<HTMLSelectElement>("select[name=slowChecks]")?.value, "3");
    const api = settings().querySelector<HTMLElement>("li[data-connection=c_api]")!;
    assert.equal(api.querySelector<HTMLInputElement>("input[name=expectJson]")?.value, "status=ok");
    assert.equal(api.querySelector<HTMLInputElement>("input[name=slowMs]")?.value, "");
    assert.equal(api.querySelector<HTMLInputElement>("input[name=slowMs]")?.placeholder, "Off");
  });

  test("an extra URL isn't listed again under Connections; every control has a name", () => {
    const root = settings();
    assert.doesNotMatch(text(root.querySelector("[aria-labelledby=s-connections]")), /API health/);
    assert.deepEqual(unnamed(root), []);
  });

  test("Overview: the extra URL is a check of its own, and a slow answer says so", () => {
    const s: AppStatus = {
      ...status,
      checks: {
        ...status.checks,
        c_site: { state: "up", at: NOW, ms: 1720, httpStatus: 200, summary: "Slow: 1720 ms, over 1500 ms" },
        c_api: { state: "down", at: NOW, httpStatus: 200, detail: "“status” is degraded, not ok" },
      },
    };
    const checks = draw(overview(page({ app: withChecks, status: s }), withChecks)).querySelector("[aria-labelledby=s-checks]")!;
    const rows = [...checks.querySelectorAll("li")];
    assert.match(text(rows.find((li) => text(li).startsWith("Status check"))), /Slow: 1720 ms, over 1500 ms/);
    const api = rows.find((li) => text(li).startsWith("API health"));
    assert.ok(api?.querySelector(".lamp--down"));
    assert.match(text(api), /api\.example\.org\/health.*“status” is degraded, not ok/);
  });
});

describe("the app's tabs", () => {
  const keys = (p: AppPage, a: App) => tabsOf(p, a).map((t) => t.key);

  test("Deploys and Traffic once something fills them; Actions once there's an action or a run", () => {
    assert.deepEqual(keys(page(), app), ["overview", "deploys", "traffic", "config", "history", "settings"]);
    const bare: App = { ...app, connections: [app.connections[0]!] };
    assert.deepEqual(keys(page({ app: bare }), bare), ["overview", "config", "history", "settings"], "Configuration always: every app has a site to check");
    const withAction = page({ actions: { actions: [{ id: "redeploy:c_cf", label: "Redeploy", service: "My Cloudflare" }], blocked: [] } as unknown as AppPage["actions"] });
    assert.ok(keys(withAction, app).includes("actions"));
  });

  test("a tab with nothing in it still shows while it's open, and says how to fill it", () => {
    const bare: App = { ...app, connections: [app.connections[0]!] };
    const p = page({ app: bare, tab: "traffic" });
    assert.ok(keys(p, bare).includes("traffic"));
    assert.match(text(draw(trafficTab(p, bare))), /Connect the app's Cloudflare domain or Google Search Console/);
  });

  test("back to the list is a button, above the name", () => {
    const back = draw([header(page(), app, document.createElement("button"))]).querySelector("a.btn.back-button");
    assert.equal(back?.getAttribute("href"), "#/");
    assert.match(text(back), /All apps/);
  });
});

describe("an app's Settings, in parts", () => {
  const drawPart = (settingsPart: AppPage["settingsPart"]) => draw(settingsTab(page({ tab: "settings", settingsPart }), app));
  const titles = (root: Element) => [...root.querySelectorAll(".settings-content > section .section-head h2")].map(text);

  test("a side menu of its parts, each with its own address, the open one marked", () => {
    const root = drawPart("connections");
    const links = [...root.querySelectorAll(".side-menu a")];
    assert.deepEqual(links.map((a) => [text(a), a.getAttribute("href")]), [
      ["General", "#/apps/star-map/settings"],
      ["Connections", "#/apps/star-map/settings/connections"],
      ["Protocol", "#/apps/star-map/settings/protocol"],
    ]);
    assert.equal(text(root.querySelector(".side-menu a[aria-current=page]")), "Connections");
  });

  test("General: the details and links, deleting last; Connections: what it's connected to and its checks", () => {
    assert.deepEqual(titles(drawPart("general")), ["Details", "Links", "Delete app"]);
    assert.deepEqual(titles(drawPart("connections")), ["Connections", "Status checks"]);
    for (const part of ["general", "connections", "protocol"] as const) assert.deepEqual(unnamed(drawPart(part)), [], part);
  });

  test("links elsewhere go straight to the part they mean", () => {
    const bare: App = { ...app, connections: [app.connections[0]!] };
    const root = draw(overview(page({ app: bare, details: new Map() }), bare));
    assert.equal(root.querySelector("[aria-labelledby=s-deploys-and-commits] a")?.getAttribute("href"), "#/apps/star-map/settings/connections");
  });
});

describe("the Configuration tab", () => {
  const f = (id: string, severity: "high" | "medium" | "low", ignored = false) => ({
    id: `site:${id}`,
    key: id,
    source: "site",
    sourceLabel: "The site",
    severity,
    title: `Problem ${id}`,
    why: `Why ${id} matters.`,
    fix: { steps: `Do ${id}.`, code: `paste ${id}`, link: { url: "https://example.com/fix", label: "Where to fix it" } },
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    ignored,
  });

  test("worst first, each with why and how to fix it; ignored ones folded away; the tab counts what's left", () => {
    const p = page({ tab: "config", config: { findings: [f("dmarc", "high"), f("hsts", "medium"), f("nosniff", "low"), f("csp", "medium", true)], notes: [{ source: "GitHub", text: "Add Administration: Read" }], checkedAt: new Date().toISOString() } });
    const root = draw(configTab(p));
    assert.match(text(root.querySelector(".key-line")), /1 high · 1 medium · 1 low/);
    const items = [...root.querySelector("[aria-labelledby=s-to-fix] .finding-list")!.children];
    assert.deepEqual(items.map((i) => text(i.querySelector(".finding-title"))), ["Problem dmarc", "Problem hsts", "Problem nosniff"]);
    assert.match(text(items[0]), /Why dmarc matters\.\s*How to fix\s*Do dmarc\./);
    assert.match(text(items[0]!.querySelector(".code-body")), /paste dmarc/);
    assert.match(text(root.querySelector(".config-ignored summary")), /Ignored: 1/);
    assert.match(text(root), /GitHub: Add Administration: Read/);
    assert.equal(tabsOf(p, app).find((t) => t.key === "config")?.label, "Configuration (2)", "high and medium count; low doesn't");
    assert.deepEqual(unnamed(root), []);
  });

  test("before the first check, it says it's checking, and offers to check now", () => {
    const root = draw(configTab(page({ tab: "config", config: { findings: [], notes: [] } })));
    assert.match(text(root), /Checking its site, its DNS and its accounts for the first time/);
    assert.ok([...root.querySelectorAll("button")].some((b) => text(b) === "Check now"));
  });
});

describe("Get more: a few named like the app", () => {
  test("a list to pick from, the likeliest first, and Connect sends the one picked", async () => {
    const settings = { branch: "main", paths: "" };
    const sg = {
      serviceId: "s1",
      serviceName: "My GitHub",
      serviceType: "github",
      kind: "github",
      choices: [
        { resource: "periskopos/periskopos.com", label: "periskopos/periskopos.com", settings },
        { resource: "periskopos/periskopos", label: "periskopos/periskopos", settings },
      ],
    } as const;
    const sent: unknown[] = [];
    const root = document.createElement("div");
    mount(root, getMoreSection([{ ...sg, choices: [...sg.choices] }], "#settings", async (s) => void sent.push(s.match?.resource)));
    const pick = root.querySelector("select")!;
    assert.deepEqual([...pick.options].map((o) => o.textContent), ["periskopos/periskopos.com", "periskopos/periskopos"]);
    assert.match(text(root), /2 are named like this app, choose which/);
    assert.deepEqual(unnamed(root), []);
    pick.value = "1";
    root.querySelector<HTMLButtonElement>(".item-end button")!.click();
    await until(() => sent.length > 0);
    assert.deepEqual(sent, ["periskopos/periskopos"]);
  });
});
