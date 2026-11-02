import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { classifyHolder, describeHolder, findHolder, holderDetail, parseUnix, parseWindows } from "../desktop/port-holder.ts";
import { tempDir } from "./tmp.ts";

// Another Periskopos on the app's port: which process, and may the app
// stop it? Only a server no Periskopos app is running.

describe("who holds the port", () => {
  test("a server started by hand and left running is a leftover (the morning of 2026-10-18)", () => {
    assert.equal(
      classifyHolder({
        pid: 12636,
        command: "C:\\Program Files\\nodejs\\node.exe C:\\Users\\you\\code\\periskopos\\server\\main.ts --log",
        parentExe: "C:\\Windows\\System32\\conhost.exe",
      }),
      "leftover",
    );
    // Its parent gone: still a leftover.
    assert.equal(classifyHolder({ pid: 1, command: "node server/main.ts" }), "leftover");
  });

  test("an open Periskopos app's own server is the app's: never stopped from here", () => {
    const installed = "C:\\Users\\me\\AppData\\Local\\Programs\\periskopos\\periskopos.exe";
    assert.equal(classifyHolder({ pid: 2, command: `${installed} C:\\Users\\me\\AppData\\Local\\Programs\\periskopos\\resources\\app\\server\\main.ts`, parentExe: installed }), "app");
    assert.equal(classifyHolder({ pid: 3, command: "/x/electron /repo/server/main.ts", parentExe: "/x/node_modules/electron/dist/electron" }), "app");
  });

  test("anything that isn't a Periskopos server is left alone", () => {
    assert.equal(classifyHolder({ pid: 4, command: "python -m http.server 4100" }), "unknown");
    assert.equal(classifyHolder({ pid: 5, command: "node other/main.ts" }), "unknown");
    assert.equal(classifyHolder({ pid: 6, command: "node myserver/main.ts" }), "unknown");
  });

  test("described for the dialog, long command lines cut from the left", () => {
    assert.equal(describeHolder({ pid: 7, command: "node server/main.ts" }), "process 7 (node server/main.ts)");
    assert.ok(describeHolder({ pid: 8, command: `node ${"x".repeat(300)}/server/main.ts` }).endsWith("/server/main.ts)"));
  });

  test("the dialog says when it starts at login, and that stopping it removes that", () => {
    const holder = { pid: 17512, command: "node C:\\Users\\me\\periskopos\\server\\main.ts --log" };
    const atLogin = holderDetail(holder, 4100, true);
    assert.match(atLogin, /holds port 4100: process 17512/);
    assert.match(atLogin, /starts at login from the old "npm run install-service" setup/);
    assert.match(atLogin, /Stopping it also removes that/);
    assert.doesNotMatch(atLogin, /also run/, "nothing left for me to do by hand");
    const once = holderDetail(holder, 4100, false);
    assert.match(once, /safe to stop\.$/);
    assert.doesNotMatch(once, /login/);
  });

  test("what Windows and ps say is read, and nonsense isn't", () => {
    assert.deepEqual(parseWindows('{"pid":12,"command":"node server/main.ts","parentExe":"C:\\\\Windows\\\\conhost.exe"}'), { pid: 12, command: "node server/main.ts", parentExe: "C:\\Windows\\conhost.exe" });
    assert.deepEqual(parseWindows('{"pid":12,"command":"node server/main.ts","parentExe":""}'), { pid: 12, command: "node server/main.ts" });
    assert.equal(parseWindows(""), undefined);
    assert.equal(parseWindows('{"pid":"x"}'), undefined);
    assert.deepEqual(parseUnix(40, "  31 /usr/bin/node /repo/server/main.ts --log\n", "zsh\n"), { pid: 40, command: "/usr/bin/node /repo/server/main.ts --log", parentExe: "zsh" });
    assert.equal(parseUnix(40, "", undefined), undefined);
  });
});

describe("finding it for real", { skip: !["win32", "darwin", "linux"].includes(process.platform) }, () => {
  test("a server/main.ts listening on a port is found, and is a leftover", async () => {
    const dir = tempDir("periskopos-holder-");
    mkdirSync(path.join(dir, "server"));
    writeFileSync(
      path.join(dir, "server", "main.ts"),
      `import { createServer } from "node:http";\nconst s = createServer((_q, r) => r.end("ok"));\ns.listen(0, "127.0.0.1", () => console.log((s.address() as { port: number }).port));\n`,
    );
    const child = spawn(process.execPath, [path.join(dir, "server", "main.ts")], { stdio: ["ignore", "pipe", "inherit"] });
    try {
      const port = await new Promise<number>((resolve, reject) => {
        child.stdout.once("data", (d: Buffer) => resolve(Number(String(d).trim())));
        child.once("exit", () => reject(new Error("the test server exited")));
      });
      // The OS's own tables can lag a moment behind a new listener, and a
      // busy machine answers slowly (each ask is a second or two of
      // PowerShell): asked until a deadline, not a set number of times.
      // findHolder doesn't go by the socket's state, which some Windows
      // machines report as nonsense for seconds at a time.
      const deadline = Date.now() + 40_000;
      let holder = await findHolder(port);
      while (!holder && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        holder = await findHolder(port);
      }
      assert.ok(holder, "found");
      assert.equal(holder.pid, child.pid);
      assert.match(holder.command, /server[\\/]main\.ts/);
      assert.equal(classifyHolder(holder), "leftover");
    } finally {
      child.kill();
    }
  });
});
