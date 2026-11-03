import { Notification } from "electron";
import { toastXml } from "../shared/desktop.ts";
import type { DesktopNotice } from "../shared/desktop.ts";

// Shows one notification. Windows and Linux toasts show whatever icon they are
// given (without one an unpackaged run shows Electron's mark); macOS ignores
// it and uses the app bundle's.

// Every notification still on screen. Nothing else refers to one once it is
// shown, and on Windows one that is garbage-collected loses its click: the
// toast stays in the Action Center but opens nothing. Each is let go once it
// is closed, clicked or refused.
const onScreen = new Set<Notification>();

export function showNotification(
  notice: DesktopNotice,
  icon: string | undefined,
  onClick: () => void,
  onFailed: (message: string) => void,
  onShown: () => void = () => {},
): void {
  if (!Notification.isSupported()) {
    onFailed(`notification "${notice.title}" couldn't be shown: this system doesn't support notifications`);
    return;
  }
  // An alarm sounds until it's dismissed: Windows' looping alarm toast, a
  // sound on a Mac, a critical notification on Linux.
  const alarm = notice.alarm
    ? process.platform === "win32"
      ? { toastXml: toastXml(notice) }
      : { sound: "Sosumi", urgency: "critical" as const }
    : {};
  const shown = new Notification({ title: notice.title, body: notice.body, ...(icon ? { icon } : {}), ...alarm });
  onScreen.add(shown);
  const release = () => onScreen.delete(shown);
  // Windows raises this when the toast can't be shown at all, most often
  // because the app id has no Start Menu shortcut (an unpackaged run). Without
  // it a dropped notification looks like one nothing tried to send.
  shown.on("failed", (_event, error: string) => {
    release();
    onFailed(`notification "${notice.title}" was refused by the OS: ${error}`);
  });
  shown.on("show", onShown);
  shown.on("click", () => {
    release();
    onClick();
  });
  shown.on("close", release);
  shown.show();
}
