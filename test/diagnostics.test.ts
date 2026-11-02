import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { openDb } from "../server/db.ts";
import { diagnostics, recentCrashes, recentProblems, recordCrash, recordProblem, redact } from "../server/diagnostics.ts";
import * as store from "../server/store.ts";
import { tempDir } from "./tmp.ts";

// Copy diagnostics (Settings → About): what goes into a bug report, and what
// never does.

describe("diagnostics: nothing private leaves", () => {
  test("addresses, emails, tokens and the user's folder are taken out", () => {
    const line = "GET https://api.cloudflare.com/client/v4/zones?name=example.org failed for me@example.org with ghp_abcdefghijklmnopqrstuvwxyz0123 in C:\\Users\\alex\\AppData and /home/sam/x";
    const out = redact(line, "C:\\Users\\alex");
    assert.doesNotMatch(out, /cloudflare\.com|star-map|ghp_|alex|sam\//);
    assert.match(out, /GET <url> failed for <email> with <redacted> in ~\\AppData and \/home\/<you>\/x/);
  });

  test("what's connected is said by kind, never by name or address", () => {
    const db = openDb(":memory:");
    const user = store.createUser(db, "Daniel Secret");
    const app = store.createApp(db, user.id, { name: "Hidden-App", url: "https://hidden-app.example.com/" });
    const gh = store.createService(db, user.id, { type: "github", name: "My Private GitHub", canWrite: false });
    store.addConnection(db, app, { type: "github", serviceId: gh.id, resource: "secret-org/secret-repo", settings: { branch: "main", paths: [] } });
    recordProblem("Check failed for https://hidden-app.example.com/health");
    assert.equal(recentProblems().at(-1)!.text, "Check failed for <url>", "kept already redacted, not only when printed");
    const text = diagnostics(db);
    assert.match(text, /^Periskopos \d+\.\d+\.\d+ diagnostics/);
    assert.match(text, /Apps: 1 \(1 live\)/);
    assert.match(text, /Connections: .*github/);
    assert.match(text, /Accounts: github \(key gh\)/);
    assert.match(text, /Check failed for <url>/);
    assert.doesNotMatch(text, /Hidden-App|hidden-app|Daniel|Secret|secret-org|My Private/i);
  });

  test("the last 50 problems are kept; a crash goes to a file and is read back", () => {
    for (let i = 0; i < 60; i++) recordProblem(`problem ${i}`);
    const kept = recentProblems();
    assert.equal(kept.length, 50);
    assert.equal(kept.at(-1)!.text, "problem 59");
    const dir = tempDir("periskopos-crash-");
    recordCrash(new Error("boom at https://secret.example.com"), dir);
    const [crash] = recentCrashes(dir);
    assert.match(crash!.text, /^Error: boom at <url>/);
  });
});
