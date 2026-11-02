import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// Who holds the port, when it's another Periskopos: usually a server
// started outside the app (`npm start`, an old login service, a session
// that ran it by hand) and left running, which stops the app from starting
// its own. Knowing which process it is lets the app offer to stop it,
// rather than leave you to find it.

export type PortHolder = {
  pid: number;
  command: string; // its command line
  parentExe?: string; // the program that started it, if that's still running
};

// "leftover": a Periskopos server no Periskopos app is running: safe
// to stop. "app": the server of a Periskopos app that's open: quit that
// app instead. "unknown": anything else, never touched.
export type HolderKind = "leftover" | "app" | "unknown";

const SERVER = /(^|[\\/"\s])server[\\/]main\.ts\b/;
const APP_EXE = /(^|[\\/])(periskopos|electron)(\.exe)?$/i;

export function classifyHolder(h: PortHolder): HolderKind {
  if (!SERVER.test(h.command)) return "unknown";
  return h.parentExe && APP_EXE.test(h.parentExe.trim()) ? "app" : "leftover";
}

// In a sentence, for the dialog: "process 12636 (node …\server\main.ts --log)".
export function describeHolder(h: PortHolder): string {
  const command = h.command.length > 120 ? `…${h.command.slice(-119)}` : h.command;
  return `process ${h.pid} (${command})`;
}

// The dialog's explanation. startsAtLogin: the retired `npm run
// install-service` entry is still there, which is why it comes back each
// time; stopping it removes that too.
export function holderDetail(h: PortHolder, port: number, startsAtLogin: boolean): string {
  const held = `It was started outside the app and holds port ${port}: ${describeHolder(h)}. No Periskopos app is using it, so it's safe to stop.`;
  return startsAtLogin
    ? `${held}\n\nIt starts at login from the old "npm run install-service" setup, which is why it's back each time. Stopping it also removes that, so only this app starts at login.`
    : held;
}

// What PowerShell says about the listener (see findHolder), as a PortHolder.
export function parseWindows(json: string): PortHolder | undefined {
  let raw: { pid?: unknown; command?: unknown; parentExe?: unknown };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch {
    return undefined;
  }
  if (typeof raw?.pid !== "number" || typeof raw.command !== "string") return undefined;
  return { pid: raw.pid, command: raw.command, ...(typeof raw.parentExe === "string" && raw.parentExe ? { parentExe: raw.parentExe } : {}) };
}

// `ps -o ppid=,command=` for the listener, and `ps -o comm=` for its parent.
export function parseUnix(pid: number, ps: string, parentComm: string | undefined): PortHolder | undefined {
  const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(ps);
  if (!m) return undefined;
  return { pid, command: m[2]!, ...(parentComm?.trim() ? { parentExe: parentComm.trim() } : {}) };
}

export async function findHolder(port: number, platform: NodeJS.Platform = process.platform): Promise<PortHolder | undefined> {
  if (!Number.isInteger(port)) return undefined;
  try {
    if (platform === "win32") {
      const script = [
        // A listener is the socket with no remote end. Not -State Listen:
        // some Windows machines report a listening socket's state as Closed,
        // FinWait1 or an invalid 0 (which -State skips, and reading .State
        // throws on) for seconds at a time.
        `$c = Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.RemotePort -eq 0 } | Select-Object -First 1`,
        // netstat is asked too, matched the same way (not on "LISTENING",
        // which Windows translates).
        String.raw`$owner = if ($c) { [int]$c.OwningProcess } else { $m = netstat -ano | Select-String -Pattern '^\s*TCP\s+\S+:${port}\s+(0\.0\.0\.0:0|\[::\]:0)\s+\S+\s+(\d+)\s*$' | Select-Object -First 1; if ($m) { [int]$m.Matches[0].Groups[2].Value } }`,
        "if (-not $owner) { exit }",
        "$p = Get-CimInstance Win32_Process -Filter \"ProcessId=$owner\"",
        "$parent = Get-CimInstance Win32_Process -Filter \"ProcessId=$($p.ParentProcessId)\"",
        "@{ pid = $owner; command = [string]$p.CommandLine; parentExe = [string]$parent.ExecutablePath } | ConvertTo-Json -Compress",
      ].join("; ");
      // PowerShell's networking and CIM modules can take well over 15 s to
      // load on a cold or busy machine (it did on a CI runner).
      const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 30_000, windowsHide: true });
      return parseWindows(stdout.trim());
    }
    const { stdout: lsof } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 10_000 });
    const pid = Number(lsof.trim().split("\n")[0]);
    if (!Number.isInteger(pid) || pid <= 0) return undefined;
    const { stdout: ps } = await run("ps", ["-o", "ppid=,command=", "-p", String(pid)], { timeout: 10_000 });
    const ppid = Number(ps.trim().split(/\s+/)[0]);
    const parent = ppid > 1 ? await run("ps", ["-o", "comm=", "-p", String(ppid)], { timeout: 10_000 }).then((r) => r.stdout, () => undefined) : undefined;
    return parseUnix(pid, ps, parent);
  } catch {
    return undefined; // couldn't tell: the app says what it can without it
  }
}
