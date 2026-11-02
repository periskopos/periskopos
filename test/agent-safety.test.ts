import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { Approvals } from "../server/agents/approvals.ts";
import { userAppDir } from "../server/config.ts";
import { moveLegacyEnvFile, readSecret, writeSecret } from "../server/keys/secrets.ts";
import { agentMayCall, agentName } from "../server/security.ts";
import { tempDir } from "./tmp.ts";

// docs/AGENT-SAFETY.md. The API-level checks (tokens, approval through MCP)
// are in mcp.test.ts and protocol.test.ts.

describe("what the agent token may call (§4.1)", () => {
  test("reads, and asking for an action", () => {
    assert.equal(agentMayCall("GET", "/api/apps"), true);
    assert.equal(agentMayCall("GET", "/api/apps/star-map/history"), true);
    assert.equal(agentMayCall("POST", "/api/apps/star-map/actions/redeploy:c_abc"), true);
  });

  test("nothing else", () => {
    for (const [method, p] of [
      ["GET", "/api/approvals"],
      ["GET", "/api/approvals/ap_1"],
      ["GET", "/api/agents"], // the assistants, their tokens and the audit log: on screen only
      ["GET", "/api/agents/ag_1/audit"],
      ["POST", "/api/approvals/ap_1"],
      ["POST", "/api/apps"],
      ["POST", "/api/apps/star-map/actions"],
      ["POST", "/api/apps/star-map/actions/redeploy:c_abc/more"],
      ["PATCH", "/api/apps/star-map/actions/redeploy:c_abc"],
      ["PATCH", "/api/services/s_1"],
      ["DELETE", "/api/apps/star-map"],
      ["POST", "/api/apps/star-map/protocol/generate"],
    ] as const) {
      assert.equal(agentMayCall(method, p), false, `${method} ${p}`);
    }
  });
});

describe("approvals (§4.2)", () => {
  test("approve, decline, and running out of time", async () => {
    const approvals = new Approvals({ timeoutMs: 50 });
    const info = { appSlug: "a", appName: "A", actionId: "redeploy:c_1", label: "Redeploy", service: "Render", agent: "Claude Code" };

    const approved = approvals.request(info);
    const [first] = approvals.list();
    assert.ok(first && Date.parse(first.expiresAt) > Date.parse(first.requestedAt));
    assert.equal(approvals.decide(first.id, true), true);
    assert.equal(await approved, "approved");
    assert.equal(approvals.decide(first.id, false), false, "only once");

    const declined = approvals.request(info);
    approvals.decide(approvals.list()[0]!.id, false);
    assert.equal(await declined, "declined");

    assert.equal(await approvals.request(info), "expired");
    assert.deepEqual(approvals.list(), []);
  });

  test("an agent that hangs up stops the question", async () => {
    const approvals = new Approvals({ timeoutMs: 60_000 });
    const ctrl = new AbortController();
    const pending = approvals.request({ appSlug: "a", appName: "A", actionId: "x", label: "X", service: "S", agent: "Cursor" }, ctrl.signal);
    ctrl.abort();
    assert.equal(await pending, "expired");
    assert.deepEqual(approvals.list(), []);
  });

  test("an agent that hung up before the question was put never gets one", async () => {
    const approvals = new Approvals({ timeoutMs: 60_000 });
    let shown = 0;
    approvals.onRequest(() => shown++);
    const ctrl = new AbortController();
    ctrl.abort(); // e.g. during the up-to-15 s check of the app's own actions
    assert.equal(await approvals.request({ appSlug: "a", appName: "A", actionId: "x", label: "X", service: "S", agent: "Cursor" }, ctrl.signal), "expired");
    assert.equal(shown, 0, "no dialog, no notification");
    assert.deepEqual(approvals.list(), []);
  });
});

