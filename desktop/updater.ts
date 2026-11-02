import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parseEnv, promisify } from "node:util";
import { merge, parseKeysKey, unseal } from "../server/keys/sealed-keys.ts";
import { app, autoUpdater as electronAutoUpdater } from "electron";
import electronUpdater from "electron-updater";
import type { DesktopNotice } from "../shared/desktop.ts";
import {
  CHECK_EVERY_MS,
  busyNotice,
  FIRST_CHECK_AFTER_MS,
  LOCAL_INSTALL_ARGS,
  RELEASES,
  findLocalBuild,
  findUpdateToken,
  localBuildsDir,
  releasePage,
  updateMode,
} from "./update-plan.ts";
import type { LocalBuild, UpdateState } from "./update-plan.ts";

// Keeps the installed app up to date from the private repo's Releases (see
// update-plan.ts). Checks soon after start and every 6 hours; "Check for
// updates" in the tray and the menu checks now and always says what it found.
// A newer build made on this computer comes first (update-plan.ts).

const run = promisify(execFile);

export type UpdaterOptions = {
  envFile: string | undefined;
  keysKey: string | undefined;
  log: (text: string) => void;
  notify: (notice: DesktopNotice) => void;
  openExternal: (url: string) => void;
  onState: (state: UpdateState) => void;
  // When an install is really about to restart the app (not merely asked
  // for): let the window and the server go cleanly.
  beforeInstall: () => void;
};

async function ghAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 10_000, windowsHide: true });
    return stdout;
  } catch {
    return undefined;
  }
}

function keysFile(file: string | undefined, key: string | undefined): Record<string, string> {
  if (!file) return {};
  try {
    const { text, added } = unseal(readFileSync(file, "utf8"), parseKeysKey(key));
    return parseEnv(merge(text, added)) as Record<string, string>;
  } catch {
    return {};
  }
}

// electron-updater's private GitHub feed takes GH_TOKEN (or GITHUB_TOKEN) from
// the environment over the token it is given, so a stray one would quietly
// replace PERISKOPOS_UPDATE_TOKEN while the log named the other. The feed's client is
// made inside setFeedURL, so the chosen token is put in GH_TOKEN just for that
// call, and the environment is put back as it was (the server and a relaunch
// inherit it).
function useToken(token: string, configure: () => void): void {
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = token;
  try {
    configure();
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = before;
  }
}

