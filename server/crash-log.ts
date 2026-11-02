import { appendFileSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DATA_DIR } from "./config.ts";

// The crash log in the data folder, and the redaction everything in it (and
// in diagnostics) goes through. Kept apart from diagnostics.ts so the
// desktop shell can write to it too without loading the database.

const CRASH_FILE = "crashes.log";

// Addresses, emails, long tokens and the user's own folder, taken out.
export function redact(text: string, home = os.homedir()): string {
  let out = text;
  if (home) out = out.split(home).join("~");
  return out
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)\]]+/gi, "<url>")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "<email>")
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+/g, "C:\\Users\\<you>")
    .replace(/\/(?:home|Users)\/[^/\s]+/g, "/home/<you>")
    .replace(/\b[A-Za-z0-9_\-]{24,}\b/g, "<redacted>")
    .slice(0, 2000);
}

// Periskopos is about to die (the server, or the desktop shell or its
// window): what killed it goes to a file in the data folder first, so the
// next start (and the next diagnostics) can say.
export function recordCrash(err: unknown, dir = DATA_DIR) {
  const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
  try {
    appendFileSync(path.join(dir, CRASH_FILE), `${JSON.stringify({ at: new Date().toISOString(), text: redact(text) })}\n`);
  } catch {
    // nothing more can be done on the way down
  }
}

export function recentCrashes(dir = DATA_DIR, keep = 5): { at: string; text: string }[] {
  try {
    return readFileSync(path.join(dir, CRASH_FILE), "utf8")
      .split("\n")
      .filter(Boolean)
      .slice(-keep)
      .map((l) => JSON.parse(l) as { at: string; text: string });
  } catch {
    return [];
  }
}
