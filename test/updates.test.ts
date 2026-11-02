import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import {
  LOCAL_INSTALL_ARGS,
  RELEASES,
  busyNotice,
  findLocalBuild,
  findUpdateToken,
  isNewer,
  localBuildsDir,
  parseLatestYml,
  releasePage,
  trayUpdateItem,
  updateMode,
} from "../desktop/update-plan.ts";
import { updateView } from "../shared/desktop.ts";
import { tempDir } from "./tmp.ts";

// The desktop app's updates (README → Updates). The updater itself is
// electron-updater; these cover the choices around it.

describe("where updates come from", () => {
  const none = async () => undefined;

  test("the keys file first, then GH_TOKEN, then GITHUB_TOKEN, then the gh login", async () => {
    const gh = async () => "gho_from_cli\n";
    assert.deepEqual(await findUpdateToken({ PERISKOPOS_UPDATE_TOKEN: " ghp_keys " }, { GH_TOKEN: "env" }, gh), { token: "ghp_keys", from: "PERISKOPOS_UPDATE_TOKEN in the keys file" });
    assert.deepEqual(await findUpdateToken({}, { GH_TOKEN: "ghp_env" }, gh), { token: "ghp_env", from: "GH_TOKEN" });
    assert.deepEqual(await findUpdateToken({}, { GH_TOKEN: "ghp_env", GITHUB_TOKEN: "ghp_other" }, gh), { token: "ghp_env", from: "GH_TOKEN" });
    assert.deepEqual(await findUpdateToken({}, { GITHUB_TOKEN: " ghp_actions " }, gh), { token: "ghp_actions", from: "GITHUB_TOKEN" });
    assert.deepEqual(await findUpdateToken({ PERISKOPOS_UPDATE_TOKEN: "  " }, {}, gh), { token: "gho_from_cli", from: "the GitHub CLI login" });
  });

  test("with none, there's no token: the public releases are read without one", async () => {
    assert.equal(await findUpdateToken({}, {}, none), undefined);
  });

  test("the build publishes to the same public repo the app reads", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      build: { publish: { provider: string; owner: string; repo: string; private: boolean }[] };
      dependencies: Record<string, string>;
    };
    const [publish] = pkg.build.publish;
    assert.deepEqual([publish?.provider, publish?.owner, publish?.repo, publish?.private], ["github", RELEASES.owner, RELEASES.repo, false]);
    assert.ok(pkg.dependencies["electron-updater"], "shipped with the app, not only a dev dependency");
    // The MCP server is set up from the installed app's folder (Settings → AI assistants).
    assert.ok((pkg as unknown as { build: { files: string[] } }).build.files.includes("mcp/**/*"), "the installer ships the MCP server");
    assert.ok(pkg.dependencies["@modelcontextprotocol/sdk"], "and what it runs on");
    // Apache-2.0 asks for both with every copy handed out.
    for (const f of ["LICENSE", "NOTICE"]) assert.ok((pkg as unknown as { build: { files: string[] } }).build.files.includes(f), `the installer ships ${f}`);
    assert.equal(releasePage("0.2.0"), "https://github.com/periskopos/periskopos/releases/tag/v0.2.0");
  });
});

describe("how each platform updates", () => {
  test("silent on Windows and Linux; a Mac (unsigned) is told", () => {
    assert.equal(updateMode("win32"), "silent");
    assert.equal(updateMode("linux"), "silent");
    assert.equal(updateMode("darwin"), "notify");
  });

  test("the tray's line for each state", () => {
    assert.deepEqual(trayUpdateItem({ kind: "idle" }), { label: "Check for updates", enabled: true, action: "check" });
    assert.equal(trayUpdateItem({ kind: "checking" }).enabled, false);
    assert.deepEqual(trayUpdateItem({ kind: "downloading", version: "0.2.0" }), { label: "Downloading version 0.2.0…", enabled: false });
    assert.deepEqual(trayUpdateItem({ kind: "ready", version: "0.2.0" }), { label: "Restart to update to 0.2.0", enabled: true, action: "install" });
    assert.deepEqual(trayUpdateItem({ kind: "available", version: "0.2.0" }), { label: "Download version 0.2.0…", enabled: true, action: "download" });
    assert.equal(trayUpdateItem({ kind: "unavailable", reason: "x" }).enabled, false);
  });

  test("checking by hand while busy says where it stands", () => {
    assert.match(busyNotice({ kind: "checking" })?.title ?? "", /Already checking/);
    assert.match(busyNotice({ kind: "downloading", version: "0.3.0" })?.title ?? "", /Downloading version 0\.3\.0/);
    assert.match(busyNotice({ kind: "ready", version: "0.3.0" })?.title ?? "", /0\.3\.0 is ready: restart to update/);
    assert.equal(busyNotice({ kind: "idle" }), undefined);
    assert.equal(busyNotice({ kind: "available", version: "0.3.0" }), undefined);
  });
});