export function startUpdater(options: UpdaterOptions) {
  // Read only here: making it needs Electron's app object, ready.
  const { autoUpdater } = electronUpdater;
  const mode = updateMode(process.platform);
  let state: UpdateState = { kind: "idle" };
  let asked = false; // a check I started by hand: say what it found, even "nothing"
  let local: LocalBuild | undefined; // the build on this computer that "ready" means, if it's one

  const set = (next: UpdateState) => {
    state = next;
    options.onState(next);
  };

  autoUpdater.logger = {
    info: (m: unknown) => options.log(`update: ${String(m)}`),
    warn: (m: unknown) => options.log(`update warning: ${String(m)}`),
    error: (m: unknown) => options.log(`update error: ${String(m)}`),
    debug: () => {},
  };
  autoUpdater.autoDownload = mode === "silent";
  autoUpdater.autoInstallOnAppQuit = mode === "silent";

  autoUpdater.on("update-available", (info) => {
    if (mode === "silent") {
      set({ kind: "downloading", version: info.version });
      return;
    }
    set({ kind: "available", version: info.version });
    options.notify({ title: `Periskopos ${info.version} is ready`, body: "Choose Download in the tray menu, then drag it into Applications." });
  });
  autoUpdater.on("update-not-available", () => {
    set({ kind: "idle", checkedAt: new Date().toISOString() });
    if (asked) options.notify({ title: "Periskopos is up to date", body: `You have the latest version.` });
    asked = false;
  });
  autoUpdater.on("update-downloaded", (info) => {
    set({ kind: "ready", version: info.version });
    options.notify({ title: `Periskopos ${info.version} is ready`, body: "It installs when you quit, or choose Restart to update in the tray menu." });
    asked = false;
  });
  autoUpdater.on("error", (err) => {
    options.log(`update error: ${err.message}`);
    // A failed background check stays in the log; one I asked for is shown.
    if (asked) options.notify({ title: "Couldn't check for updates", body: err.message.split("\n")[0] ?? "" });
    asked = false;
    // The window's update button says why, with the first line of the error.
    if (state.kind === "checking" || state.kind === "downloading") set({ kind: "idle", problem: err.message.split("\n")[0] ?? "Unknown error" });
  });

  // Only once an install really goes ahead (electron-updater raises this just
  // before it quits for the installer): a failed one leaves the app running as
  // before, still hiding to the tray and still watching its server.
  electronAutoUpdater.on("before-quit-for-update", () => options.beforeInstall());

  // Set while a check is finding its token, before the state says
  // "checking": a second check then must not start one of its own.
  let starting = false;

  async function check(byHand: boolean): Promise<void> {
    if (starting) {
      // One I asked for hears how the one already starting turns out.
      if (byHand) asked = true;
      return;
    }
    const busy = busyNotice(state);
    if (busy) {
      // A background check just waits its turn; one I asked for says why.
      if (byHand) options.notify(busy);
      return;
    }
    asked = byHand;
    starting = true;
    let found: Awaited<ReturnType<typeof findUpdateToken>>;
    try {
      const keys = keysFile(options.envFile, options.keysKey);
      const dir = localBuildsDir(keys, process.platform);
      local = dir ? await findLocalBuild(dir, app.getVersion()) : undefined;
      if (local) {
        options.log(`update: ${local.version} built on this computer, ${local.installer}`);
        set({ kind: "ready", version: local.version, from: "local" });
        options.notify({ title: `Periskopos ${local.version} is ready`, body: "A build on this computer. Choose Restart to update in the tray menu." });
        asked = false;
        return;
      }
      found = await findUpdateToken(keys, process.env, ghAuthToken);
    } finally {
      starting = false;
    }
    const feed = { provider: "github" as const, owner: RELEASES.owner, repo: RELEASES.repo };
    if (found) {
      const { token, from } = found;
      useToken(token, () => autoUpdater.setFeedURL({ ...feed, private: true, token }));
      options.log(`update: checking, with ${from}`);
    } else {
      autoUpdater.setFeedURL(feed);
      options.log("update: checking the public releases");
    }
    set({ kind: "checking" });
    try {
      await autoUpdater.checkForUpdates();
    } catch {
      // Reported through the "error" event.
    }
  }

  const first = setTimeout(() => void check(false), FIRST_CHECK_AFTER_MS);
  const every = setInterval(() => void check(false), CHECK_EVERY_MS);
  first.unref();
  every.unref();

  return {
    check: () => void check(true),
    install: () => {
      if (state.kind !== "ready") return;
      if (state.from !== "local") {
        autoUpdater.quitAndInstall(true, true); // quietly, then start the new version
        return;
      }
      if (!local) return;
      // The installer waits for this app to close, replaces it, and starts
      // the new version.
      if (!existsSync(local.installer)) {
        options.notify({ title: "Couldn't install the build", body: `${local.installer} is gone. Build it again, or check for updates.` });
        local = undefined;
        set({ kind: "idle" });
        return;
      }
      options.log(`update: installing ${local.version} from ${local.installer}`);
      const installer = spawn(local.installer, [...LOCAL_INSTALL_ARGS], { detached: true, stdio: "ignore", windowsHide: true });
      installer.on("error", (err) => options.log(`update error: the installer didn't start: ${err.message}`));
      installer.unref();
      options.beforeInstall();
      app.quit();
    },
    download: () => {
      if (state.kind === "available") options.openExternal(releasePage(state.version));
    },
    stop: () => {
      clearTimeout(first);
      clearInterval(every);
    },
  };
}
