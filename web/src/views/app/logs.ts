import type { LogGroup, LogsDetails } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { empty, ext, lamp, section, timeAgo } from "../../ui.ts";
import { detailsError } from "./details.ts";
import { compactCount } from "./traffic.ts";

// ── Logs: what the app's running code wrote as errors ───────────────────
// The last hour from the host's logs, the same error counted once however
// often it came, most frequent first. A spike is said above the list.

function groupItem(g: LogGroup) {
  return h(
    "li",
    { class: "item" },
    lamp(g.level === "warning" ? "attention" : "down", { label: g.level }),
    h(
      "div",
      { class: "item-main" },
      h("span", { class: "item-title mono log-message", title: g.message }, g.message),
      h("span", { class: "meta" }, g.source ? `${g.source} · ` : "", timeAgo(g.lastAt, "last "), g.count > 1 ? timeAgo(g.firstAt, " · first ") : ""),
    ),
    h("div", { class: "item-end meta mono" }, `${compactCount(g.count)}×`),
  );
}

export function logsSection(d: LogsDetails | Error | undefined) {
  const loaded = d && !(d instanceof Error) ? d : undefined;
  return section("Logs", {
    action: loaded?.link ? ext(loaded.link.url, loaded.link.label) : undefined,
    body: loaded
      ? [
          loaded.spike &&
            h(
              "p",
              { class: "key-line" },
              lamp("down"),
              h("strong", null, `Errors are spiking: ${loaded.spike.recent.toLocaleString("en-US")} in the last ${loaded.spike.windowMin} minutes`),
              h("span", { class: "meta" }, `, against about ${loaded.spike.usual.toLocaleString("en-US")} usually`),
            ),
          h(
            "p",
            { class: "secondary" },
            loaded.total === 0
              ? `No errors in ${loaded.provider}'s logs in the last ${loaded.windowMin} minutes.`
              : `${loaded.total.toLocaleString("en-US")}${loaded.partial ? "+" : ""} errors in the last ${loaded.windowMin} minutes · ${loaded.last15m.toLocaleString("en-US")} in the last 15 · alike ones counted once`,
          ),
        ]
      : undefined,
    list: d instanceof Error ? detailsError(d) : !loaded ? empty("Loading…") : loaded.groups.length ? h("ul", { class: "list" }, loaded.groups.map(groupItem)) : undefined,
  });
}
