import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Loaded before every test file (npm test: node --import). The per-user
// folder, where the keys file lives (server/config.ts userAppDir), points
// at a throwaway one, so a test that deletes an app or an account never
// reads or edits my real keys, even one that clears PERISKOPOS_ENV_FILE
// after setting its own.
const dir = mkdtempSync(path.join(os.tmpdir(), "periskopos-test-home-"));
process.env.APPDATA = dir;
process.env.XDG_CONFIG_HOME = dir;
if (process.platform === "darwin") process.env.HOME = dir;
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
