import type { App, BackupStatus, Settings, StartupStatus, User } from "../../../shared/types.ts";
import { api } from "../api.ts";
import type { ShellPrefs } from "../../../shared/desktop.ts";
import { asLoginItemState, asShellPrefs, desktopBridge } from "../desktop.ts";
import type { LoginItemState } from "../desktop.ts";
import { h, mount } from "../dom.ts";
import type { Child } from "../dom.ts";
import { startTour } from "../tour.ts";
import { settingRow, toggleRow } from "../settingRows.ts";
import { busyButton, errorBox, lamp, section, shell, toast } from "../ui.ts";
import { pauseSection } from "./alertPause.ts";
import { backupsSection } from "./backups.ts";
import { appearanceSections } from "./settingsAppearance.ts";
import { aboutSection, exportSection, historySection, resetSection } from "./settingsData.ts";
import type { About } from "./settingsData.ts";
import { importSection } from "./settingsImport.ts";
import { closeRow, intervalRows, updatesRow, youSection } from "./settingsGeneral.ts";
import { assistantsSections } from "./assistants.ts";
import { phoneAlertsSection } from "./phoneAlerts.ts";
import type { PhoneSecrets } from "./phoneAlerts.ts";

const isMac = /Mac/.test(navigator.userAgent);

const ALERT_KINDS: { key: "alertOutages" | "alertDeploys" | "alertAccounts" | "alertProviders" | "alertWarnings"; label: string; hint: string }[] = [
  { key: "alertOutages", label: "Apps going down or slow", hint: "After two failed checks in a row, and when it's back." },
  { key: "alertDeploys", label: "Failed deploys and red CI", hint: "When a deploy fails or CI goes red, and when it's fixed." },
  { key: "alertAccounts", label: "Expiries and accounts", hint: "Certificates, domains and keys about to expire, keys that stop working, free plans nearing their limit." },
  { key: "alertProviders", label: "Provider incidents", hint: "When a provider's status page reports trouble in a part your apps use." },
  { key: "alertWarnings", label: "Other warnings on your apps", hint: "Errors, payments, security, dependencies, traffic, spend, search and serious configuration findings." },
];

