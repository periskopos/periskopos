import { duration } from "../../../../shared/format.ts";
import type { AppHistory, Incident } from "../../../../shared/types.ts";
import { h } from "../../dom.ts";
import { range } from "../../format.ts";
import { busyButton, lamp } from "../../ui.ts";

export const KIND: Record<string, string> = { outage: "Outage", deploy: "Deploy", ci: "CI", expiry: "Expiry", dependency: "Dependency", slow: "Slow", search: "Search", errors: "Errors", security: "Security", payments: "Payments", traffic: "Traffic", spend: "Spend" };

// With `mark`, each incident can be marked a false alarm, or the mark
// taken back (History); without it, the mark is only shown (Overview).
export function incidentList(list: AppHistory["incidents"], mark?: (i: Incident, on: boolean) => Promise<void>) {
  return h(
    "ul",
    { class: "list" },
    list.map((i) =>
      h(
        "li",
        { class: `item${i.falseAlarm ? " is-false-alarm" : ""}` },
        // Resolved: the recovered lamp, as the bell shows recoveries.
        lamp(i.endedAt ? "up" : i.kind === "outage" ? "down" : "attention", { label: i.endedAt ? "resolved" : "ongoing" }),
        h(
          "div",
          { class: "item-main" },
          h("span", { class: "item-title" }, h("span", { class: "tag" }, KIND[i.kind] ?? i.kind), i.falseAlarm && h("span", { class: "tag" }, "False alarm"), h("span", { class: "truncate" }, i.reason)),
          h("span", { class: "meta" }, range(i.startedAt, i.endedAt)),
        ),
        h(
          "span",
          { class: "item-end meta mono" },
          i.endedAt ? duration(Date.parse(i.endedAt) - Date.parse(i.startedAt)) : "ongoing",
          mark && busyButton(i.falseAlarm ? "Not a false alarm" : "False alarm", "Saving…", () => mark(i, !i.falseAlarm), "btn btn--ghost btn--sm"),
        ),
      ),
    ),
  );
}

// How many incidents there were, and how many of them I said were false
// alarms (PRD §12: no false "down" notifications in a normal week).
export function incidentCounts(list: AppHistory["incidents"]): string {
  const falseAlarms = list.filter((i) => i.falseAlarm).length;
  const all = `${list.length} incident${list.length === 1 ? "" : "s"}`;
  if (!falseAlarms) return `${all} · no false alarms`;
  return `${all} · ${falseAlarms} false alarm${falseAlarms === 1 ? "" : "s"} (${Math.round((falseAlarms / list.length) * 100)}%)`;
}
