import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { StartupStatus } from "../shared/types.ts";
import { LOGIN_ITEM_FILE, parseLoginItem } from "../shared/desktop.ts";
import { DATA_DIR } from "./config.ts";
import { WINDOWS_APP_ID } from "./alerts/notify.ts";

// Start at login (FR-W8). The desktop app owns it now (tray → Start at
// login). What's left here reports on, and removes, the retired way:
// `npm run install-service` put a window-less server in the Windows Run key,
// a macOS LaunchAgent or a Linux autostart entry
// (`npm run uninstall-service`, `npm run service-status`).

const run = promisify(execFile);
const NAME = "Periskopos";
const MAC_LABEL = "local.periskopos";
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const macPlist = () => path.join(homedir(), "Library", "LaunchAgents", `${MAC_LABEL}.plist`);
const linuxDesktop = () => path.join(homedir(), ".config", "autostart", "periskopos.desktop");

export async function startupStatus(platform = process.platform, env: NodeJS.ProcessEnv = process.env): Promise<StartupStatus> {
  // Run by the desktop app, which owns this and says where it stands.
  if (env.PERISKOPOS_DESKTOP === "1") {
    const file = path.join(DATA_DIR, LOGIN_ITEM_FILE);
    return { supported: true, enabled: existsSync(file) && parseLoginItem(readFileSync(file, "utf8")), managedBy: "desktop" };
  }
  if (platform === "win32") {
    const enabled = await run("reg", ["query", RUN_KEY, "/v", NAME], { windowsHide: true }).then(
      () => true,
      () => false,
    );
    return { supported: true, enabled };
  }
  if (platform === "darwin") return { supported: true, enabled: existsSync(macPlist()) };
  if (platform === "linux") return { supported: true, enabled: existsSync(linuxDesktop()) };
  return { supported: false, enabled: false };
}

// PowerShell with values in environment variables: no quoting games.
async function powershell(script: string, env: Record<string, string>) {
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

export async function disableStartup(platform = process.platform): Promise<string> {
  if (platform === "win32") {
    await powershell(
      `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name $env:PERISKOPOS_NAME -ErrorAction SilentlyContinue
       Remove-Item -Path "HKCU:\\Software\\Classes\\AppUserModelId\\$env:PERISKOPOS_APP_ID" -Recurse -ErrorAction SilentlyContinue`,
      { PERISKOPOS_NAME: NAME, PERISKOPOS_APP_ID: WINDOWS_APP_ID },
    );
    return "Removed Periskopos from your Windows startup apps.";
  }
  if (platform === "darwin") {
    await run("launchctl", ["bootout", `gui/${process.getuid?.()}/${MAC_LABEL}`]).catch(() => {});
    rmSync(macPlist(), { force: true });
    return "Removed the LaunchAgent and stopped it.";
  }
  if (platform === "linux") {
    rmSync(linuxDesktop(), { force: true });
    return "Removed the autostart entry.";
  }
  throw new Error(`Starting at login isn't supported on ${platform}`);
}
