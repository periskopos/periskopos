import { duration } from "../../../../shared/format.ts";
import { uptimeBand } from "../../../../shared/fleet.ts";
import type { UptimeDay } from "../../../../shared/types.ts";
import { api } from "../../api.ts";
import { h } from "../../dom.ts";
import { formatPct, range } from "../../format.ts";
import { empty, lamp, section } from "../../ui.ts";
import { incidentCounts, incidentList } from "./incidents.ts";
import type { AppPage } from "./page.ts";

const GAPS_SHOWN = 5;

// History: 30 days of uptime, incidents, actions run, and when nobody was
// watching.
export function history(page: AppPage) {
  const hist = page.hist;
  if (!hist) return [empty("Loading…")];
  const live = page.app?.live;
  const gaps = page.gapsOpen ? hist.gaps : hist.gaps.slice(0, GAPS_SHOWN);
  return [
    section("Uptime · last 30 days", {
      body: [
        h(
          "div",
          { class: "uptime-head" },
          h("span", { class: `uptime-figure${hist.uptimePct === undefined || !live ? " meta" : ""}` }, !live ? "Not live yet" : hist.uptimePct !== undefined ? formatPct(hist.uptimePct) : "Not watched yet"),
          h("span", { class: "meta" }, `watched ${duration(hist.watchedMin * 60_000)} · only time Periskopos was running counts`),
        ),
        h(
          "ul",
          { class: "bars", "aria-label": "Uptime per day, oldest first" },
          hist.days.map((d) => h("li", { class: `bar ${barClass(d)}`, tabindex: 0, "data-tip": dayTip(d), "aria-label": dayTip(d) })),
        ),
        h("div", { class: "bars-axis meta" }, h("span", null, "30 days ago"), h("span", null, "Today")),
        h(
          "div",
          { class: "legend meta" },
          h("span", null, h("span", { class: "swatch swatch--up" }), "≥ 99.9%"),
          h("span", null, h("span", { class: "swatch swatch--warn" }), "≥ 99%"),
          h("span", null, h("span", { class: "swatch swatch--down" }), "below"),
          h("span", null, h("span", { class: "swatch" }), "not watched"),
        ),
      ],
    }),

    section("Incidents", {
      action: hist.incidents.length ? h("span", { class: "meta" }, incidentCounts(hist.incidents)) : undefined,
      list: hist.incidents.length
        ? incidentList(hist.incidents, async (i, on) => {
            await api("PATCH", `${page.apiBase}/incidents/${encodeURIComponent(i.id)}`, { falseAlarm: on });
            // Uptime and the day bars change with it.
            await page.afterSubmit();
          })
        : undefined,
      body: hist.incidents.length ? undefined : [empty("None in the last 30 days.")],
    }),

    section("Not watched", {
      list: hist.gaps.length
        ? h(
            "ul",
            { class: "list" },
            gaps.map((g) =>
              h(
                "li",
                { class: "item" },
                lamp("none"),
                h("div", { class: "item-main" }, range(g.from, g.to)),
                h("span", { class: "item-end meta mono" }, duration(Date.parse(g.to) - Date.parse(g.from))),
              ),
            ),
          )
        : undefined,
      body: hist.gaps.length ? undefined : [empty("Watched the whole time.")],
      foot:
        hist.gaps.length > GAPS_SHOWN
          ? h(
              "button",
              {
                type: "button",
                class: "btn btn--ghost btn--sm",
                onclick: () => {
                  page.gapsOpen = !page.gapsOpen;
                  page.draw();
                },
              },
              page.gapsOpen ? "Show fewer" : `Show ${hist.gaps.length - GAPS_SHOWN} more`,
            )
          : undefined,
    }),
  ];
}

export function barClass(d: UptimeDay): string {
  const band = uptimeBand(d.uptimePct);
  return band ? `bar--${band}` : "";
}

export function dayTip(d: UptimeDay): string {
  const date = new Date(`${d.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
  if (d.uptimePct === undefined) return `${date} · not watched`;
  return `${date} · ${formatPct(d.uptimePct)} · watched ${duration(d.watchedMin * 60_000)}${d.incidents ? ` · ${d.incidents} incident${d.incidents === 1 ? "" : "s"}` : ""}`;
}
