import type { SearchDay, SearchDetails, SearchQuery, SearchTotals } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, figure, lamp, section } from "../../ui.ts";
import { detailsError } from "./details.ts";
import { compactCount, timeChart } from "./chart.ts";

// ── Search: how a site does in search results ───────────────────────────

export type SearchRange = "week" | "month";
const RANGE_LABEL: Record<SearchRange, string> = { week: "7 days", month: "28 days" };

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const dayLabel = (date: string) => dayFmt.format(new Date(`${date}T00:00:00Z`));

// "+12% on the week before", "−40% on the week before"
function weekChange(now: number, before: number): string | undefined {
  if (before === 0) return undefined;
  const pct = Math.round((now / before - 1) * 100);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${Math.abs(pct)}% on the week before`;
}

function searchFigures(t: SearchTotals, before: SearchTotals | undefined, range: SearchRange) {
  return h(
    "div",
    { class: "figures", role: "group", "aria-label": `Search, last ${RANGE_LABEL[range]}` },
    figure("Clicks", compactCount(t.clicks), before ? weekChange(t.clicks, before.clicks) : "from search results"),
    figure("Impressions", compactCount(t.impressions), "times shown in results"),
    figure("Click rate", t.ctrPct !== undefined ? `${t.ctrPct}%` : "—", "clicks per impression", t.ctrPct === undefined),
    figure("Avg position", t.position !== undefined ? String(t.position) : "—", "1 is the top result", t.position === undefined),
  );
}

// Which measure the chart shows, kept while the period changes.
let chartMetric = "clicks";

function clicksChart(days: SearchDay[], range: SearchRange) {
  return timeChart({
    metric: chartMetric,
    onMetric: (key) => {
      chartMetric = key;
    },
    metrics: [
      { key: "clicks", label: "Clicks", title: "Clicks per day", peak: "best", unit: "clicks" },
      { key: "impressions", label: "Impressions", title: "Impressions per day", peak: "best", unit: "impressions" },
    ],
    points: days.map((d) => ({
      label: dayLabel(d.date),
      axis: dayLabel(d.date),
      values: { clicks: d.clicks, impressions: d.impressions },
      rows: [
        ["Clicks", d.clicks.toLocaleString()],
        ["Impressions", d.impressions.toLocaleString()],
        ...(d.position !== undefined ? ([["Position", String(d.position)]] as [string, string][]) : []),
      ],
    })),
    describe: `Search per day, last ${RANGE_LABEL[range]}`,
    table: h(
      "details",
      { class: "tchart-table" },
      h("summary", { class: "meta" }, "Show the numbers"),
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", null, "Day (UTC)"), h("th", null, "Clicks"), h("th", null, "Impressions"), h("th", null, "Position"))),
        h(
          "tbody",
          null,
          [...days].reverse().map((d) =>
            h("tr", null, h("td", null, dayLabel(d.date)), h("td", { class: "num" }, d.clicks.toLocaleString()), h("td", { class: "num" }, d.impressions.toLocaleString()), h("td", { class: "num" }, d.position !== undefined ? String(d.position) : "—")),
          ),
        ),
      ),
    ),
  });
}

function queriesList(queries: SearchQuery[]) {
  if (queries.length === 0) return empty("No queries with clicks or impressions yet.");
  return h(
    "ul",
    { class: "list top-pages" },
    queries.map((q) =>
      h(
        "li",
        { class: "item" },
        h("span", { class: "item-main truncate", title: q.query }, q.query),
        h("span", { class: "item-end meta mono" }, `${q.clicks.toLocaleString()} clicks · ${compactCount(q.impressions)} shown · #${q.position}`),
      ),
    ),
  );
}

// The Search panel for an app with a Search Console property.
export function searchSection(d: SearchDetails | Error | undefined, range: SearchRange, setRange: (r: SearchRange) => void) {
  const switcher = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Search period" },
    (Object.keys(RANGE_LABEL) as SearchRange[]).map((r) =>
      h("button", { type: "button", class: "segment", "aria-pressed": String(r === range), onclick: () => setRange(r) }, RANGE_LABEL[r]),
    ),
  );
  if (d instanceof Error) return section("Search", { action: switcher, list: detailsError(d) });
  if (!d) return section("Search", { action: switcher, body: [empty("Loading…")] });
  const action = h("div", { class: "traffic-actions" }, switcher, d.dashboardUrl ? ext(d.dashboardUrl, "Search Console") : null);
  if (!d.through) return section("Search", { action, body: [empty(`No search data for ${d.site} yet: Google hasn't shown it in search results.`)] });
  const week = range === "week";
  return section("Search", {
    action,
    body: [
      d.drop
        ? h("div", { class: "notice" }, lamp("attention"), h("span", null, `Clicks fell ${d.drop.dropPct}% on the week before: ${d.drop.clicks.toLocaleString()} against ${d.drop.before.toLocaleString()}.`))
        : null,
      searchFigures(week ? d.totals.week : d.totals.month, week ? d.totals.previousWeek : undefined, range),
      clicksChart(week ? d.days.slice(-7) : d.days, range),
      h("p", { class: "meta" }, `${d.site} in Google Search, through ${dayLabel(d.through)}: search numbers come in a few days late.`),
      h("h3", { class: "label" }, `Top queries · ${RANGE_LABEL[range]}`),
      queriesList(week ? d.topQueries.week : d.topQueries.month),
    ],
  });
}
