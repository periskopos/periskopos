import type { BackupStatus, Settings, StartupStatus, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { asLoginItemState, desktopBridge } from "../desktop.ts";
import type { LoginItemState } from "../desktop.ts";
import { h, mount } from "../dom.ts";
import type { Child } from "../dom.ts";
import { startTour } from "../tour.ts";
import { busyButton, checkbox, errorBox, lamp, section, shell, toast } from "../ui.ts";
import { backupsSection } from "./backups.ts";
import { assistantsSections } from "./assistants.ts";
import { phoneAlertsSection } from "./phoneAlerts.ts";
import type { PhoneSecrets } from "./phoneAlerts.ts";

const isMac = /Mac/.test(navigator.userAgent);

type About = { dataDir: string; keysFile: string; version: string };

// Settings (IA: Settings), in tabs, each its own address (#/settings/data):
// General (watching, start at login, the tour), Notifications (desktop and phone),
// AI assistants, Data (backups, about).
export type SettingsTab = "general" | "notifications" | "assistants" | "data";
export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "notifications", label: "Notifications" },
  { key: "assistants", label: "AI assistants" },
  { key: "data", label: "Data" },
];
export const settingsTabOf = (sub: string | undefined): SettingsTab => SETTINGS_TABS.find((t) => t.key === sub)?.key ?? "general";