// Settings (IA: Settings), in tabs, each its own address (#/settings/data):
// General (you, watching, and the app itself: starting, closing, updates, the tour), Appearance,
// Notifications (desktop and phone), AI assistants, Data (backups, history,
// export, defaults), About.
export type SettingsTab = "general" | "appearance" | "notifications" | "assistants" | "data" | "about";
export const SETTINGS_TABS: { key: SettingsTab; label: string }[] = [
  { key: "general", label: "General" },
  { key: "appearance", label: "Appearance" },
  { key: "notifications", label: "Notifications" },
  { key: "assistants", label: "AI assistants" },
  { key: "data", label: "Data" },
  { key: "about", label: "About" },
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
  let heldAlerts = 0;
  let apps: App[] = [];
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

  // The theme and what closing the window does are the app's own: in a browser
  // tab there's nothing to change.
  let shellPrefs: ShellPrefs | null = null;
  bridge?.getShellPrefs?.((prefs) => {
    shellPrefs = asShellPrefs(prefs);
    if (loaded) draw();
  });
  function setShellPrefs(next: ShellPrefs) {
    bridge?.setShellPrefs?.(next, (prefs) => {
      shellPrefs = asShellPrefs(prefs);
      toast("Saved");
      draw();
    });
  }

  async function load() {
    try {
      ({ settings, startup, about, phoneSecrets, backups, heldAlerts } = await api<{ settings: Settings; heldAlerts: number; startup: StartupStatus; about?: About; phoneSecrets: PhoneSecrets; backups?: BackupStatus }>("GET", "/settings"));
      if (tab === "notifications") ({ apps } = await api<{ apps: App[] }>("GET", "/apps"));
      loaded = true;
      draw();
      watchPauseEnds();
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
  // Made once: what a file would do stays on screen while the page redraws.
  const importPart = importSection(() => load());
  const pauseChoice = { value: "" };

  // A pause that ends while this page is open stops being true: read again then.
  let pauseEnds: ReturnType<typeof setTimeout> | undefined;
  function watchPauseEnds() {
    clearTimeout(pauseEnds);
    if (tab !== "notifications") return;
    const now = Date.now();
    const ends = [settings.alertsPausedUntil, ...Object.values(settings.appPauses)].map((t) => Date.parse(t)).filter((t) => t > now);
    if (ends.length === 0) return;
    // A little after: the watcher's next pass is what sends the message.
    pauseEnds = setTimeout(() => {
      if (body.isConnected) void load();
    }, Math.min(...ends) - now + 1000);
  }

  function draw() {
    const testSlot = h("div");
    // A test always gets through, so it can't be taken for the real thing being on.
    const sentNote = (text: string) => h("p", { class: "meta" }, settings.notificationsEnabled ? text : `${text} Notify me is off, so real alerts won't come until you turn it on.`);
    const watching = () =>
      section("Watching", {
        body: [
          toggleRow("watcherEnabled", "Watch apps in the background", "Checks each app on its interval and records history. While off, that time shows as not watched.", settings.watcherEnabled, (on) => save({ watcherEnabled: on })),
          intervalRows(settings, save),
        ],
      });
    const notifications = () =>
      section("Alerts", {
        body: [
          toggleRow(
            "notificationsEnabled",
            "Notify me",
            "On this computer, and your phone if it's set up below. An AI assistant asking to act always tells you.",
            settings.notificationsEnabled,
            (on) => save({ notificationsEnabled: on }),
          ),
          ALERT_KINDS.map((k) => [
            toggleRow(k.key, k.label, k.hint, settings[k.key], (on) => save({ [k.key]: on }), { disabled: !settings.notificationsEnabled, sub: true }),
            // The alarm is a louder way of hearing about provider incidents, so it sits under them.
            k.key === "alertProviders" &&
              toggleRow(
                "incidentAlarm",
                "Sound an alarm for provider incidents",
                settings.notificationsEnabled && settings.alertProviders
                  ? "When a provider's status page (Cloudflare, GitHub…) reports an incident in a part your apps use. On Windows it stays on screen and keeps ringing until you dismiss it."
                  : "Needs Notify me and provider incidents on: without them, a provider's incident doesn't sound anything.",
                settings.incidentAlarm,
                (on) => save({ incidentAlarm: on }),
                { disabled: !settings.notificationsEnabled || !settings.alertProviders, sub: true },
              ),
          ]),
          h(
            "div",
            { class: "actions" },
            busyButton("Send a test notification", "Sending…", async () => {
              try {
                await api("POST", "/notifications/test");
                testSlot.replaceChildren(sentNote("Sent. It should appear in a moment."));
              } catch (err) {
                testSlot.replaceChildren(errorBox(err));
              }
            }),
            busyButton("Test the alarm", "Sending…", async () => {
              try {
                await api("POST", "/notifications/test", { alarm: true });
                testSlot.replaceChildren(sentNote("Sent. Dismiss it to stop the sound."));
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
      loginItem?.available && !legacyService
        ? toggleRow(
            "startAtLogin",
            "Start Periskopos when you log in",
            "It opens in the tray, without a window, and starts watching straight away. Also in the tray icon's menu.",
            loginItem.enabled,
            setLoginItem,
          )
        : !startup.supported
        ? settingRow("Start at login", "Not available on this system.")
        : settingRow(
            "Start at login",
            [
              h("span", null, startup.enabled ? "Periskopos starts by itself when you log in." : "Periskopos runs only while you start it."),
              startup.managedBy === "desktop" || !startup.enabled
                ? h("span", null, "To change it, right-click the Periskopos icon in the system tray (the menu bar on a Mac) and use Start at login.")
                : h("span", null, "It was set up with the old ", h("code", null, "npm run install-service"), ", which can't open Periskopos any more: run ", h("code", null, "npm run uninstall-service"), " in the periskopos folder, then use Start at login in the tray menu."),
            ],
            h("span", { class: "key-line" }, lamp(startup.enabled ? "up" : "none"), startup.enabled ? "On" : "Off"),
          );
    const thisApp = () =>
      section("This app", {
        body: [
          startAtLogin(),
          shellPrefs && !isMac && closeRow(shellPrefs, setShellPrefs),
          bridge?.updateAction && updatesRow(bridge),
          settingRow("Guided tour", "The short walk around the app you saw after setting up.", h("button", { type: "button", class: "btn", onclick: () => startTour() }, "Take the tour")),
        ],
      });
    const backupsPart = () =>
      backups &&
        backupsSection(backups, (next) => {
          backups = next;
          draw();
        });
    const parts: Record<SettingsTab, () => Child[]> = {
      general: () => [youSection(user), watching(), thisApp()],
      appearance: () => appearanceSections(shellPrefs, setShellPrefs, draw),
      notifications: () => [
        notifications(),
        pauseSection(
          settings,
          heldAlerts,
          apps,
          async (patch) => {
            await save(patch);
            await load();
          },
          async (app, until) => {
            try {
              await api("POST", `/apps/${encodeURIComponent(app.slug)}/pause`, { until });
              toast("Saved");
            } catch (err) {
              toast((err as Error).message, "down");
            }
            await load();
          },
          pauseChoice,
        ),
        phoneAlertsSection(settings, phoneSecrets, save, load),
      ],
      assistants: () => assistantParts,
      data: () => [backupsPart(), historySection(settings, about, save, draw), exportSection(), importPart, resetSection(load)],
      about: () => [aboutSection(about)],
    };
    mount(body, ...parts[tab]());
  }

  void load();
}
