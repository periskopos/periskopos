import { axisPicks, monotoneSegments, niceScale } from "../../../../shared/chart.ts";
import { h, mount } from "../../dom.ts";

// "980", "1.2k", "34k", "1.5M"
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_500) return `${Number((n / 1000).toFixed(n < 10_000 ? 1 : 0))}k`; // 999,500 would round to "1000k"
  return `${Number((n / 1_000_000).toFixed(1))}M`;
}

const SVG_NS = "http://www.w3.org/2000/svg";
// The SVG twin of h(): attributes and text only, never markup.
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

export type ChartMetric = { key: string; label: string; title: string; peak: string; unit: string };
export type ChartPoint = {
  label: string; // said in the tooltip
  axis: string; // said under the chart
  values: Record<string, number>;
  rows: [string, string][]; // the rest of what's known of this point, for the tooltip
  flag?: boolean; // something went wrong in this period: marked on the baseline
};
type ChartOptions = {
  metrics: ChartMetric[];
  points: ChartPoint[];
  metric: string;
  onMetric(key: string): void;
  partial?: boolean; // the last point is still counting: drawn dashed, and said so
  lastAxis?: string;
  flagNote?: string;
  describe: string; // what the chart is, for a screen reader
  table?: Node;
};

let gradients = 0;

