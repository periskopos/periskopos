import type { ActionDef, ActivityEntry, App, AppHistory, AppStatus, BlockedAction, CheckResult, Commit, ConfigReport, ConnectionDetails, FailureLog, ProtocolView, ProviderStatus, SearchTotals, ServiceView, TrafficDetails, TrafficPoint, TrafficTotals } from "../shared/types.ts";
import { mainSite } from "../shared/catalog.ts";
import { duration } from "../shared/format.ts";

// What the AI assistant is told (PRD §7.9). Every field is listed here on
// purpose: a field that isn't named never reaches it, so no key, token,
// endpoint secret or variable name can leak by being added to an API
// response later.

const short = (c: Commit) => ({ sha: c.sha.slice(0, 7), message: c.message, at: c.at });

const newest = (checks: Record<string, CheckResult>) =>
  Object.values(checks)
    .map((c) => c.at)
    .sort()
    .at(-1);

export function appSummary(app: App, status: AppStatus | undefined) {
  const push = status?.deploy;
  return {
    slug: app.slug,
    name: app.name,
    url: app.url,
    state: status?.state ?? "unknown",
    ...(status?.staleSince ? { note: `Last checked at ${status.staleSince}, too long ago to say how it is now` } : {}),
    ...(app.live ? {} : { live: false, note: "Not launched yet, so its site isn't checked and it isn't down" }),
    ...(status?.incident
      ? { problem: { kind: status.incident.kind, reason: status.incident.reason, since: status.incident.startedAt } }
      : {}),
    ...(status?.uptime30d !== undefined ? { uptime30d: `${status.uptime30d}%`, ...(status.uptimeWatchedMs !== undefined ? { uptimeOverWatchedTime: duration(status.uptimeWatchedMs) } : {}) } : {}),
    ...(push
      ? {
          lastPush: {
            state: push.state,
            ...(push.latest ? { latest: short(push.latest) } : {}),
            ...(push.live ? { live: short(push.live) } : {}),
            ...(push.detail ? { detail: push.detail } : {}),
          },
        }
      : {}),
    ...(status?.metrics?.length ? { numbers: Object.fromEntries(status.metrics.map((m) => [m.label, m.value])) } : {}),
    // The check saying whether it's up, when there is one: a certificate checked
    // just now says nothing about a site last checked hours ago.
    ...(status ? { checkedAt: siteCheckedAt(app, status) ?? newest(status.checks) } : {}),
  };
}

const siteCheckedAt = (app: App, status: AppStatus) => {
  const site = mainSite(app);
  return site && status.checks[site.id]?.at;
};

export function configDetail(app: App, report: ConfigReport) {
  const open = report.findings.filter((f) => !f.ignored);
  return {
    app: app.name,
    ...(report.checkedAt ? { checkedAt: report.checkedAt } : { note: "Not checked yet" }),
    toFix: open.map((f) => ({
      severity: f.severity,
      where: f.sourceLabel,
      problem: f.title,
      why: f.why,
      fix: f.fix.steps,
      ...(f.fix.code ? { paste: f.fix.code } : {}),
      ...(f.fix.link ? { link: f.fix.link.url } : {}),
      since: f.firstSeen,
    })),
    ...(report.findings.length > open.length ? { ignoredByYou: report.findings.filter((f) => f.ignored).map((f) => `${f.sourceLabel}: ${f.title}`) } : {}),
    ...(report.notes.length ? { couldNotCheck: report.notes.map((n) => `${n.source}: ${n.text}`) } : {}),
  };
}

