import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// The keys file, encrypted. The installed app keeps a random key in the
// system's own store for secrets (Windows ties it to the signed-in user,
// macOS keeps it in the Keychain: desktop/keys-key.ts) and hands it to the
// server on stdin, so a copy of .env.local alone (a backup, a synced folder,
// another program reading files) shows no keys. Started any other way (`npm
// start`, the tests) there is no key, and the file stays plain text.
//
// The file is a first line saying what it is, then the keys sealed with
// AES-256-GCM: base64 of the nonce, the tag and the ciphertext. Lines after
// that are plain KEY=value lines added by hand; the next read folds them in
// and seals the file again.

export const SEALED_HEADER = "# Periskopos keys, encrypted. Add KEY=value lines below this one; Periskopos encrypts them too.";
const NONCE = 12;
const TAG = 16;

export const isSealed = (text: string) => text.startsWith(SEALED_HEADER);

export function seal(text: string, key: Buffer): string {
  const nonce = randomBytes(NONCE);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${SEALED_HEADER}\n${Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64")}\n`;
}

export class SealedKeysError extends Error {}

// The plain text a sealed file holds, with any lines added by hand after it
// (`added`), or the file as it is when it isn't sealed.
export function unseal(text: string, key: Buffer | undefined): { text: string; added: string[] } {
  if (!isSealed(text)) return { text, added: [] };
  if (!key) throw new SealedKeysError("The keys file is encrypted, and only the installed Periskopos app can read it: point PERISKOPOS_ENV_FILE at a file of this checkout's own");
  const [, blob = "", ...rest] = text.split(/\r?\n/);
  const raw = Buffer.from(blob.trim(), "base64");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, NONCE));
    decipher.setAuthTag(raw.subarray(NONCE, NONCE + TAG));
    const plain = Buffer.concat([decipher.update(raw.subarray(NONCE + TAG)), decipher.final()]).toString("utf8");
    return { text: plain, added: rest.filter((line) => line.trim()) };
  } catch {
    throw new SealedKeysError("The keys file is encrypted with a key this app doesn't have (it was made for another Windows user or computer, or changed by hand)");
  }
}

// The plain text, with lines added by hand put in: each replaces a line for
// the same name, or goes at the end.
export function merge(text: string, added: string[]): string {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  for (const line of added) {
    const name = line.split("=")[0]!.trim();
    const at = name && !line.trimStart().startsWith("#") ? lines.findIndex((l) => l.startsWith(`${name}=`)) : -1;
    if (at >= 0) lines[at] = line;
    else lines.push(line);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

// The key the app hands the server, read once from stdin after the session
// key: 32 bytes as hex, or nothing.
export function parseKeysKey(hex: string | undefined): Buffer | undefined {
  const value = hex?.trim() ?? "";
  return /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, "hex") : undefined;
}
