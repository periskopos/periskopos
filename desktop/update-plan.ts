import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { UpdateState } from "../shared/desktop.ts";

// What the updater does, kept free of Electron so it can be tested.
//
// Releases live in the repo's own Releases (README → Updates), read without
// a token while the repo is public. A GitHub token, if there is one, is used
// too: a private repo or a fork needs it, and it lifts GitHub's limit on
// requests without one. Nothing is built into the installer.

export const RELEASES = { owner: "periskopos", repo: "periskopos" } as const;
export const UPDATE_TOKEN_VAR = "PERISKOPOS_UPDATE_TOKEN";

export const FIRST_CHECK_AFTER_MS = 30_000;
export const CHECK_EVERY_MS = 6 * 60 * 60_000;

// Windows and Linux install an update themselves. macOS only does that for a
// signed app, so an unsigned Mac build says a new version is ready and opens
// its download instead.
export type UpdateMode = "silent" | "notify";
export const updateMode = (platform: NodeJS.Platform): UpdateMode => (platform === "darwin" ? "notify" : "silent");

export type TokenSource = { token: string; from: string };

// The first that's set, if any: the keys file's PERISKOPOS_UPDATE_TOKEN, then GH_TOKEN and
// GITHUB_TOKEN in the environment, then the `gh` login. The updater makes the
// chosen one the token it really uses (electron-updater would otherwise let
// an environment token win over it).
export async function findUpdateToken(
  keys: Record<string, string>,
  env: NodeJS.ProcessEnv,
  ghToken: () => Promise<string | undefined>,
): Promise<TokenSource | undefined> {
  const fromKeys = keys[UPDATE_TOKEN_VAR]?.trim();
  if (fromKeys) return { token: fromKeys, from: `${UPDATE_TOKEN_VAR} in the keys file` };
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const fromEnv = env[name]?.trim();
    if (fromEnv) return { token: fromEnv, from: name };
  }
  const fromGh = (await ghToken())?.trim();
  if (fromGh) return { token: fromGh, from: "the GitHub CLI login" };
  return undefined;
}

// A build made on this computer (`npm run desktop:dist`) is offered too,
// without waiting for a release: Windows only, since only its installer can
// be run quietly over the installed app. The folder is PERISKOPOS_LOCAL_BUILDS in the
// keys file (the checkout's release\win, say); without it, none is looked for.
export const LOCAL_BUILDS_VAR = "PERISKOPOS_LOCAL_BUILDS";

export function localBuildsDir(keys: Record<string, string>, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32") return undefined;
  return keys[LOCAL_BUILDS_VAR]?.trim() || undefined;
}

// 1.2.10 is newer than 1.2.9; a pre-release suffix is ignored.
export function isNewer(version: string, than: string): boolean {
  const parts = (v: string) => v.split("-")[0]!.split(".").map((n) => Number(n) || 0);
  const [a, b] = [parts(version), parts(than)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

// The few lines of electron-builder's latest.yml that say which installer
// is the newest build, and its checksum.
export function parseLatestYml(text: string): { version: string; file: string; sha512: string } | undefined {
  const line = (key: string) => text.match(new RegExp(`^${key}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, "m"))?.[1];
  const [version, file, sha512] = [line("version"), line("path"), line("sha512")];
  return version && file && sha512 ? { version, file, sha512 } : undefined;
}

export type LocalBuild = { version: string; installer: string };

// The build in the folder, if it's newer than the version running and its
// installer is all there (a build still being written, or one replaced
// since, doesn't match its checksum). undefined: nothing to offer.
export async function findLocalBuild(dir: string, current: string): Promise<LocalBuild | undefined> {
  let latest;
  try {
    latest = parseLatestYml(await readFile(path.join(dir, "latest.yml"), "utf8"));
  } catch {
    return undefined;
  }
  if (!latest || !isNewer(latest.version, current)) return undefined;
  const installer = path.join(dir, path.basename(latest.file));
  try {
    const hash = createHash("sha512");
    for await (const chunk of createReadStream(installer)) hash.update(chunk as Buffer);
    if (hash.digest("base64") !== latest.sha512) return undefined;
  } catch {
    return undefined;
  }
  return { version: latest.version, installer };
}

// How electron-updater runs a Windows installer over the installed app:
// quietly, as an update (same folder, shortcuts kept), then starting it.
export const LOCAL_INSTALL_ARGS = ["--updated", "/S", "--force-run"] as const;

export const releasePage = (version: string) => `https://github.com/${RELEASES.owner}/${RELEASES.repo}/releases/tag/v${version}`;

// Where the updater stands: shared with the window (shared/desktop.ts).
export type { UpdateState };

// "Check for updates" chosen by hand while the updater is already busy: say
// where it stands rather than nothing at all. undefined: free to check.
export function busyNotice(state: UpdateState): { title: string; body: string } | undefined {
  switch (state.kind) {
    case "checking":
      return { title: "Already checking for updates", body: "You'll hear what it finds." };
    case "downloading":
      return { title: `Downloading version ${state.version}`, body: "You'll be told when it's ready to install." };
    case "ready":
      return state.from === "local"
        ? { title: `Version ${state.version} is ready: restart to update`, body: "A build on this computer. Choose Restart to update in the tray menu." }
        : { title: `Version ${state.version} is ready: restart to update`, body: "Choose Restart to update in the tray menu, or it installs when you quit." };
    default:
      return undefined;
  }
}

export type TrayUpdateItem ={ label: string; enabled: boolean; action?: "check" | "install" | "download" };

export function trayUpdateItem(state: UpdateState): TrayUpdateItem {
  switch (state.kind) {
    case "idle":
      return { label: "Check for updates", enabled: true, action: "check" };
    case "checking":
      return { label: "Checking for updates…", enabled: false };
    case "downloading":
      return { label: `Downloading version ${state.version}…`, enabled: false };
    case "ready":
      return { label: `Restart to update to ${state.version}`, enabled: true, action: "install" };
    case "available":
      return { label: `Download version ${state.version}…`, enabled: true, action: "download" };
    case "unavailable":
      return { label: "Updates: installed app only", enabled: false };
  }
}
