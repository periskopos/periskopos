import type { BackupStatus } from "../../../shared/types.ts";
import { api } from "../api.ts";
import { desktopBridge } from "../desktop.ts";
import { h } from "../dom.ts";
import { settingRow } from "../settingRows.ts";
import { busyButton, errorBox, ext, lamp, section, timeAgo, toast } from "../ui.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

const size = (bytes: number) => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

// Settings → Backups: when the database was last copied, a copy now, and
// the folder the copies are in (opened by the desktop app; a browser tab
// gets its path). Restoring is by hand, with the app quit (README).
export function backupsSection(status: BackupStatus, onChange: (status: BackupStatus) => void) {
  const slot = h("div");
  const { last } = status;
  // A day's copy is due each day: more than two days without one is worth a look.
  const stale = last !== undefined && Date.now() - Date.parse(last.at) > 2 * DAY_MS;
  const bridge = desktopBridge();
  return section("Backups", {
    body: [
      settingRow(
        h("span", { class: "key-line" }, lamp(status.error ? "down" : !last ? "none" : stale ? "attention" : "up"), last ? h("span", null, "Last backup ", timeAgo(last.at)) : "No backup yet"),
        last ? `${size(last.bytes)} · ${status.count} kept` : "The first is made when Periskopos starts.",
        [
          busyButton("Back up now", "Backing up…", async () => {
            try {
              const { backups } = await api<{ backups: BackupStatus }>("POST", "/settings/backup");
              toast("Backed up");
              onChange(backups);
            } catch (err) {
              slot.replaceChildren(errorBox(err));
            }
          }),
          bridge?.openBackups && h("button", { type: "button", class: "btn", onclick: () => bridge.openBackups?.() }, "Open the backups folder"),
        ],
      ),
      status.error && h("p", { class: "meta", role: "alert" }, `The last automatic backup failed: ${status.error}`),
      h(
        "p",
        { class: "meta" },
        `A copy of your apps, connections, accounts, settings and history, made once a day; the last ${status.keep} are kept. Your keys are never in it: they stay only in the keys file. To restore a backup, see `,
        ext("https://periskopos.com/docs/app/backups", "Backups in the docs"),
        ".",
      ),
      h("p", { class: "mono meta backups-dir" }, status.dir),
      slot,
    ],
  });
}
