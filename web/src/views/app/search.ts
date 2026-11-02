import type { SearchDay, SearchDetails, SearchQuery, SearchTotals } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, figure, lamp, section } from "../../ui.ts";
import { detailsError } from "./details.ts";
import { compactCount, svg } from "./traffic.ts";

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

// Clicks per day as plain bars from a zero baseline, like the traffic chart.
function clicksChart(days: SearchDay[], range: SearchRange) {
  const W = 600;
  const H = 100;
  const GAP = 2;
  const max = Math.max(0, ...days.map((d) => d.clicks));
  const barW = (W - GAP * (days.length - 1)) / days.length;
  const tip = (d: SearchDay) =>
    `${dayLabel(d.date)} · ${d.clicks.toLocaleString()} clicks · ${d.impressions.toLocaleString()} impressions${d.position !== undefined ? ` · position ${d.position}` : ""}`;
  return h(
    "div",
    { class: "tchart-wrap" },
    h("div", { class: "tchart-head meta" }, h("span", null, "Clicks per day"), h("span", { class: "mono" }, `best ${compactCount(max)}`)),
    svg(
      "svg",
      { class: "tchart", viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none", role: "img", "aria-label": `Search clicks per day, last ${RANGE_LABEL[range]}; best ${compactCount(max)}` },
      ...days.map((d, i) => {
        const x = i * (barW + GAP);
        const height = max > 0 ? Math.max(d.clicks > 0 ? 2 : 0, (d.clicks / max) * H) : 0;
        return svg(
          "g",
          { class: "tchart-col", tabindex: 0, "aria-label": tip(d) },
          svg("title", {}, tip(d)),
          svg("rect", { class: "tchart-hit", x, y: 0, width: barW, height: H }),
          svg("rect", { class: "tchart-bar", x, y: H - height, width: barW, height, rx: 1.5 }),
        );
      }),
      svg("rect", { class: "tchart-base", x: 0, y: H - 1, width: W, height: 1 }),
    ),
    h("div", { class: "bars-axis meta" }, h("span", null, days[0] ? dayLabel(days[0].date) : ""), h("span", null, days.at(-1) ? dayLabel(days.at(-1)!.date) : "")),
  );
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
