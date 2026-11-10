import type { ShellPrefs, UpdateSnapshot } from "../../../shared/desktop.ts";
import { updateView } from "../../../shared/desktop.ts";
import type { Settings, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import type { DesktopBridge } from "../desktop.ts";
import { h, mount } from "../dom.ts";
import { ago } from "../format.ts";
import { inputRow, rowParts, settingRow } from "../settingRows.ts";
import { busyButton, errorBox, section, submitting, toast } from "../ui.ts";
import { currentUpdate, watchUpdates } from "../updateButton.ts";

// Settings → General, the parts beyond switches: your name, how often new apps
// are checked, what closing the window does, and updates.

const INTERVALS = [1, 2, 5, 10, 15, 30, 60];
const everyText = (minutes: number) => (minutes === 1 ? "Every minute" : minutes === 60 ? "Every hour" : `Every ${minutes} minutes`);

export function youSection(user: User) {
  const errors = h("div");
  const name = h("input", { name: "name", value: user.name, required: true, maxlength: 80, autocomplete: "off" });
  const form = submitting(
    h("form", null, inputRow("Your name", "Shown on your World and in Settings. Never sent anywhere.", name, h("button", { type: "submit", class: "btn btn--primary" }, "Save"))),
    errors,
    async (data) => {
      const { user: saved } = await api<{ user: User }>("PATCH", "/me", { name: data.get("name") });
      user.name = saved.name;
      toast("Saved");
    },
  );
  return section("You", { body: [form, errors] });
}

export function intervalRows(settings: Settings, save: (patch: Partial<Settings>) => Promise<void>) {
  const select = h(
    "select",
    { name: "defaultCheckIntervalMin", onchange: (e: Event) => void save({ defaultCheckIntervalMin: Number((e.target as HTMLSelectElement).value) }) },
    INTERVALS.map((m) => h("option", { value: m, selected: m === settings.defaultCheckIntervalMin }, everyText(m))),
  );
  const result = h("div");
  return [
    inputRow("Check new apps", "Each app can have its own, on its Settings tab. Slow-moving checks such as certificates and domains keep their own pace.", select),
    settingRow(
      "Use this for all my apps",
      "Replaces each app's own interval with the one above.",
      busyButton("Apply", "Changing…", async () => {
        if (!confirm(`Check all your apps ${everyText(settings.defaultCheckIntervalMin).toLowerCase()}? This replaces each app's own interval.`)) return;
        try {
          const { count } = await api<{ count: number }>("POST", "/settings/apply-interval");
          result.replaceChildren();
          toast(`${count} app${count === 1 ? "" : "s"} changed`);
        } catch (err) {
          result.replaceChildren(errorBox(err));
        }
      }),
    ),
    result,
  ];
}

export function closeRow(prefs: ShellPrefs, setPrefs: (next: ShellPrefs) => void) {
  const select = h(
    "select",
    { name: "onClose", onchange: (e: Event) => setPrefs({ ...prefs, onClose: (e.target as HTMLSelectElement).value === "quit" ? "quit" : "tray" }) },
    h("option", { value: "tray", selected: prefs.onClose === "tray" }, "Keep watching in the system tray"),
    h("option", { value: "quit", selected: prefs.onClose === "quit" }, "Quit Periskopos"),
  );
  return inputRow("When I close the window", prefs.onClose === "quit" ? "While Periskopos isn't running, nothing is checked and no alerts go out. That time shows as not watched." : "Periskopos keeps checking and alerting. Quit it from the tray icon's menu.", select);
}

// The same updater as the title bar's button, which holds what the shell last said.
export function updatesRow(bridge: DesktopBridge) {
  const slot = h("div", { class: "setting-row" });
  const draw = (snapshot: UpdateSnapshot | undefined) => {
    if (!snapshot) {
      mount(slot, ...rowParts("Updates", "Reading…"));
      return;
    }
    const view = updateView(snapshot);
    mount(
      slot,
      ...rowParts(
        `Periskopos ${snapshot.version}: ${view.status}`,
        [
          view.checkedAt && h("span", null, `Checked ${ago(view.checkedAt)}`),
          view.detail && h("span", null, view.detail),
          snapshot.state.kind !== "unavailable" && h("span", null, "It checks soon after starting and every 6 hours. On Windows and Linux a new version downloads by itself and installs on restart; on a Mac it opens the download."),
        ],
        view.action && h("button", { type: "button", class: `btn${view.action.kind === "check" ? "" : " btn--primary"}`, onclick: () => bridge.updateAction?.(view.action!.kind) }, view.action.label),
      ),
    );
  };
  draw(currentUpdate());
  watchUpdates((snapshot) => {
    if (!slot.isConnected) return false; // this page is gone
    draw(snapshot);
    return true;
  });
  return slot;
}
