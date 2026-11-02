import type { TrafficPoint, TrafficTotals, TrafficDetails } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { clock } from "../../format.ts";
import { empty, ext, figure, lamp, section } from "../../ui.ts";
import { detailsError } from "./details.ts";

// ── Traffic: a Cloudflare domain's requests and visitors ────────────────

export type TrafficRange = "day" | "week" | "month";
const RANGE_LABEL: Record<TrafficRange, string> = { day: "24 h", week: "7 days", month: "30 days" };
// At or above this share of 5xx answers the error figure is flagged (the
// same threshold the check alerts on).
const ERROR_FLAG_PCT = 5;

// "980", "1.2k", "34k", "1.5M"
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`;
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${i === 0 ? v : Number(v.toFixed(v < 10 ? 1 : 0))} ${units[i]}`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
// Cloudflare counts days in UTC; hours are shown on this PC's clock.
const pointLabel = (p: TrafficPoint, range: TrafficRange) => (range === "day" ? clock(p.at) : dayFmt.format(new Date(`${p.at}T00:00:00Z`)));

const SVG_NS = "http://www.w3.org/2000/svg";
// The SVG twin of h(): attributes and text only, never markup.
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

// Requests per hour or day as plain bars from a zero baseline: one series,
// one colour, the numbers in each bar's tooltip and in the table below.
function requestsChart(points: TrafficPoint[], range: TrafficRange) {
  const W = 600;
  const H = 100;
  const GAP = 2;
  const max = Math.max(0, ...points.map((p) => p.requests));
  const barW = (W - GAP * (points.length - 1)) / points.length;
  const per = range === "day" ? "hour" : "day";
  const tip = (p: TrafficPoint) =>
    `${pointLabel(p, range)} · ${p.requests.toLocaleString()} requests · ${p.visitors.toLocaleString()} visitors${p.errors5xx ? ` · ${p.errors5xx.toLocaleString()} failed (5xx)` : ""}`;
  const chart = svg(
    "svg",
    {
      class: "tchart",
      viewBox: `0 0 ${W} ${H}`,
      preserveAspectRatio: "none",
      role: "img",
      "aria-label": `Requests per ${per}, last ${RANGE_LABEL[range]}; busiest ${compactCount(max)}`,
    },
    ...points.map((p, i) => {
      const x = i * (barW + GAP);
      // A period with any traffic stays visible next to a much busier one.
      const height = max > 0 ? Math.max(p.requests > 0 ? 2 : 0, (p.requests / max) * H) : 0;
      return svg(
        "g",
        { class: "tchart-col", tabindex: 0, "aria-label": tip(p) },
        svg("title", {}, tip(p)),
        svg("rect", { class: "tchart-hit", x, y: 0, width: barW, height: H }),
        svg("rect", { class: "tchart-bar", x, y: H - height, width: barW, height, rx: 1.5 }),
      );
    }),
    svg("rect", { class: "tchart-base", x: 0, y: H - 1, width: W, height: 1 }),
  );
  return h(
    "div",
    { class: "tchart-wrap" },
    h("div", { class: "tchart-head meta" }, h("span", null, `Requests per ${per}`), h("span", { class: "mono" }, `busiest ${compactCount(max)}`)),
    chart,
    h("div", { class: "bars-axis meta" }, h("span", null, points[0] ? pointLabel(points[0], range) : ""), h("span", null, range === "day" ? "now" : "today")),
    h(
      "details",
      { class: "tchart-table" },
      h("summary", { class: "meta" }, "Show the numbers"),
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("th", null, range === "day" ? "Hour" : "Day (UTC)"), h("th", null, "Requests"), h("th", null, "Visitors"), h("th", null, "Cached"), h("th", null, "5xx"))),
        h(
          "tbody",
          null,
          [...points].reverse().map((p) =>
            h(
              "tr",
              null,
              h("td", null, pointLabel(p, range)),
              h("td", { class: "num" }, p.requests.toLocaleString()),
              h("td", { class: "num" }, p.visitors.toLocaleString()),
              h("td", { class: "num" }, p.requests ? `${Math.round((p.cachedRequests / p.requests) * 100)}%` : "—"),
              h("td", { class: "num" }, p.errors5xx.toLocaleString()),
            ),
          ),
        ),
      ),
    ),
  );
}

