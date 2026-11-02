import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import { ACCOUNTS } from "../../shared/catalog.ts";
import type { Service } from "../../shared/types.ts";
import { ROOT, userAppDir } from "../config.ts";
import type { ServiceAuth } from "../integrations/types.ts";
import { isSealed, merge, seal, unseal } from "./sealed-keys.ts";

// Keys live only in .env.local (NFR-SEC3): read here, by the server, and
// never written to the database, sent to the browser, or logged. The file
// is re-read when it changes, so adding a key needs no restart. It sits in
// my per-user Periskopos folder, not in the project (AGENT-SAFETY §4.3).

const run = promisify(execFile);
// Resolved on each use, so a different file can be pointed at (tests).
export const envFile = () => process.env.PERISKOPOS_ENV_FILE ?? path.join(userAppDir(), ".env.local");

// Where the keys used to be, in the project folder.
export const LEGACY_ENV_FILE = path.join(ROOT, ".env.local");

// Once, on start: a .env.local still in the project folder is moved (not
// copied) to where the keys now live. Returns what to tell me, if anything.
export function moveLegacyEnvFile(from = LEGACY_ENV_FILE, to = envFile()): string | undefined {
  if (path.resolve(from) === path.resolve(to) || !existsSync(from)) return undefined;
  if (existsSync(to)) {
    return `There's still a .env.local in ${path.dirname(from)}, but Periskopos reads its keys from ${to}. Copy anything you need across, then delete the old file so agents working in the project can't read it.`;
  }
  mkdirSync(path.dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch {
    copyFileSync(from, to); // another drive
    unlinkSync(from);
  }
  return `Moved your keys from ${from} to ${to}, out of the project folder.`;
}

// The key the file is encrypted with, from the desktop app (sealed-keys.ts);
// without one it stays plain text.
let keysKey: Buffer | undefined;
export function useKeysKey(key: Buffer | undefined) {
  keysKey = key;
  cache = undefined;
}

// The file's keys as plain text. With a key, a plain file (an older version's,
// or one written by hand) and lines added by hand under a sealed one are
// encrypted there and then. Throws when the file is sealed and can't be
// opened: never read as empty, so nothing writes over the keys in it.
function keysText(file: string): string {
  const raw = readFileSync(file, "utf8");
  const { text, added } = unseal(raw, keysKey);
  const plain = merge(text, added);
  if (keysKey && raw.trim() && (!isSealed(raw) || added.length)) writeKeys(file, plain);
  return plain;
}

// Said once for each version of a file that can't be read.
let saidWhy = "";

// Re-read when the file's time or size changes: two edits within the same
// clock tick (fast machines, scripts) keep the time but rarely the size.
let cache: { file: string; mtimeMs: number; size: number; values: Record<string, string> } | undefined;

function fileValues(): Record<string, string> {
  const file = envFile();
  try {
    const { mtimeMs, size } = statSync(file);
    if (cache?.mtimeMs !== mtimeMs || cache.size !== size || cache.file !== file) {
      const values = parseEnv(keysText(file)) as Record<string, string>;
      // Folding lines in rewrote the file: remember the new one.
      const now = statSync(file);
      cache = { file, mtimeMs: now.mtimeMs, size: now.size, values };
    }
    return cache.values;
  } catch (err) {
    cache = undefined;
    const why = (err as NodeJS.ErrnoException).code === "ENOENT" ? "" : `Couldn't read the keys in ${file}: ${(err as Error).message}`;
    if (why && why !== saidWhy) console.error(why);
    saidWhy = why;
    return {};
  }
}

// Sets one variable in .env.local, replacing its line or appending one, and
// leaving every other line (and comment) as it was. Used for the secrets
// Periskopos itself generates.
export function writeSecret(name: string, value: string) {
  if (!SECRET_NAME.test(name)) throw new Error(`"${name}" isn't a valid variable name`);
  if (/[\r\n]/.test(value)) throw new Error("A secret can't contain a line break");
  const file = envFile();
  let lines: string[] = [];
  if (existsSync(file)) {
    lines = keysText(file).split(/\r?\n/);
    if (lines.at(-1) === "") lines.pop();
  }
  const line = `${name}=${value}`;
  const at = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (at >= 0) lines[at] = line;
  else lines.push(line);
  // The per-user folder may not exist yet (a fresh install, before anything
  // else has written there).
  mkdirSync(path.dirname(file), { recursive: true });
  writeKeys(file, lines.join("\n") + "\n");
  cache = undefined; // the next read must see it, whatever the clock says
}

// The keys file is replaced whole, never written over in place: a crash or
// power cut halfway leaves the old file or the new one, never half of one.
function writeKeys(file: string, text: string) {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, keysKey ? seal(text, keysKey) : text, { mode: 0o600 });
    renameSync(temp, file);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // never written
    }
    throw err;
  }
}

// Takes one variable out of .env.local (an app or account that used it was
// deleted), leaving every other line as it was.
export function removeSecret(name: string) {
  if (!SECRET_NAME.test(name)) return;
  const file = envFile();
  if (!existsSync(file)) return; // nothing to take out
  const text = keysText(file);
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const kept = lines.filter((l) => !l.startsWith(`${name}=`));
  if (kept.length === lines.length) return;
  writeKeys(file, kept.length ? kept.join("\n") + "\n" : "");
  cache = undefined;
}

// The keys file, or else the environment, but only for names of our own
// (PERISKOPOS_…): a GITHUB_TOKEN that happens to be set in the shell is
// never used without being pasted.
export function readSecret(name: string): string | undefined {
  const value = fileValues()[name] ?? (name.startsWith("PERISKOPOS_") ? process.env[name] : undefined);
  return value?.trim() || undefined;
}

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;

// The variable a pasted key is saved under: the account's own name for it
// (shared/catalog.ts), or one no other service uses yet. A second Render
// account gets RENDER_API_KEY_2, so pasting its key never replaces the
// first one's.
export function freeKeyName(type: Service["type"], taken: (string | undefined)[]): string {
  const base = ACCOUNTS[type].keyName;
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

// A key pasted on screen: one line of printable text, nothing else.
export function pastedKey(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Paste the key first");
  const key = value.trim();
  if (key.length > 1000) throw new Error("That's too long to be a key: check what was copied");
  if (/\s/.test(key)) throw new Error("A key has no spaces or line breaks: check what was copied");
  return key;
}

// GitHub without a key uses the `gh` login already on this machine.
let ghToken: { value: string; until: number } | undefined;
async function ghAuthToken(): Promise<string> {
  if (ghToken && ghToken.until > Date.now()) return ghToken.value;
  try {
    const { stdout } = await run("gh", ["auth", "token"], { timeout: 10_000, windowsHide: true });
    ghToken = { value: stdout.trim(), until: Date.now() + 10 * 60_000 };
    return ghToken.value;
  } catch {
    throw new Error("GitHub CLI isn't logged in. Run: gh auth login");
  }
}

export function keyState(service: Service): "set" | "missing" | "gh" {
  if (!service.secretRef) return "gh";
  return readSecret(service.secretRef) ? "set" : "missing";
}

export const authFor = (service: Service): ServiceAuth => ({ service, token: () => serviceToken(service) });

export async function serviceToken(service: Service): Promise<string> {
  if (!service.secretRef) {
    if (service.type === "github") return ghAuthToken();
    throw new Error(`${service.name} has no key configured`);
  }
  const value = readSecret(service.secretRef);
  if (!value) throw new Error(`Add ${service.secretRef}=… to ${envFile()}`);
  return value;
}