export function appDetail(input: {
  app: App;
  status: AppStatus | undefined;
  history: AppHistory | undefined;
  details: ConnectionDetails[];
  couldNotRead?: string[]; // what's missing from details: absent isn't "nothing wrong"
  providers: ProviderStatus[];
  activity: ActivityEntry[];
  services: ServiceView[];
  protocol?: ProtocolView;
}) {
  const { app, status, history, details, couldNotRead, providers, activity, services, protocol } = input;
  const host = details.find((d) => d.shape === "deploys");
  const source = details.find((d) => d.shape === "commits");
  const search = details.find((d) => d.shape === "search");
  const errors = details.find((d) => d.shape === "errors");
  const payments = details.find((d) => d.shape === "payments");
  const logs = details.find((d) => d.shape === "logs");

  return {
    ...appSummary(app, status),
    ...(couldNotRead?.length ? { couldNotRead: { sources: couldNotRead, note: "Left out because they couldn't be read, so nothing can be said about them" } } : {}),
    ...(app.notes ? { notes: app.notes } : {}),
    checks: checkList(app, status, services),
    ...(host?.shape === "deploys"
      ? { recentDeploys: host.deploys.slice(0, 5).map((d) => ({ status: d.status, startedAt: d.startedAt, ...(d.finishedAt ? { finishedAt: d.finishedAt } : {}), ...(d.commit ? { commit: short(d.commit) } : {}) })) }
      : {}),
    ...(source?.shape === "commits"
      ? {
          recentCommits: source.commits.slice(0, 5).map(short),
          ci: source.runs.slice(0, 5).map((r) => ({ workflow: r.name, result: r.conclusion ?? r.state, at: r.at })),
          branch: source.branch,
        }
      : {}),
    // Search numbers come in a few days late: "through" is their newest day.
    ...(search?.shape === "search"
      ? {
          search: search.through
            ? {
                site: search.site,
                through: search.through,
                last7Days: searchTotals(search.totals.week),
                weekBefore: searchTotals(search.totals.previousWeek),
                last28Days: searchTotals(search.totals.month),
                topQueries7Days: search.topQueries.week.slice(0, 5).map((q) => ({ query: q.query, clicks: q.clicks, impressions: q.impressions, position: q.position })),
                ...(search.drop ? { problem: `Clicks fell ${search.drop.dropPct}% week over week (${search.drop.clicks} against ${search.drop.before})` } : {}),
              }
            : { site: search.site, note: "No search data yet" },
        }
      : {}),
    ...(errors?.shape === "errors"
      ? {
          errors: {
            project: errors.project,
            newIn24h: errors.newIn24h,
            unresolved: errors.issues.slice(0, 5).map((i) => ({ id: i.shortId, title: i.title, level: i.level, events: i.count, users: i.users, firstSeen: i.firstSeen, lastSeen: i.lastSeen })),
          },
        }
      : {}),
    // Amounts are in each currency's smallest unit (cents).
    ...(payments?.shape === "payments"
      ? {
          payments: {
            provider: payments.provider,
            mode: payments.mode,
            revenueMinorUnits: payments.revenue,
            ...(payments.partial ? { note: "More payments than were read: revenue is a floor" } : {}),
            failedPayments: payments.failed,
            ...(payments.webhooks ? { webhooks: payments.webhooks } : {}),
            ...(payments.pastDue !== undefined ? { pastDueSubscriptions: payments.pastDue } : {}),
          },
        }
      : {}),
    // The host's runtime errors over the last hour, alike lines counted once.
    ...(logs?.shape === "logs"
      ? {
          logs: {
            provider: logs.provider,
            lastHour: logs.total,
            last15Minutes: logs.last15m,
            ...(logs.partial ? { note: "More lines than were read: counts are a floor" } : {}),
            ...(logs.spike ? { problem: `Errors are spiking: ${logs.spike.recent} in the last ${logs.spike.windowMin} minutes against about ${logs.spike.usual} usually` } : {}),
            topErrors: logs.groups.slice(0, 8).map((g) => ({ message: g.message, count: g.count, level: g.level, lastAt: g.lastAt, ...(g.source ? { source: g.source } : {}) })),
          },
        }
      : {}),
    ...(history
      ? {
          history: {
            uptime30d: history.uptimePct !== undefined ? `${history.uptimePct}%` : "not watched yet",
            watchedMinutes: history.watchedMin,
            recentIncidents: history.incidents.slice(0, 5).map((i) => ({ kind: i.kind, reason: i.reason, from: i.startedAt, ...(i.endedAt ? { to: i.endedAt } : { ongoing: true }) })),
            notWatchedStretches: history.gaps.length,
          },
        }
      : {}),
    // What the app itself reports through the protocol (counts only).
    ...(protocol?.configured
      ? {
          reportedByTheApp: {
            ...(protocol.manifest ? { app: `${protocol.manifest.app.name}${protocol.manifest.app.version ? ` ${protocol.manifest.app.version}` : ""}` } : {}),
            ...(protocol.metrics ? { metrics: protocol.metrics.items.map((m) => ({ label: m.label, value: m.value, ...(m.hint ? { hint: m.hint } : {}) })) } : {}),
            ...(protocol.error ? { problem: protocol.error } : {}),
            ...(protocol.problems?.length ? { problems: protocol.problems } : {}),
          },
        }
      : {}),
    // Only trouble in the parts of a provider this app uses (an incident in
    // Cloudflare's WARP isn't about a Worker).
    providersAffectingIt: providers
      .filter((p) => p.apps.some((a) => a.slug === app.slug))
      .map((p) => {
        const incidents = p.incidents.filter((i) => i.affectsYou);
        return {
          provider: p.label,
          status: p.description,
          ...(p.checkedAt ? { statusPageReadAt: p.checkedAt } : { note: "Its status page hasn't been read" }),
          forThisApp: p.relevantIndicator === "none" ? "fine (nothing reported in the parts this app uses)" : p.relevantIndicator,
          ...(incidents.length
            ? { incidents: incidents.map((i) => ({ name: i.name, impact: i.impact, ...(i.parts?.length ? { parts: i.parts } : {}), ...(i.startedAt ? { since: i.startedAt } : {}) })) }
            : {}),
        };
      }),
    recentActions: activity.slice(0, 5).map((a) => ({ at: a.at, action: a.label, by: a.source === "mcp" ? (a.agent ?? "an AI assistant") : "the user", ok: a.ok, result: a.message })),
  };
}

