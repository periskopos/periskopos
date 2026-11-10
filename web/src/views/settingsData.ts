import { CHECKS_KEPT_CHOICES } from "../../../shared/settings-choices.ts";
import type { Settings } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { desktopBridge } from "../desktop.ts";
import { h } from "../dom.ts";
import { inputRow, settingRow } from "../settingRows.ts";
import { busyButton, ext, section, toast } from "../ui.ts";

// Settings → Data and About, beyond the backups.

export type About = { dataDir?: string; keysFile?: string; version: string; summariesKeptDays?: number; dbBytes?: number };

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

export function historySection(settings: Settings, about: About | undefined, save: (patch: Partial<Settings>) => Promise<void>, redraw: () => void) {
  const select = h(
    "select",
    {
      name: "checksKeptDays",
      onchange: (e: Event) => {
        const days = Number((e.target as HTMLSelectElement).value);
        if (days < settings.checksKeptDays && !confirm(`Keep checks for ${days} days? Checks older than that are deleted, and can't be brought back.`)) {
          redraw(); // the control goes back to what's saved
          return;
        }
        void save({ checksKeptDays: days });
      },
    },
    CHECKS_KEPT_CHOICES.map((d) => h("option", { value: d, selected: d === settings.checksKeptDays }, `${d} days`)),
  );
  return section("History", {
    body: [
      inputRow(
        "Keep every check for",
        [
          about?.summariesKeptDays ? h("span", null, `A summary of each day is kept for ${about.summariesKeptDays} days, whatever you choose here. Older is deleted.`) : null,
          about?.dbBytes !== undefined ? h("span", null, `Your history and settings take up ${size(about.dbBytes)} on this computer.`) : null,
        ],
        select,
      ),
    ],
  });
}

export function exportSection() {
  return section("Export", {
    body: [
      settingRow(
        "Your setup, as a file",
        "Your apps, their checks, your accounts' names and your settings, to keep or read. No keys and no history. To bring everything to another computer, history and all, use a backup.",
        busyButton("Export my setup", "Exporting…", async () => {
          try {
            const data = await api<unknown>("GET", "/settings/export");
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
            const link = h("a", { href: url, download: `periskopos-setup-${new Date().toISOString().slice(0, 10)}.json` }) as HTMLAnchorElement;
            link.click();
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
          } catch (err) {
            toast((err as Error).message, "down");
          }
        }),
      ),
    ],
  });
}

export function resetSection(onReset: () => Promise<void>) {
  return section("Restore default settings", {
    danger: true,
    body: [
      settingRow(
        "Back to how Periskopos starts",
        "Watching, alerts, pauses, check intervals for new apps and AI assistants go back, so AI assistants are switched off. Your apps, accounts, keys and history stay, and so do where phone alerts go and how long checks are kept.",
        busyButton("Restore defaults", "Restoring…", async () => {
          if (!confirm("Restore default settings? AI assistants are switched off, and any pause ends.")) return;
          try {
            await api("POST", "/settings/reset");
            toast("Restored");
            await onReset();
          } catch (err) {
            toast((err as Error).message, "down");
          }
        }),
      ),
    ],
  });
}

// Where diagnostics show when the clipboard can't be written: ready to copy by hand.
export function aboutSection(about: About | undefined) {
  const bridge = desktopBridge();
  const slot = h("div");
  return section("About", {
    body: [
      h(
        "dl",
        { class: "facts" },
        about && [h("dt", { class: "label" }, "Version"), h("dd", { class: "mono meta" }, about.version)],
        about?.dataDir && [h("dt", { class: "label" }, "Data"), h("dd", { class: "mono meta" }, about.dataDir)],
        about?.keysFile && [h("dt", { class: "label" }, "Keys"), h("dd", { class: "mono meta" }, about.keysFile)],
      ),
      h("p", { class: "secondary" }, ext("https://periskopos.com/docs/", "Docs"), " · ", ext("https://periskopos.com/docs/changelog/", "What's new"), " · ", ext("https://periskopos.com/privacy/", "Privacy"), " · ", ext("https://github.com/periskopos/periskopos", "Source")),
      h(
        "div",
        { class: "actions" },
        bridge?.openData && h("button", { type: "button", class: "btn", onclick: () => bridge.openData?.() }, "Open the data folder"),
        bridge?.openLogs && h("button", { type: "button", class: "btn", onclick: () => bridge.openLogs?.() }, "Show the log file"),
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
            slot.replaceChildren();
            toast("Copied: paste it into your bug report");
          } catch {
            const box = h("textarea", { class: "mono diagnostics-text", readonly: true, rows: 12, "aria-label": "Diagnostics" }, report) as HTMLTextAreaElement;
            slot.replaceChildren(h("p", { class: "meta" }, "Copying isn't allowed here: select the text below and copy it."), box);
            box.focus();
            box.select();
          }
        }),
      ),
      slot,
      h("p", { class: "meta" }, "For a bug report: the version, your system, what's connected (by kind, never by name), how the World has run (frame times and your graphics card) and the server's recent errors. Keys, addresses, app names and your name are left out."),
    ],
  });
}
