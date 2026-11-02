// npm run dev: rebuilds the UI on change and runs the desktop app, the only
// way to open Periskopos (docs/AGENT-SAFETY.md §4.1). The server reads
// index.html on each request, so a rebuilt UI shows up on the next reload
// (View → Reload). A change to the server or the app needs the app restarted.
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";

// The window's bridge to the app is built once; the UI is built before the
// app opens, so its first page isn't missing.
execFileSync(process.execPath, ["desktop/build/build-preload.ts"], { stdio: "inherit" });
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "-c", "web/vite.config.ts"], { stdio: "inherit" });

// The electron package's main export is the path of its binary.
const electron = createRequire(import.meta.url)("electron") as string;

const children: ChildProcess[] = [
  spawn(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--watch", "-c", "web/vite.config.ts"], { stdio: "inherit" }),
  spawn(electron, ["desktop/main.ts"], { stdio: "inherit" }),
];

const stop = (): never => {
  for (const child of children) child.kill();
  process.exit();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
// Quitting the app ends the session.
for (const child of children) child.on("exit", stop);