// Change over time, one measure at a time on one axis. The grid and axes stay quiet,
// the numbers are in the tooltip and the table, and it can be walked with the keyboard.
export function timeChart(options: ChartOptions) {
  const { metrics, points, partial, lastAxis, flagNote, describe, table } = options;
  const wrap = h("div", { class: "tchart-wrap" });
  let metric = metrics.find((m) => m.key === options.metric) ?? metrics[0]!;

  function draw() {
    const values = points.map((p) => p.values[metric.key] ?? 0);
    const max = Math.max(0, ...values);
    const { top, ticks } = niceScale(max);
    const SIZE = 1000;
    const place = (i: number): [number, number] => [((i + 0.5) / points.length) * SIZE, SIZE - (values[i]! / top) * SIZE];
    const line = points.map((_, i) => place(i));
    const segments = monotoneSegments(line);
    const start = line[0];
    const end = line.at(-1);
    const solid = partial ? segments.slice(0, -1) : segments;
    const id = `tchart-fill-${++gradients}`;

    const crosshair = h("div", { class: "tchart-cross", hidden: true });
    const dot = h("div", { class: "tchart-dot", hidden: true });
    const tip = h("div", { class: "tchart-tip", hidden: true });
    const show = (i: number) => {
      const p = points[i]!;
      const x = ((i + 0.5) / points.length) * 100;
      const y = (1 - values[i]! / top) * 100;
      crosshair.hidden = dot.hidden = tip.hidden = false;
      crosshair.style.left = dot.style.left = `${x}%`;
      dot.style.top = `${y}%`;
      // It opens towards the middle, so it stays inside the chart.
      tip.classList.toggle("tchart-tip--left", x > 55);
      tip.style.left = `${x}%`;
      const soFar = partial && i === points.length - 1;
      mount(
        tip,
        h("div", { class: "tchart-tip-title" }, p.label, soFar && h("span", { class: "tchart-tip-note" }, "so far")),
        h("div", { class: "tchart-tip-main" }, h("strong", { class: "mono" }, values[i]!.toLocaleString()), ` ${metric.unit}`),
        p.rows.filter(([name]) => name !== metric.label).map(([name, value]) => h("div", { class: "tchart-tip-row" }, h("span", null, name), h("span", { class: "mono" }, value))),
      );
    };
    const hide = () => {
      crosshair.hidden = dot.hidden = tip.hidden = true;
    };

    const picks = axisPicks(points.length);
    const plot = h(
      "div",
      { class: "tchart-plot", onmouseleave: hide },
      svg(
        "svg",
        { class: "tchart", viewBox: `0 0 ${SIZE} ${SIZE}`, preserveAspectRatio: "none", "aria-hidden": "true", focusable: "false" },
        svg("defs", {}, svg("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 }, svg("stop", { class: "tchart-fill-top", offset: 0 }), svg("stop", { class: "tchart-fill-bottom", offset: 1 }))),
        ...ticks.map((t) => svg("line", { class: t === 0 ? "tchart-base" : "tchart-grid", x1: 0, x2: SIZE, y1: SIZE - (t / top) * SIZE, y2: SIZE - (t / top) * SIZE, "vector-effect": "non-scaling-stroke" })),
        ...(start && end && segments.length
          ? [
              svg("path", { d: `M ${start[0]} ${SIZE} L ${start[0]} ${start[1]} ${segments.join(" ")} L ${end[0]} ${SIZE} Z`, fill: `url(#${id})` }),
              svg("path", { class: "tchart-line", d: `M ${start[0]} ${start[1]} ${solid.join(" ")}`, "vector-effect": "non-scaling-stroke" }),
              ...(partial ? [svg("path", { class: "tchart-line tchart-line--partial", d: `M ${line.at(-2)![0]} ${line.at(-2)![1]} ${segments.at(-1)}`, "vector-effect": "non-scaling-stroke" })] : []),
            ]
          : []),
      ),
      points.map((p, i) => {
        if (!p.flag) return null;
        const mark = h("span", { class: "tchart-flag" });
        mark.style.left = `${((i + 0.5) / points.length) * 100}%`;
        return mark;
      }),
      (() => {
        // The newest point, marked, since that's what's looked at first.
        if (!end) return null;
        const last = h("span", { class: "tchart-end" });
        last.style.left = `${(end[0] / SIZE) * 100}%`;
        last.style.top = `${(end[1] / SIZE) * 100}%`;
        return last;
      })(),
      crosshair,
      dot,
      h(
        "div",
        { class: "tchart-cols" },
        points.map((p, i) =>
          h("div", {
            class: "tchart-col",
            tabindex: "0",
            role: "img",
            "aria-label": `${p.label}: ${values[i]!.toLocaleString()} ${metric.unit}${p.rows.map(([name, value]) => `, ${name} ${value}`).join("")}`,
            onmouseenter: () => show(i),
            onfocus: () => show(i),
            onblur: hide,
          }),
        ),
      ),
      tip,
      max === 0 && h("div", { class: "tchart-none meta" }, `No ${metric.unit} in this period`),
    );

    mount(
      wrap,
      h(
        "div",
        { class: "tchart-head" },
        h("div", { class: "tchart-heading" }, h("span", { class: "tchart-title" }, metric.title), max > 0 && h("span", { class: "meta mono" }, `${metric.peak} ${compactCount(max)}`)),
        metrics.length > 1 &&
          h(
            "div",
            { class: "segmented segmented--sm", role: "group", "aria-label": "What to chart" },
            metrics.map((m) =>
              h(
                "button",
                {
                  type: "button",
                  class: "segment",
                  "aria-pressed": String(m === metric),
                  onclick: () => {
                    metric = m;
                    options.onMetric(m.key);
                    draw();
                  },
                },
                m.label,
              ),
            ),
          ),
      ),
      h(
        "div",
        { class: "tchart-frame", role: "group", "aria-label": describe },
        h(
          "div",
          { class: "tchart-y meta mono", "aria-hidden": "true" },
          ticks.map((t) => {
            const label = h("span", null, compactCount(t));
            label.style.top = `${(1 - t / top) * 100}%`;
            return label;
          }),
        ),
        plot,
        h(
          "div",
          { class: "tchart-x meta", "aria-hidden": "true" },
          picks.map((i) => {
            // Under its point, unless that's so near the edge it would stick out.
            const at = ((i + 0.5) / points.length) * 100;
            const label = h("span", { class: at < 5 ? "is-first" : at > 95 ? "is-last" : "" }, i === points.length - 1 && lastAxis ? lastAxis : points[i]!.axis);
            label.style.left = `${at}%`;
            return label;
          }),
        ),
      ),
      flagNote && points.some((p) => p.flag) && h("div", { class: "tchart-legend meta" }, h("span", { class: "tchart-flag tchart-flag--key" }), flagNote),
      table ?? null,
    );
  }

  draw();
  return wrap;
}
