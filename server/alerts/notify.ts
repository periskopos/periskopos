import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { noticeLine, toastXml } from "../../shared/desktop.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 15_000;

export type Notice = { title: string; body: string; url?: string; alarm?: true };
export type Notifier = { notify(notice: Notice): Promise<void> };

// Desktop notifications on the PC Periskopos runs on (FR-W4, FR-W5).
// Clicking one opens `url` where the platform allows it.
export function systemNotifier(platform = process.platform, env: NodeJS.ProcessEnv = process.env): Notifier {
  if (env.PERISKOPOS_DESKTOP === "1") return desktop;
  if (platform === "win32") return windows;
  if (platform === "darwin") return mac;
  if (platform === "linux") return linux;
  return { notify: async (n) => console.log(`[notification] ${n.title}: ${n.body}`) };
}

export const silentNotifier: Notifier = { notify: async () => {} };

// Run by the desktop app: the app shows the notification itself (as Ground
// Control, and a click opens its window), so the server just hands it over.
const desktop: Notifier = {
  async notify(notice) {
    process.stdout.write(`${noticeLine(notice)}\n`);
  },
};

// ── Windows: a native toast through Windows PowerShell's WinRT access ───
//
// The toast uses Periskopos's own app id once `npm run install-service`
// has registered it, and PowerShell's otherwise. Text goes in through
// environment variables, never through the command line.

export const WINDOWS_APP_ID = "Periskopos";
const POWERSHELL_APP_ID =
  "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";

const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime]
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($env:PERISKOPOS_TOAST_XML)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:PERISKOPOS_TOAST_APP).Show($toast)
`;

async function windowsAppId(): Promise<string> {
  try {
    await run("reg", ["query", `HKCU\\Software\\Classes\\AppUserModelId\\${WINDOWS_APP_ID}`], {
      timeout: TIMEOUT_MS,
      windowsHide: true,
    });
    return WINDOWS_APP_ID;
  } catch {
    return POWERSHELL_APP_ID;
  }
}

const windows: Notifier = {
  async notify(notice) {
    const xml = toastXml(notice, notice.url);
    await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TOAST_SCRIPT],
      {
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, PERISKOPOS_TOAST_XML: xml, PERISKOPOS_TOAST_APP: await windowsAppId() },
      },
    );
  },
};

// ── macOS: terminal-notifier if installed (clicking opens the page), ────
// otherwise AppleScript's notification (clicking can't open a URL).

let hasTerminalNotifier: boolean | undefined;

// An alarm plays a sound the plain notification doesn't.
const MAC_ALARM_SOUND = "Sosumi";

const mac: Notifier = {
  async notify({ title, body, url, alarm }) {
    if (hasTerminalNotifier === undefined) {
      hasTerminalNotifier = await run("which", ["terminal-notifier"]).then(
        () => true,
        () => false,
      );
    }
    if (hasTerminalNotifier) {
      await run(
        "terminal-notifier",
        ["-title", title, "-message", body, "-group", "periskopos", ...(url ? ["-open", url] : []), ...(alarm ? ["-sound", MAC_ALARM_SOUND] : [])],
        { timeout: TIMEOUT_MS },
      );
      return;
    }
    // Text passed as arguments, so nothing in it is read as AppleScript.
    await run(
      "osascript",
      [
        "-e", "on run argv",
        "-e", alarm
          ? `display notification (item 2 of argv) with title (item 1 of argv) sound name "${MAC_ALARM_SOUND}"`
          : "display notification (item 2 of argv) with title (item 1 of argv)",
        "-e", "end run",
        title,
        body,
      ],
      { timeout: TIMEOUT_MS },
    );
  },
};

// ── Linux: notify-send ──────────────────────────────────────────────────

const linux: Notifier = {
  async notify({ title, body, alarm }) {
    await run("notify-send", ["--app-name=Periskopos", ...(alarm ? ["--urgency=critical"] : []), title, body], { timeout: TIMEOUT_MS });
  },
};