function trafficFigures(t: TrafficTotals, range: TrafficRange) {
  const flagged = t.errorPct !== undefined && t.errorPct >= ERROR_FLAG_PCT;
  return h(
    "div",
    { class: "figures", role: "group", "aria-label": `Traffic, last ${RANGE_LABEL[range]}` },
    figure("Requests", compactCount(t.requests), `${formatBytes(t.bytes)} served`),
    figure("Visitors", compactCount(t.visitors), range === "day" ? "unique per hour, added up" : "unique per day, added up"),
    figure("Cached", t.cachedPct !== undefined ? `${t.cachedPct}%` : "—", "from Cloudflare's cache", t.cachedPct === undefined),
    figure(
      "Errors (5xx)",
      t.errorPct !== undefined ? [flagged ? lamp("attention") : null, `${t.errorPct}%`] : "—",
      `${t.errors5xx.toLocaleString()} failed request${t.errors5xx === 1 ? "" : "s"}`,
      t.errorPct === undefined,
    ),
  );
}

function visitorsBlock(v: TrafficDetails["visitors"], range: TrafficRange) {
  if (v.state !== "on") {
    return h(
      "div",
      { class: "notice" },
      lamp(v.state === "unavailable" ? "unknown" : "none"),
      h(
        "div",
        { class: "visitors-note" },
        h("strong", null, v.message),
        v.howTo ? h("span", { class: "secondary" }, v.howTo) : null,
        v.dashboardUrl ? ext(v.dashboardUrl, "Open Web Analytics") : null,
      ),
    );
  }
  // Web Analytics counts by day: the 24-hour view shows the last 7 days.
  const days = range === "month" ? v.days : v.days.slice(-7);
  const label = range === "month" ? "30 days" : "7 days";
  const visits = days.reduce((n, d) => n + d.visits, 0);
  const views = days.reduce((n, d) => n + d.pageViews, 0);
  const pages = range === "month" ? v.topPages.month : v.topPages.week;
  return h(
    "div",
    { class: "visitors" },
    h(
      "div",
      { class: "figures figures--two" },
      figure(`Visits · ${label}`, compactCount(visits), "real browsers (Web Analytics)"),
      figure(`Page views · ${label}`, compactCount(views), visits > 0 ? `${Number((views / visits).toFixed(1))} per visit` : undefined),
    ),
    h("h3", { class: "label" }, `Top pages · ${label}`),
    pages.length === 0
      ? empty("No page views yet.")
      : h(
          "ul",
          { class: "list top-pages" },
          pages.map((p) => h("li", { class: "item" }, h("span", { class: "item-main mono truncate" }, p.path), h("span", { class: "item-end meta mono" }, `${p.views.toLocaleString()} views`))),
        ),
  );
}

// The Traffic panel for an app on a Cloudflare domain.
export function trafficSection(d: TrafficDetails | Error | undefined, range: TrafficRange, setRange: (r: TrafficRange) => void) {
  const switcher = h(
    "div",
    { class: "segmented", role: "group", "aria-label": "Traffic period" },
    (Object.keys(RANGE_LABEL) as TrafficRange[]).map((r) =>
      h("button", { type: "button", class: "segment", "aria-pressed": String(r === range), onclick: () => setRange(r) }, RANGE_LABEL[r]),
    ),
  );
  if (d instanceof Error) return section("Traffic", { action: switcher, list: detailsError(d) });
  if (!d) return section("Traffic", { action: switcher, body: [empty("Loading…")] });
  const t = d.traffic;
  const points = t ? (range === "day" ? t.hours : range === "week" ? t.days.slice(-7) : t.days) : [];
  return section("Traffic", {
    action: h("div", { class: "traffic-actions" }, switcher, d.dashboardUrl ? ext(d.dashboardUrl, "Cloudflare") : null),
    body: [
      d.paused || d.status !== "active"
        ? h("div", { class: "notice" }, lamp("attention"), h("span", null, d.paused ? `Cloudflare is paused on ${d.zone}.` : `${d.zone} is ${d.status} on Cloudflare.`))
        : d.developmentMode
          ? h("div", { class: "notice" }, lamp("info"), h("span", null, "Development mode is on: Cloudflare's cache is bypassed until it switches off."))
          : null,
      t ? trafficFigures(range === "day" ? t.totals.day : range === "week" ? t.totals.week : t.totals.month, range) : null,
      t ? requestsChart(points, range) : h("div", { class: "notice" }, lamp("unknown"), h("span", null, d.trafficError ?? "No traffic numbers.")),
      h("h3", { class: "label" }, "Visitors"),
      visitorsBlock(d.visitors, range),
    ],
  });
}
