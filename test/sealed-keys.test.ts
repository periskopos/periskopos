import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { keysKey, keysKeyFile } from "../desktop/keys-key.ts";
import type { SecretStore } from "../desktop/keys-key.ts";
import { isSealed, merge, parseKeysKey, seal, SealedKeysError, unseal } from "../server/keys/sealed-keys.ts";
import { readSecret, removeSecret, useKeysKey, writeSecret } from "../server/keys/secrets.ts";
import { tempDir } from "./tmp.ts";

// The installed app's keys file is encrypted with a key only this user, on
// this computer, can unlock: a copy of the file alone shows no keys.

const KEY = randomBytes(32);

describe("sealing the keys file", () => {
  test("sealed text opens with its key, and shows none of the keys", () => {
    const text = "RENDER_API_KEY=rnd_secret\nGITHUB_TOKEN=ghp_secret\n";
    const sealed = seal(text, KEY);
    assert.ok(isSealed(sealed));
    assert.ok(!sealed.includes("secret"));
    assert.deepEqual(unseal(sealed, KEY), { text, added: [] });
  });

  test("a different key, or none, can't open it", () => {
    const sealed = seal("A=1\n", KEY);
    assert.throws(() => unseal(sealed, randomBytes(32)), SealedKeysError);
    assert.throws(() => unseal(sealed, undefined), SealedKeysError);
  });

  test("a changed byte is found out", () => {
    const [head, blob] = seal("A=1\n", KEY).split("\n");
    const bytes = Buffer.from(blob!, "base64");
    bytes[bytes.length - 1]! ^= 1;
    assert.throws(() => unseal(`${head}\n${bytes.toString("base64")}\n`, KEY), SealedKeysError);
  });

  test("a plain file is read as it is", () => {
    assert.deepEqual(unseal("A=1\n", undefined), { text: "A=1\n", added: [] });
  });

  test("lines added by hand under it replace the same name or go at the end", () => {
    const { text, added } = unseal(`${seal("# mine\nA=1\nB=2\n", KEY)}B=3\nC=4\n\n`, KEY);
    assert.deepEqual(added, ["B=3", "C=4"]);
    assert.equal(merge(text, added), "# mine\nA=1\nB=3\nC=4\n");
  });

  test("the app's key arrives as 64 hex digits, or not at all", () => {
    assert.deepEqual(parseKeysKey(KEY.toString("hex")), KEY);
    assert.equal(parseKeysKey(""), undefined);
    assert.equal(parseKeysKey(undefined), undefined);
    assert.equal(parseKeysKey("abc"), undefined);
  });
});

describe("the keys file, with the app's key", () => {
  let file: string;
  beforeEach(() => {
    file = path.join(tempDir("periskopos-sealed-"), ".env.local");
    process.env.PERISKOPOS_ENV_FILE = file;
    useKeysKey(KEY);
  });
  afterEach(() => {
    useKeysKey(undefined);
    delete process.env.PERISKOPOS_ENV_FILE;
  });

  test("a key saved is written encrypted, and read back", () => {
    writeSecret("PERISKOPOS_TEST_SEALED", "s3cret-value");
    const raw = readFileSync(file, "utf8");
    assert.ok(isSealed(raw));
    assert.ok(!raw.includes("s3cret-value"));
    assert.equal(readSecret("PERISKOPOS_TEST_SEALED"), "s3cret-value");
    removeSecret("PERISKOPOS_TEST_SEALED");
    assert.equal(readSecret("PERISKOPOS_TEST_SEALED"), undefined);
    assert.ok(isSealed(readFileSync(file, "utf8")), "still encrypted once empty");
  });

  test("a plain file (an older version's) is encrypted the first time it's read", () => {
    writeFileSync(file, "# my keys\nRENDER_API_KEY=rnd_plain\n");
    assert.equal(readSecret("RENDER_API_KEY"), "rnd_plain");
    const raw = readFileSync(file, "utf8");
    assert.ok(isSealed(raw) && !raw.includes("rnd_plain"));
    assert.equal(unseal(raw, KEY).text, "# my keys\nRENDER_API_KEY=rnd_plain\n", "comments kept");
  });

  test("a line added by hand is read and encrypted with the rest", () => {
    writeSecret("A_KEY", "one");
    writeFileSync(file, `${readFileSync(file, "utf8")}B_KEY=two\n`);
    assert.equal(readSecret("B_KEY"), "two");
    assert.equal(readSecret("A_KEY"), "one");
    const raw = readFileSync(file, "utf8");
    assert.ok(!raw.includes("two"));
    assert.deepEqual(unseal(raw, KEY).added, []);
  });

  test("a file sealed with another key is never written over", () => {
    const other = seal("A_KEY=theirs\n", randomBytes(32));
    writeFileSync(file, other);
    assert.equal(readSecret("A_KEY"), undefined);
    assert.throws(() => writeSecret("B_KEY", "mine"), SealedKeysError);
    assert.throws(() => removeSecret("A_KEY"), SealedKeysError);
    assert.equal(readFileSync(file, "utf8"), other);
  });
});

describe("the key, kept in the system's store for secrets", () => {
  // Stands in for safeStorage: "locks" by reversing, and can fail to unlock.
  const store = (over: Partial<SecretStore> = {}): SecretStore => ({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from([...text].reverse().join("")),
    decryptString: (data) => [...data.toString()].reverse().join(""),
    ...over,
  });
  const quiet = () => {};

  test("made once, locked, and the same one after", () => {
    const env = path.join(tempDir("periskopos-keykey-"), ".env.local");
    const first = keysKey(env, store(), quiet);
    assert.match(first ?? "", /^[0-9a-f]{64}$/);
    assert.notEqual(readFileSync(keysKeyFile(env), "utf8"), first, "never saved as it is");
    assert.equal(keysKey(env, store(), quiet), first);
  });

  test("no store for secrets (Linux without a keyring): no key, nothing written", () => {
    const env = path.join(tempDir("periskopos-keykey-"), ".env.local");
    assert.equal(keysKey(env, store({ getSelectedStorageBackend: () => "basic_text" }), quiet), undefined);
    assert.equal(keysKey(env, store({ isEncryptionAvailable: () => false }), quiet), undefined);
    assert.equal(existsSync(keysKeyFile(env)), false);
  });

  test("a saved key that won't unlock is left, not replaced", () => {
    const env = path.join(tempDir("periskopos-keykey-"), ".env.local");
    keysKey(env, store(), quiet);
    const saved = readFileSync(keysKeyFile(env));
    const failing = store({
      decryptString: () => {
        throw new Error("another user's");
      },
    });
    assert.equal(keysKey(env, failing, quiet), undefined);
    assert.deepEqual(readFileSync(keysKeyFile(env)), saved);
  });
});