export function settingsView(root: Element, user: User, tab: SettingsTab = "general") {
  const body = h("div", { class: "page-body" }, h("p", { class: "meta" }, "Loading…"));
  const tabs = h(
    "nav",
    { class: "tabs", "aria-label": "Settings sections" },
    SETTINGS_TABS.map((t) => h("a", { href: t.key === "general" ? "#/settings" : `#/settings/${t.key}`, ...(t.key === tab ? { "aria-current": "page" } : {}) }, t.label)),
  );
  mount(root, shell(user, "settings", h("div", { class: "page-header" }, h("div", null, h("h1", null, "Settings"))), tabs, body));

  let settings: Settings;
  let startup: StartupStatus;
  let about: About | undefined;
  let backups: BackupStatus | undefined;
  let phoneSecrets: PhoneSecrets = { ntfyTopic: false, ntfyToken: false, telegramToken: false, resendKey: false };
  let loaded = false;
  // In the installed app, start at login is switched right here (the shell
  // keeps it); elsewhere the page only says how it stands.
  const bridge = desktopBridge();
  let loginItem: LoginItemState | null = null;
  bridge?.getStartAtLogin?.((state) => {
    loginItem = asLoginItemState(state);
    if (loaded) draw();
  });
  function setLoginItem(on: boolean) {
    bridge?.setStartAtLogin?.(on, (state) => {
      loginItem = asLoginItemState(state);
      if (loginItem?.enabled === on) toast("Saved");
      else toast("Couldn't change it: try Start at login in the tray menu.", "down");
      draw();
    });
  }

  async function load() {
    try {
      ({ settings, startup, about, phoneSecrets, backups } = await api<{ settings: Settings; startup: StartupStatus; about?: About; phoneSecrets: PhoneSecrets; backups?: BackupStatus }>("GET", "/settings"));
      loaded = true;
      draw();
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  async function save(patch: Partial<Settings>) {
    try {
      ({ settings } = await api<{ settings: Settings }>("PATCH", "/settings", patch));
      toast("Saved");
      draw();
    } catch (err) {
      toast((err as Error).message, "down");
      draw(); // the controls go back to what's saved
    }
  }

  // Made once per visit to the tab: it loads and redraws itself, so a save
  // elsewhere on the page doesn't reload it.
  const assistantParts = tab === "assistants" ? assistantsSections() : [];

  function draw() {
    const testSlot = h("div");
    const watching = () =>
      section("Watching", {
        body: [
          checkbox("watcherEnabled", "Watch apps in the background", "Checks each app on its interval and records history. While off, that time shows as not watched.", settings.watcherEnabled, (on) => save({ watcherEnabled: on })),
        ],
      });
    const notifications = () =>
      section("Notifications", {
        body: [
          checkbox("notificationsEnabled", "Notify me", "When an app goes down (two failed checks in a row) and when it's back; when a deploy fails or CI goes red.", settings.notificationsEnabled, (on) => save({ notificationsEnabled: on })),
          checkbox(
            "incidentAlarm",
            "Sound an alarm for provider incidents",
            "When a provider's status page (Cloudflare, GitHub…) reports an incident in a part your apps use. On Windows it stays on screen and keeps ringing until you dismiss it.",
            settings.incidentAlarm,
            (on) => save({ incidentAlarm: on }),
          ),
          h(
            "div",
            { class: "actions" },
            busyButton("Send a test notification", "Sending…", async () => {
              try {
                await api("POST", "/notifications/test");
                testSlot.replaceChildren(h("p", { class: "meta" }, "Sent. It should appear in a moment."));
              } catch (err) {
                testSlot.replaceChildren(errorBox(err));
              }
            }),
            busyButton("Test the alarm", "Sending…", async () => {
              try {
                await api("POST", "/notifications/test", { alarm: true });
                testSlot.replaceChildren(h("p", { class: "meta" }, "Sent. Dismiss it to stop the sound."));
              } catch (err) {
                testSlot.replaceChildren(errorBox(err));
              }
            }),
          ),
          testSlot,
          isMac && h("p", { class: "meta" }, "On a Mac, clicking a notification opens the app's page only with terminal-notifier installed: ", h("code", null, "brew install terminal-notifier")),
        ],
      });
    const legacyService = startup.enabled && startup.managedBy !== "desktop";
    const startAtLogin = () =>
      section("Start at login", {
        body: loginItem?.available && !legacyService
          ? [
              checkbox(
                "startAtLogin",
                "Start Periskopos when you log in",
                "It opens in the tray, without a window, and starts watching straight away. Also in the tray icon's menu.",
                loginItem.enabled,
                setLoginItem,
              ),
            ]
          : !startup.supported
          ? [h("p", { class: "secondary" }, "Not available on this system.")]
          : [
              h("p", { class: "key-line" }, lamp(startup.enabled ? "up" : "none"), startup.enabled ? "On: Periskopos starts by itself when you log in." : "Off: Periskopos runs only while you start it."),
              startup.managedBy === "desktop" || !startup.enabled
                ? h("p", { class: "meta" }, "To change it, right-click the Periskopos icon in the system tray (the menu bar on a Mac) and use Start at login.")
                : h("p", { class: "meta" }, "It was set up with the old ", h("code", null, "npm run install-service"), ", which can't open Periskopos any more: run ", h("code", null, "npm run uninstall-service"), " in the periskopos folder, then use Start at login in the tray menu."),
            ],
      });
    const tour = () =>
      section("Guided tour", {
        body: [
          h("p", { class: "secondary" }, "The short walk around the app you saw after setting up."),
          h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => startTour() }, "Take the tour")),
        ],
      });
    const backupsPart = () =>
      backups &&
        backupsSection(backups, (next) => {
          backups = next;
          draw();
        });
    // Where the diagnostics show when the clipboard can't be written: ready
    // to select and copy by hand.
    const diagnosticsSlot = h("div");
    const aboutPart = () =>
      section("About", {
        body: [
          h(
            "dl",
            { class: "facts" },
            h("dt", { class: "label" }, "You"),
            h("dd", null, user.name),
            about && [h("dt", { class: "label" }, "Data"), h("dd", { class: "mono meta" }, about.dataDir)],
            about && [h("dt", { class: "label" }, "Keys"), h("dd", { class: "mono meta" }, about.keysFile)],
            about && [h("dt", { class: "label" }, "Version"), h("dd", { class: "mono meta" }, about.version)],
          ),
          h(
            "div",
            { class: "actions" },
            busyButton("Copy diagnostics", "Copying…", async () => {
              let report: string;
              try {
                const r = await fetch("/api/diagnostics", { credentials: "same-origin" });
                if (!r.ok) throw new Error(`Couldn't read the diagnostics (HTTP ${r.status})`);
                report = await r.text();
              } catch (err) {
                toast((err as Error).message, "down");
                return;
              }
              try {
                await navigator.clipboard.writeText(report);
                diagnosticsSlot.replaceChildren();
                toast("Copied: paste it into your bug report");
              } catch {
                const box = h("textarea", { class: "mono diagnostics-text", readonly: true, rows: 12, "aria-label": "Diagnostics" }, report) as HTMLTextAreaElement;
                diagnosticsSlot.replaceChildren(h("p", { class: "meta" }, "Copying isn't allowed here: select the text below and copy it."), box);
                box.focus();
                box.select();
              }
            }),
          ),
          diagnosticsSlot,
          h("p", { class: "meta" }, "For a bug report: the version, your system, what's connected (by kind, never by name) and the server's recent errors. Keys, addresses, app names and your name are left out."),
        ],
      });

    const parts: Record<SettingsTab, () => Child[]> = {
      general: () => [watching(), startAtLogin(), tour()],
      notifications: () => [notifications(), phoneAlertsSection(settings, phoneSecrets, save, load)],
      assistants: () => assistantParts,
      data: () => [backupsPart(), aboutPart()],
    };
    mount(body, ...parts[tab]());
  }

  void load();
}
