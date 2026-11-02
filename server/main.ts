import { createWriteStream, mkdirSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { format } from "node:util";
import { serve } from "@hono/node-server";
import { fatalLine } from "../shared/desktop.ts";
import { createApp } from "./app.ts";
import { Backups, backupsDir } from "./backup.ts";
import { DATA_DIR, DIST_WEB, HOST, PORT } from "./config.ts";
import { DatabaseError, openDb } from "./db.ts";
import { recordCrash, recordProblem } from "./diagnostics.ts";
import { AppIcons } from "./icons.ts";
import { systemNotifier } from "./alerts/notify.ts";
import { withPhone } from "./alerts/phone.ts";
import { parseKeysKey } from "./keys/sealed-keys.ts";
import { moveLegacyEnvFile, useKeysKey } from "./keys/secrets.ts";
import { loadOrCreateToken, newSessionKey } from "./security.ts";
import { Watcher } from "./watcher.ts";

mkdirSync(DATA_DIR, { recursive: true });

// Started at login there's no console: --log appends output to a file.
if (process.argv.includes("--log")) {
  const log = createWriteStream(path.join(DATA_DIR, "periskopos.log"), { flags: "a" });
  for (const level of ["log", "error"] as const) {
    console[level] = (...args: unknown[]) => log.write(`${new Date().toISOString()} ${format(...args)}\n`);
  }
}

// Every error the server logs is also kept, redacted, for Settings → About →
// Copy diagnostics; and a crash leaves a line in the data folder.
const logError = console.error;
console.error = (...args: unknown[]) => {
  recordProblem(format(...args));
  logError(...args);
};
process.on("uncaughtException", (err) => {
  recordCrash(err);
  logError(`Periskopos crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});

// A background job that fails without anyone waiting on it (an icon fetch,
// a first check) is logged; it must never stop the server, and with it the
// watching.
process.on("unhandledRejection", (reason) => {
  console.error(`Unhandled failure in the background: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// PERISKOPOS_ENV_FILE names the file explicitly: then nothing is moved.
if (!process.env.PERISKOPOS_ENV_FILE) {
  try {
    const moved = moveLegacyEnvFile();
    if (moved) console.log(moved);
  } catch (err) {
    console.error(`Couldn't move .env.local out of the project folder: ${(err as Error).message}`);
  }
}

const db = await openDbOrSayWhy(path.join(DATA_DIR, "periskopos.db"));
const backups = new Backups({ db, dir: backupsDir(DATA_DIR) });
// The session key comes from the desktop app that started this server, on
// stdin (never the command line or environment, where other programs can
// read it). Started any other way, the key is one nobody has: the API and
// the page stay shut, except to Claude when Settings lets it in. The line
// after it is the key the keys file is encrypted with, when the app has one.
const fromApp = process.env.PERISKOPOS_SESSION_KEY_STDIN === "1";
const fromStdin = fromApp ? await readStdinKeys() : undefined;
const token = fromStdin?.session ?? newSessionKey();
useKeysKey(parseKeysKey(fromStdin?.keys));
if (!fromApp) console.log("Started without the desktop app: Periskopos's window opens only from the app.");
const agentToken = loadOrCreateToken(DATA_DIR);
// The desktop notification, and the phone when phone alerts are on.
const notifier = withPhone(systemNotifier(), db);
const watcher = new Watcher({ db, notifier, baseUrl: `http://localhost:${PORT}`, audits: {} });
const icons = new AppIcons({ db });
const app = createApp({ db, token, agentToken, port: PORT, distDir: DIST_WEB, notifier, watcher, icons, backups });

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`Periskopos is running at http://localhost:${PORT}`);
  watcher.start();
  icons.start();
  backups.start();
});

server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === "EADDRINUSE"
      ? `Port ${PORT} is in use: Periskopos is probably already running (it may have started at login).`
      : err,
  );
  process.exit(1);
});

// The database, or (it won't open, or can't be brought up to date) a clear
// reason on the way out: never a run on an empty registry in its place.
async function openDbOrSayWhy(file: string): Promise<DatabaseSync> {
  try {
    return openDb(file);
  } catch (err) {
    if (!(err instanceof DatabaseError)) throw err;
    const message = `${err.message}

Nothing was changed. To restore a backup, quit Periskopos and copy one of the files in ${backupsDir(DATA_DIR)} in place of ${file} (see https://periskopos.com/docs/app/backups/).`;
    console.error(message);
    // Exits once the line is out: the app shows it in its dialog.
    process.stdout.write(`${fatalLine(message)}
`, () => process.exit(3));
    return new Promise(() => {});
  }
}

// The app writes both lines, then closes stdin.
async function readStdinKeys(): Promise<{ session: string; keys: string | undefined }> {
  let data = "";
  for await (const chunk of process.stdin) data += String(chunk);
  const [session = "", keys] = data.split(/\r?\n/).map((line) => line.trim());
  if (session.length < 32) {
    console.error("No session key from the desktop app on stdin.");
    process.exit(1);
  }
  return { session, keys };
}
