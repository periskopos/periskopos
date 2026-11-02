import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// The key the keys file is encrypted with (server/keys/sealed-keys.ts): 32 random
// bytes, kept beside the file but locked by the system's store for secrets
// (Electron's safeStorage: DPAPI on Windows, the Keychain on macOS, the
// desktop's keyring on Linux). Only this user, on this computer, can unlock
// it, so a copy of the folder shows no keys.

export type SecretStore = {
  isEncryptionAvailable(): boolean;
  encryptString(text: string): Buffer;
  decryptString(data: Buffer): string;
  // Linux only: "basic_text" means no keyring, so nothing would be locked.
  getSelectedStorageBackend?(): string;
};

export const keysKeyFile = (envFile: string) => path.join(path.dirname(envFile), "keys.key");

// The key as hex, made the first time. Undefined, and the keys file stays as
// it is, when the system has no store for secrets or the saved key won't
// unlock (another user's or computer's): then a new key would only lock the
// keys away for good.
export function keysKey(envFile: string, store: SecretStore, log: (line: string) => void): string | undefined {
  if (!store.isEncryptionAvailable() || store.getSelectedStorageBackend?.() === "basic_text") {
    log("keys: this system has no store for secrets, so the keys file stays plain text");
    return undefined;
  }
  const file = keysKeyFile(envFile);
  if (existsSync(file)) {
    try {
      const hex = store.decryptString(readFileSync(file));
      if (/^[0-9a-f]{64}$/.test(hex)) return hex;
      log(`keys: ${file} doesn't hold a key`);
    } catch (err) {
      log(`keys: couldn't unlock ${file}: ${(err as Error).message}`);
    }
    return undefined;
  }
  const hex = randomBytes(32).toString("hex");
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, store.encryptString(hex), { mode: 0o600 });
  renameSync(temp, file);
  log(`keys: made the key that encrypts the keys file, ${file}`);
  return hex;
}