const searchTotals = (t: SearchTotals) => ({
  clicks: t.clicks,
  impressions: t.impressions,
  ...(t.ctrPct !== undefined ? { clickRate: `${t.ctrPct}%` } : {}),
  ...(t.position !== undefined ? { averagePosition: t.position } : {}),
});

// Every check of an app with its latest result, as get_app and check_app
// tell it.
export function checkList(app: App, status: AppStatus | undefined, services: ServiceView[]) {
  return app.connections
    .filter((c) => c.type !== "link")
    .map((c) => {
      const r = status?.checks[c.id];
      const service = c.serviceId ? services.find((s) => s.id === c.serviceId) : undefined;
      return {
        // A Cloudflare connection is a Worker or a Pages project; a
        // Cloudflare domain is its own kind.
        type: c.type === "cloudflare" ? (c.settings?.kind === "worker" ? "cloudflare-worker" : "cloudflare-pages") : c.type,
        what: String(c.settings?.name ?? c.resource),
        ...(service ? { via: service.name } : {}),
        state: r?.state ?? "not checked yet",
        ...(r?.detail ? { problem: r.detail } : {}),
        ...(r?.summary ? { summary: r.summary } : {}),
        ...(r?.link ? { seeWhy: r.link.url } : {}),
        ...(r?.ms !== undefined ? { ms: r.ms } : {}),
        ...(r ? { checkedAt: r.at } : {}),
      };
    });
}

export function historyDetail(app: App, history: AppHistory) {
  return {
    app: app.slug,
    from: history.from,
    to: history.to,
    uptime: history.uptimePct !== undefined ? `${history.uptimePct}%` : "not watched yet",
    watchedMinutes: history.watchedMin,
    incidents: history.incidents.map((i) => ({ kind: i.kind, reason: i.reason, from: i.startedAt, ...(i.endedAt ? { to: i.endedAt } : { ongoing: true }) })),
    notWatched: history.gaps.map((g) => ({ from: g.from, to: g.to })),
    days: history.days.map((d) => ({ day: d.day, ...(d.uptimePct !== undefined ? { uptimePct: d.uptimePct } : { notWatched: true }), incidents: d.incidents })),
  };
}

