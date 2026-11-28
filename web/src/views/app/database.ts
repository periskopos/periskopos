import type { DatabaseDetails, DatabaseRequestsDay } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, figure, lamp, section, timeAgo } from "../../ui.ts";
import { compactCount, timeChart } from "./chart.ts";
import { detailsError } from "./details.ts";

// ── Database: what a hosted database (Supabase) says of itself ──────────
// Its plan and where it runs, its API requests over the last week, whether a
// free project is close to being paused for being idle, and what runs beside
// it. A part that couldn't be read is said under the panel, never shown as 0.

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const dayLabel = (day: string) => dayFmt.format(new Date(`${day}T00:00:00Z`));
const totalOf = (d: DatabaseRequestsDay) => d.rest + d.auth + d.storage + d.realtime;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// Which kind of request the chart shows, kept while the page redraws.
let chartMetric = "total";

function requestsChart(days: DatabaseRequestsDay[]) {
  const kinds: [keyof Omit<DatabaseRequestsDay, "day">, string][] = [
    ["rest", "Database"],
    ["auth", "Auth"],
    ["storage", "Storage"],
    ["realtime", "Realtime"],
  ];
  // Four tabs fit a phone; Realtime is rarely much, and stays in the tooltip.
  const charted = kinds.slice(0, 3);
  return timeChart({
    metric: chartMetric,
    onMetric: (key) => {
      chartMetric = key;
    },
    metrics: [
      { key: "total", label: "All", title: "API requests per day", peak: "busiest", unit: "requests" },
      ...charted.map(([key, label]) => ({ key, label, title: `${label} requests per day`, peak: "busiest", unit: "requests" })),
    ],
    points: days.map((d) => ({
      label: dayLabel(d.day),
      axis: dayLabel(d.day),
      values: { total: totalOf(d), rest: d.rest, auth: d.auth, storage: d.storage, realtime: d.realtime },
      rows: kinds.map(([key, label]) => [label, d[key].toLocaleString()] as [string, string]),
    })),
    // Today is still counting.
    partial: true,
    describe: "Supabase API requests per day, last 7 days",
  });
}

// "Free plan: paused after 7 days without activity", with how close it is.
function pauseLine(p: NonNullable<DatabaseDetails["pausesWhenIdle"]>, lastAt: string | undefined) {
  const close = p.afterDays - p.idleDays <= 2;
  return h(
    "p",
    { class: close ? "reason reason--attention" : "secondary" },
    close && lamp("attention", { label: "May be paused soon" }),
    close && " ",
    `Free plan: Supabase pauses the project after ${p.afterDays} days without activity. `,
    lastAt ? ["Last API request ", timeAgo(lastAt), "."] : `No API requests in the last ${p.afterDays} days.`,
  );
}

function functionsList(fns: NonNullable<DatabaseDetails["functions"]>) {
  return h(
    "ul",
    { class: "list" },
    fns.map((f) =>
      h(
        "li",
        { class: "item" },
        lamp(f.status === "ACTIVE" ? "up" : "unknown", { label: capital(f.status.toLowerCase()) }),
        h("div", { class: "item-main" }, h("span", { class: "item-title mono" }, f.name), h("span", { class: "meta" }, `version ${f.version}`)),
        f.updatedAt && h("div", { class: "item-end meta" }, timeAgo(f.updatedAt, "deployed ")),
      ),
    ),
  );
}

export function databaseSection(d: DatabaseDetails | Error | undefined) {
  const loaded = d && !(d instanceof Error) ? d : undefined;
  if (!loaded) return section("Database", { list: d instanceof Error ? detailsError(d) : empty("Loading…") });
  const { requests, functions, backups } = loaded;
  // "17.4.1.054" is Supabase's build of Postgres 17.4.
  const where = [loaded.region, loaded.postgres && `Postgres ${loaded.postgres.split(".").slice(0, 2).join(".")}`].filter(Boolean).join(" · ");
  return section("Database", {
    action: ext(loaded.link.url, loaded.link.label),
    list: h(
      "div",
      { class: "section-body" },
      h(
        "div",
        { class: "figures", role: "group", "aria-label": `${loaded.provider} project ${loaded.project}` },
        figure("Plan", loaded.plan ? capital(loaded.plan) : "—", where || loaded.status, !loaded.plan),
        figure("API requests · 7 days", requests ? compactCount(requests.total) : "—", requests ? (requests.lastAt ? ["last ", timeAgo(requests.lastAt)] : "none this week") : "not shown", !requests),
        figure("Edge Functions", functions ? String(functions.length) : "—", functions ? (functions[0]?.updatedAt ? ["last deployed ", timeAgo(functions[0].updatedAt)] : "none deployed") : "not shown", !functions),
        figure(
          "Backups",
          backups ? (backups.pitr ? "Point in time" : backups.count ? "Daily" : "None") : "—",
          backups ? (backups.latest ? ["latest ", timeAgo(backups.latest)] : backups.pitr ? "restore to any moment" : loaded.plan?.toLowerCase() === "free" ? "not on the free plan" : "none yet") : "not shown",
          !backups,
        ),
      ),
      loaded.pausesWhenIdle && pauseLine(loaded.pausesWhenIdle, requests?.lastAt),
      requests && requests.total > 0 && requestsChart(requests.days),
      functions && functions.length > 0 && functionsList(functions),
      loaded.notes.length > 0 && h("p", { class: "meta" }, loaded.notes.join(". "), "."),
    ),
  });
}
