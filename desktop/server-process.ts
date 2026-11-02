import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import path from "node:path";
import { parseFatalLine, parseNoticeLine } from "../shared/desktop.ts";
import type { DesktopNotice } from "../shared/desktop.ts";
import type { DaemonLog } from "./daemon-log.ts";

// Turns a stream of chunks into whole lines, however they were cut.
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    rest += chunk;
    let at: number;
    while ((at = rest.indexOf("\n")) >= 0) {
      onLine(rest.slice(0, at).replace(/\r$/, ""));
      rest = rest.slice(at + 1);
    }
    if (rest.length > 100_000) rest = ""; // a runaway line is not worth keeping
  };
}

export type ServerOptions = {
  root: string;
  port: number;
  dataDir: string;
  envFile: string | undefined;
  // The session key, written to the server's stdin: never on the command
  // line or in the environment, where other programs on this PC can read it.
  sessionKey: string;
  // The key the keys file is encrypted with (hex), on the line after it.
  keysKey: string | undefined;
  log: DaemonLog;
  onNotice: (notice: DesktopNotice) => void;
  // Why it can't start (its database won't open), said just before it exits.
  onFatal?: (message: string) => void;
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void;
};

// Periskopos's own server, run as a child process by Electron's built-in
// Node (which runs the TypeScript directly, like `npm start` does). A crash in
// it can't take the window down, and the window can say so.
export function startServer(options: ServerOptions): ChildProcess {
  const { root, port, dataDir, envFile, log } = options;

  const child = spawn(process.execPath, [path.join(root, "server", "main.ts")], {
    cwd: root,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      PERISKOPOS_DESKTOP: "1",
      PERISKOPOS_PORT: String(port),
      PERISKOPOS_DATA_DIR: dataDir,
      ...(envFile ? { PERISKOPOS_ENV_FILE: envFile } : {}),
      PERISKOPOS_SESSION_KEY_STDIN: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdin?.end(`${options.sessionKey}\n${options.keysKey ?? ""}\n`);

  const stamp = (text: string) => log.write(`${new Date().toISOString()} ${text}\n`);
  const fromStdout = lineSplitter((line) => {
    const notice = parseNoticeLine(line);
    const fatal = parseFatalLine(line);
    if (fatal) {
      options.onFatal?.(fatal);
    } else if (notice) {
      stamp(`notice: ${notice.title}`);
      options.onNotice(notice);
    } else if (line) {
      stamp(line);
    }
  });
  const fromStderr = lineSplitter((line) => line && stamp(line));
  child.stdout?.setEncoding("utf8").on("data", fromStdout);
  child.stderr?.setEncoding("utf8").on("data", fromStderr);
  child.on("error", (err) => stamp(`could not start: ${err.message}`));
  child.on("exit", (code, signal) => {
    stamp(`server exited (${signal ?? `code ${code}`})`);
    options.onExit(code, signal);
  });
  return child;
}