export function serviceList(services: ServiceView[], providers: ProviderStatus[]) {
  return services.map((s) => {
    const p = providers.find((x) => x.id === s.type);
    return {
      name: s.name,
      type: s.type,
      keyFound: s.keyState !== "missing",
      actionsAllowed: s.canWrite,
      usedBy: s.apps.map((a) => a.name),
      ...(p ? { providerStatus: p.description, ...(p.indicator !== "none" && p.incidents.length ? { providerIncidents: p.incidents.map((i) => i.name) } : {}) } : {}),
    };
  });
}

export function actionList(slug: string, list: { actions: ActionDef[]; blocked: BlockedAction[] }) {
  return {
    app: slug,
    actions: list.actions.map((a) => ({ id: a.id, label: a.label, description: a.description, via: a.service, ...(a.danger ? { danger: true } : {}) })),
    ...(list.blocked.length ? { notAvailable: list.blocked } : {}),
  };
}

// An app's traffic, as get_traffic tells it: the totals and one figure per
// hour (24h) or day (7d, 30d), and Web Analytics when it's on. Counts only.
export function trafficDetail(app: App, z: TrafficDetails, range: "24h" | "7d" | "30d") {
  const totals = (t: TrafficTotals) => ({
    requests: t.requests,
    visitors: t.visitors,
    ...(t.cachedPct !== undefined ? { servedFromCachePct: t.cachedPct } : {}),
    errors5xx: t.errors5xx,
    ...(t.errorPct !== undefined ? { errorPct: t.errorPct } : {}),
    bytes: t.bytes,
  });
  const point = (p: TrafficPoint) => ({ at: p.at, requests: p.requests, visitors: p.visitors, errors5xx: p.errors5xx });
  const t = z.traffic;
  const series = !t ? [] : range === "24h" ? t.hours : t.days.slice(range === "7d" ? -7 : -30);
  const v = z.visitors;
  const days = range === "30d" ? 30 : 7;
  return {
    app: app.name,
    domain: z.zone,
    domainStatus: z.paused ? "paused" : z.status,
    range,
    ...(t
      ? {
          totals: totals(range === "24h" ? t.totals.day : range === "7d" ? t.totals.week : t.totals.month),
          visitorsNote: "Visitors are Cloudflare's unique visitors per day, added up: someone who came on two days counts twice.",
          [range === "24h" ? "perHour" : "perDay"]: series.map(point),
        }
      : { trafficProblem: z.trafficError ?? "No traffic figures from Cloudflare" }),
    webAnalytics:
      v.state === "on"
        ? {
            visits: v.days.slice(-days).reduce((n, d) => n + d.visits, 0),
            pageViews: v.days.slice(-days).reduce((n, d) => n + d.pageViews, 0),
            topPages: (range === "30d" ? v.topPages.month : v.topPages.week).slice(0, 10),
          }
        : { state: v.state, note: v.message },
  };
}

// The end of each failed CI job's log, as get_failure_log tells it. GitHub
// masks the repository's secrets in its logs (***); no key of Ground
// Control's is ever in them.
export function failureDetail(repository: string, f: FailureLog) {
  return {
    repository,
    branch: f.branch,
    failingRuns: f.runs.map((r) => ({
      workflow: r.workflow,
      commit: r.sha.slice(0, 7),
      at: r.at,
      seeWhy: r.url,
      failedJobs: r.jobs.map((j) => ({
        job: j.name,
        result: j.conclusion,
        ...(j.failedStep ? { failedStep: j.failedStep } : {}),
        url: j.url,
        ...(j.log !== undefined ? { logTail: j.log } : {}),
        ...(j.logProblem ? { logProblem: j.logProblem } : {}),
      })),
    })),
    ...(f.builds.length
      ? {
          failedBuilds: f.builds.map((b) => ({
            reason: b.reason,
            ...(b.url ? { seeWhy: b.url } : {}),
            ...(b.log !== undefined ? { logTail: b.log } : {}),
            ...(b.logProblem ? { logProblem: b.logProblem } : {}),
            ...(b.log === undefined && !b.logProblem ? { note: "Cloudflare keeps this build's log: open it there" } : {}),
          })),
        }
      : {}),
  };
}
