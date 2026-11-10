import type { App, Settings } from "../../../shared/types.ts";
import { h } from "../dom.ts";
import { dayTime } from "../format.ts";
import { inputRow, settingRow } from "../settingRows.ts";
import { busyButton, lamp, section } from "../ui.ts";

// Settings → Notifications: pausing alerts, for a planned deploy or a night's
// sleep. Always for a set time, so a pause can't be forgotten; what's missed
// arrives in one message when it ends (server/alerts/rules.ts).

const HOUR_MS = 60 * 60_000;
const MORNING_HOUR = 8;

// The next 8 in the morning that's at least an hour away.
export function tomorrowMorning(now: Date): Date {
  const at = new Date(now);
  at.setHours(MORNING_HOUR, 0, 0, 0);
  if (at.getTime() - now.getTime() < HOUR_MS) at.setDate(at.getDate() + 1);
  return at;
}

export const LENGTHS: { label: string; until: (now: Date) => Date }[] = [
  { label: "For 1 hour", until: (now) => new Date(now.getTime() + HOUR_MS) },
  { label: "For 4 hours", until: (now) => new Date(now.getTime() + 4 * HOUR_MS) },
  { label: "Until tomorrow morning", until: tomorrowMorning },
];

const ALL = "";

// `choice` lives with the page: a redraw mustn't quietly turn "this app" into "all alerts".
// One app's pause is sent on its own: the copy of the list here can be older than the server's.
export function pauseSection(
  settings: Settings,
  held: number,
  apps: App[],
  save: (patch: Partial<Settings>) => Promise<void>,
  saveApp: (app: App, until: string) => Promise<void>,
  choice: { value: string },
) {
  const now = Date.now();
  const running = (until: string) => Date.parse(until) > now;

  const line = (text: string, resume: () => Promise<void>) =>
    h("div", { class: "pause-line" }, h("span", { class: "key-line" }, lamp("attention"), text), busyButton("Resume", "Resuming…", resume, "btn btn--sm"));

  const lines = [
    running(settings.alertsPausedUntil) && line(`All alerts are paused until ${dayTime(settings.alertsPausedUntil)}`, () => save({ alertsPausedUntil: "" })),
    ...apps.filter((a) => running(settings.appPauses[a.id] ?? "")).map((a) => line(`${a.name}'s alerts are paused until ${dayTime(settings.appPauses[a.id]!)}`, () => saveApp(a, ""))),
  ].filter(Boolean);

  const what = h(
    "select",
    { name: "pauseWhat", onchange: (e: Event) => (choice.value = (e.target as HTMLSelectElement).value) },
    h("option", { value: ALL }, "All alerts"),
    apps.map((a) => h("option", { value: a.id, selected: a.id === choice.value }, a.name)),
  ) as HTMLSelectElement;

  const pause = (until: Date) => {
    const app = apps.find((a) => a.id === what.value);
    return app ? saveApp(app, until.toISOString()) : save({ alertsPausedUntil: until.toISOString() });
  };

  return section("Pause alerts", {
    body: [
      lines.length > 0 && h("div", { class: "stack-sm" }, lines),
      held > 0 && h("p", { class: "meta" }, `${held} alert${held === 1 ? "" : "s"} waiting, to arrive in one message when the pause ends.`),
      inputRow("What to pause", null, what),
      settingRow("For how long", "Always for a set time, so a pause can't be forgotten.", LENGTHS.map((l) => busyButton(l.label, "Pausing…", () => pause(l.until(new Date())), "btn"))),
      h(
        "p",
        { class: "meta" },
        "Periskopos keeps checking, and the bell keeps showing every problem. When a pause ends, one message says what you missed. An AI assistant asking to act isn't paused. Pausing one app covers everything about it, including its certificate and domain, but not alerts about providers or your accounts' keys.",
      ),
    ],
  });
}
