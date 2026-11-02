import { duration } from "../../../shared/format.ts";
import type { ProviderIncident, ProviderMaintenance, ProviderStatus } from "../../../shared/types.ts";
import { h } from "../dom.ts";
import { clock } from "../format.ts";
import { ext, lamp, timeAgo } from "../ui.ts";
import type { LampState } from "../ui.ts";

// A provider's incidents and maintenance on the Status page, at three
// weights: a card for an incident that affects my apps (it needs me), a
// quiet row for one elsewhere, and maintenance as rows with the date first,
// a day's routine windows grouped into one.

const IMPACT: Record<string, LampState> = { none: "attention", minor: "attention", major: "down", critical: "down" };
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const since = (iso: string, now = Date.now()) => `since ${clock(iso)} · for ${duration(now - Date.parse(iso))}`;

// The parts of the provider my apps use, by name, to mark them.
export const usedParts = (p: ProviderStatus) => new Set((p.parts ?? []).map((x) => x.name));

// An incident in a part my apps use: what it is, how long, the provider's
// latest word, the parts it touches (mine first, marked), and its page.
export function incidentCard(i: ProviderIncident, used: Set<string>) {
  const tone = IMPACT[i.impact] ?? "attention";
  const parts = [...(i.parts ?? [])].sort((a, b) => Number(used.has(b)) - Number(used.has(a)));
  return h(
    "li",
    { class: `incident-card incident-card--${tone}` },
    h(
      "div",
      { class: "incident-head" },
      lamp(tone),
      h("strong", { class: "incident-title" }, i.name),
      i.status && h("span", { class: "tag" }, capital(i.status)),
    ),
    i.startedAt && h("span", { class: "meta" }, since(i.startedAt)),
    i.update && h("p", { class: "incident-update" }, i.update.body, i.update.at ? h("span", { class: "meta" }, timeAgo(i.update.at, " · updated ")) : null),
    parts.length > 0 && h("div", { class: "chips incident-parts" }, parts.map((x) => h("span", { class: `chip chip--static${used.has(x) ? " is-yours" : ""}`, title: used.has(x) ? "Your apps use this" : undefined }, x))),
    i.url && h("span", null, ext(i.url, "Open on the status page")),
  );
}

// An incident elsewhere: one quiet row.
export function incidentRow(i: ProviderIncident) {
  return h(
    "li",
    { class: "event-row is-elsewhere" },
    lamp("none"),
    h(
      "span",
      { class: "event-main" },
      h("span", { class: "secondary" }, i.url ? ext(i.url, i.name) : i.name),
      h("span", { class: "meta" }, [i.status && capital(i.status), i.startedAt && `for ${duration(Date.now() - Date.parse(i.startedAt))}`].filter(Boolean).join(" · ")),
    ),
    h("span", { class: "tag" }, "doesn't affect your apps"),
  );
}

const dayOf = (iso: string) => new Date(iso).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
export const touches = (m: ProviderMaintenance, used: Set<string>) => (m.parts ?? []).some((x) => used.has(x));

// Maintenance, soonest first, the date in its own column. What's under way
// comes first; on a day with several windows in parts my apps don't use
// (a busy provider's data centres), they're one row that opens to the list.
export function maintenanceRows(list: ProviderMaintenance[], used: Set<string>) {
  const rows: Node[] = [];
  const underWay = list.filter((m) => m.status !== "scheduled");
  const byDay = new Map<string, ProviderMaintenance[]>();
  for (const m of list.filter((x) => x.status === "scheduled")) {
    const day = m.scheduledFor ? dayOf(m.scheduledFor) : "Date not given";
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }
  for (const m of underWay) rows.push(maintenanceRow(m, used, "Under way"));
  for (const [day, items] of byDay) {
    const mine = items.filter((m) => touches(m, used));
    const routine = items.filter((m) => !touches(m, used));
    for (const m of mine) rows.push(maintenanceRow(m, used, day));
    if (routine.length >= 3) rows.push(groupRow(day, routine, used));
    else for (const m of routine) rows.push(maintenanceRow(m, used, day));
  }
  return h("ul", { class: "event-list" }, rows);
}

function when(m: ProviderMaintenance) {
  if (!m.scheduledFor) return "";
  return m.scheduledUntil ? `${clock(m.scheduledFor)}–${clock(m.scheduledUntil)}` : clock(m.scheduledFor);
}

function maintenanceRow(m: ProviderMaintenance, used: Set<string>, day: string, withTime = true) {
  const yours = touches(m, used);
  return h(
    "li",
    { class: `event-row${yours ? " is-yours" : ""}` },
    h("span", { class: "event-date" }, h("span", null, day), withTime && m.status === "scheduled" && h("span", { class: "meta mono" }, when(m))),
    h(
      "span",
      { class: "event-main" },
      h("span", { class: "secondary" }, m.url ? ext(m.url, m.name) : m.name),
      yours && h("span", { class: "meta" }, `touches ${(m.parts ?? []).filter((x) => used.has(x)).join(", ")}, which your apps use`),
    ),
    yours && h("span", { class: "tag" }, "your parts"),
  );
}

function groupRow(day: string, items: ProviderMaintenance[], used: Set<string>) {
  const times = items.map((m) => m.scheduledFor).filter((x): x is string => Boolean(x)).sort();
  const ends = items.map((m) => m.scheduledUntil ?? m.scheduledFor).filter((x): x is string => Boolean(x)).sort();
  const span = times.length ? `${clock(times[0]!)}–${clock(ends[ends.length - 1]!)}` : "";
  return h(
    "li",
    { class: "event-row event-group" },
    h("span", { class: "event-date" }, h("span", null, day), span && h("span", { class: "meta mono" }, span)),
    h(
      "details",
      { class: "event-main" },
      h("summary", { class: "secondary" }, `${items.length} routine windows in parts your apps don't use`),
      h("ul", { class: "event-list event-list--nested" }, items.map((m) => maintenanceRow(m, used, when(m) || day, false))),
    ),
  );
}