describe("a build made on this computer", () => {
  // A folder as `npm run desktop:dist` leaves it: an installer and the
  // latest.yml naming it, with its checksum.
  function build(version: string, { installer = "installer bytes", sha512 }: { installer?: string; sha512?: string } = {}) {
    const dir = tempDir("periskopos-local-build-");
    const file = `Periskopos-Setup-${version}-x64.exe`;
    writeFileSync(path.join(dir, file), installer);
    const sum = sha512 ?? createHash("sha512").update(installer).digest("base64");
    const lines = [`version: ${version}`, "files:", `  - url: ${file}`, `    sha512: ${sum}`, "    size: 15", `path: ${file}`, `sha512: ${sum}`, "releaseDate: '2026-10-27T11:54:05.402Z'"];
    writeFileSync(path.join(dir, "latest.yml"), lines.join("\r\n") + "\r\n");
    return { dir, installer: path.join(dir, file) };
  }

  test("looked for only in the keys file's folder, and only on Windows", () => {
    assert.equal(localBuildsDir({ PERISKOPOS_LOCAL_BUILDS: " D:\\builds " }, "win32"), "D:\\builds");
    assert.equal(localBuildsDir({}, "win32"), undefined);
    assert.equal(localBuildsDir({ PERISKOPOS_LOCAL_BUILDS: "  " }, "win32"), undefined);
    assert.equal(localBuildsDir({ PERISKOPOS_LOCAL_BUILDS: "/builds" }, "darwin"), undefined);
  });

  test("versions compare by number, not as text", () => {
    assert.equal(isNewer("0.2.10", "0.2.9"), true);
    assert.equal(isNewer("0.3.0", "0.2.27"), true);
    assert.equal(isNewer("1.0.0", "0.99.99"), true);
    assert.equal(isNewer("0.2.25", "0.2.25"), false);
    assert.equal(isNewer("0.2.24", "0.2.25"), false);
    assert.equal(isNewer("0.2.26-beta.1", "0.2.25"), true);
  });

  test("latest.yml gives the version, the installer and its checksum", () => {
    const text = "version: 0.2.25\r\nfiles:\r\n  - url: a.exe\r\n    sha512: inner==\r\npath: Periskopos-Setup-0.2.25-x64.exe\r\nsha512: top==\r\nreleaseDate: '2026-10-27T11:54:05.402Z'\r\n";
    assert.deepEqual(parseLatestYml(text), { version: "0.2.25", file: "Periskopos-Setup-0.2.25-x64.exe", sha512: "top==" });
    assert.equal(parseLatestYml("version: 0.2.25\n"), undefined);
  });

  test("offered when it's newer than the app and its installer is whole", async () => {
    const { dir, installer } = build("0.2.27");
    assert.deepEqual(await findLocalBuild(dir, "0.2.25"), { version: "0.2.27", installer });
  });

  test("the installer is only ever looked for in the builds folder", async () => {
    const { dir, installer } = build("0.2.27");
    // A latest.yml whose path climbs out of the folder still means the file in it.
    const yml = path.join(dir, "latest.yml");
    writeFileSync(yml, readFileSync(yml, "utf8").replace(/^path: /m, "path: ../../"));
    assert.deepEqual(await findLocalBuild(dir, "0.2.25"), { version: "0.2.27", installer });
  });

  test("not offered when it's the version running or older", async () => {
    assert.equal(await findLocalBuild(build("0.2.25").dir, "0.2.25"), undefined);
    assert.equal(await findLocalBuild(build("0.2.24").dir, "0.2.25"), undefined);
  });

  test("not offered when the installer doesn't match its checksum, or isn't there", async () => {
    assert.equal(await findLocalBuild(build("0.2.27", { sha512: "c3RpbGwgYmVpbmcgd3JpdHRlbg==" }).dir, "0.2.25"), undefined);
    assert.equal(await findLocalBuild(tempDir("periskopos-local-build-"), "0.2.25"), undefined);
    assert.equal(await findLocalBuild(path.join(tempDir("periskopos-local-build-"), "missing"), "0.2.25"), undefined);
  });

  test("installed quietly over the app, then started", () => {
    assert.deepEqual([...LOCAL_INSTALL_ARGS], ["--updated", "/S", "--force-run"]);
  });

  test("the window and the tray say it's a local build that installs on restart", () => {
    const ready = { kind: "ready" as const, version: "0.2.27", from: "local" as const };
    const view = updateView({ version: "0.2.25", state: ready });
    assert.equal(view.status, "0.2.27 is ready");
    assert.match(view.detail ?? "", /build on this computer.*restart/);
    assert.doesNotMatch(view.detail ?? "", /quit/);
    assert.deepEqual(view.action, { kind: "install", label: "Restart to update" });
    assert.deepEqual(trayUpdateItem(ready), { label: "Restart to update to 0.2.27", enabled: true, action: "install" });
    assert.doesNotMatch(busyNotice(ready)?.body ?? "", /quit/);
  });
});
