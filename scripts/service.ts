// npm run uninstall-service / service-status: removes, or reports on, the old
// way of starting Periskopos at login. install-service is retired: the
// desktop app's own Start at login replaces it.
import { PORT } from "../server/config.ts";
import { disableStartup, startupStatus } from "../server/startup.ts";

const command = process.argv[2];

async function isRunning(): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

if (command === "install") {
  // A server started this way has no session key, so it can't open Ground
  // Control: only the desktop app can (docs/AGENT-SAFETY.md §4.1).
  console.log("Periskopos now opens only in its desktop app, so this no longer sets anything up.");
  console.log('Install the app, then use "Start at login" in its tray menu. (From this folder: npm run desktop.)');
  process.exit(1);
} else if (command === "uninstall") {
  console.log(await disableStartup());
  if (await isRunning()) console.log("The copy running now keeps running until you stop it or log out.");
} else if (command === "status") {
  const { supported, enabled } = await startupStatus();
  console.log(!supported ? "Not supported on this platform." : enabled ? "Starts at login: yes" : "Starts at login: no");
  console.log((await isRunning()) ? "Running now: yes" : "Running now: no");
} else {
  console.log("Usage: node scripts/service.ts install | uninstall | status");
  process.exit(1);
}