describe("keys out of the project folder (§4.3)", () => {
  test("a generated secret is written even when the per-user folder doesn't exist yet", () => {
    const file = path.join(tempDir("periskopos-keys-"), "Roaming", "Periskopos", ".env.local");
    process.env.PERISKOPOS_ENV_FILE = file;
    try {
      writeSecret("PERISKOPOS_PROTOCOL_X", "abc");
      assert.equal(readSecret("PERISKOPOS_PROTOCOL_X"), "abc");
      assert.equal(readFileSync(file, "utf8"), "PERISKOPOS_PROTOCOL_X=abc\n");
    } finally {
      delete process.env.PERISKOPOS_ENV_FILE;
    }
  });

  test("a per-user folder on each platform", () => {
    assert.equal(userAppDir("win32", { APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "C:\\Users\\me"), path.join("C:\\Users\\me\\AppData\\Roaming", "Periskopos"));
    assert.equal(userAppDir("darwin", {}, "/Users/me"), path.join("/Users/me", "Library", "Application Support", "Periskopos"));
    assert.equal(userAppDir("linux", {}, "/home/me"), path.join("/home/me", ".config", "Periskopos"));
  });

  const dirs = () => {
    const root = tempDir("periskopos-keys-");
    mkdirSync(path.join(root, "project"));
    return { from: path.join(root, "project", ".env.local"), to: path.join(root, "profile", "Periskopos", ".env.local") };
  };

  test("moves the old file, once, and says so", () => {
    const { from, to } = dirs();
    writeFileSync(from, "RENDER_API_KEY=abc\n");
    assert.match(moveLegacyEnvFile(from, to) ?? "", /^Moved your keys/);
    assert.equal(existsSync(from), false, "moved, not copied");
    assert.equal(readFileSync(to, "utf8"), "RENDER_API_KEY=abc\n");
    assert.equal(moveLegacyEnvFile(from, to), undefined, "nothing left to move");
  });

  test("never overwrites keys already in the new place", () => {
    const { from, to } = dirs();
    writeFileSync(from, "OLD=1\n");
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, "NEW=1\n");
    assert.match(moveLegacyEnvFile(from, to) ?? "", /still a \.env\.local/);
    assert.equal(readFileSync(to, "utf8"), "NEW=1\n");
    assert.equal(readFileSync(from, "utf8"), "OLD=1\n");
  });
});

describe("naming the AI assistant", () => {
  test("well-known tools by their usual names, others as plain text, none as 'an AI assistant'", () => {
    assert.equal(agentName("claude-code"), "Claude Code");
    assert.equal(agentName("claude-ai"), "Claude Desktop");
    assert.equal(agentName("cursor-vscode"), "Cursor");
    assert.equal(agentName("Visual Studio Code"), "VS Code");
    assert.equal(agentName("my-bot"), "my-bot");
    assert.equal(agentName("<script>x</script>"), "scriptxscript");
    assert.equal(agentName("x".repeat(80)).length, 40);
    assert.equal(agentName(undefined), "An AI assistant");
    assert.equal(agentName("\u0000\u0007"), "An AI assistant");
  });
});

describe("reading the keys file", () => {
  test("an edit in the same clock tick is still seen (the size changed)", () => {
    const file = path.join(tempDir("periskopos-keys-"), ".env.local");
    process.env.PERISKOPOS_ENV_FILE = file;
    try {
      writeFileSync(file, "PERISKOPOS_A=1\n");
      const t = new Date("2026-01-01T00:00:00Z");
      utimesSync(file, t, t);
      assert.equal(readSecret("PERISKOPOS_A"), "1");
      writeFileSync(file, "PERISKOPOS_B=a-longer-value\n");
      utimesSync(file, t, t); // same time, as if written in the same tick
      assert.equal(readSecret("PERISKOPOS_B"), "a-longer-value");
      assert.equal(readSecret("PERISKOPOS_A"), undefined);
    } finally {
      delete process.env.PERISKOPOS_ENV_FILE;
    }
  });
});
