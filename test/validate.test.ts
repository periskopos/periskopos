import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { HttpError } from "../server/errors.ts";
import { httpUrl, requiredText, text } from "../server/validate.ts";

// What every form and route checks before storing anything: text that's
// there and not too long, and URLs that can only be http(s) with no
// password in them. A refusal is a 400 whose message names the field.

function refuses(fn: () => unknown, message: RegExp) {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HttpError, "a refusal the user can read");
    assert.equal(err.status, 400);
    assert.match(err.message, message);
    return true;
  });
}

describe("text", () => {
  test("is trimmed", () => {
    assert.equal(text("  Star-Map \n", "Name"), "Star-Map");
  });

  test("is required unless it's optional", () => {
    for (const empty of [undefined, null, "", "   "]) {
      refuses(() => text(empty, "Name"), /^Name is required$/);
      assert.equal(text(empty, "Name", { optional: true }), undefined);
    }
  });

  test("must be text", () => {
    for (const value of [42, true, {}, ["a"]]) refuses(() => text(value, "Name"), /^Name must be text$/);
  });

  test("is at most 200 characters, or the limit given, after trimming", () => {
    assert.equal(text("a".repeat(200), "Name"), "a".repeat(200));
    assert.equal(text(` ${"a".repeat(200)} `, "Name"), "a".repeat(200));
    refuses(() => text("a".repeat(201), "Name"), /^Name is longer than 200 characters$/);
    assert.equal(text("abc", "Code", { max: 3 }), "abc");
    refuses(() => text("abcd", "Code", { max: 3 }), /^Code is longer than 3 characters$/);
  });

  test("requiredText never comes back empty", () => {
    assert.equal(requiredText(" x ", "Name"), "x");
    refuses(() => requiredText("  ", "Name"), /^Name is required$/);
    refuses(() => requiredText("abcd", "Code", 3), /longer than 3/);
  });
});

describe("httpUrl", () => {
  test("takes a full http or https URL, trimmed and normalized", () => {
    assert.equal(httpUrl(" https://example.com ", "URL"), "https://example.com/");
    assert.equal(httpUrl("http://localhost:8080/health?x=1", "URL"), "http://localhost:8080/health?x=1");
    assert.equal(httpUrl("HTTPS://Example.COM/Path", "URL"), "https://example.com/Path");
  });

  test("refuses anything that isn't a full URL", () => {
    refuses(() => httpUrl("example.com", "Site URL"), /^Site URL must be a full URL, like https:\/\/example\.com$/);
    refuses(() => httpUrl("/health", "Site URL"), /must be a full URL/);
    refuses(() => httpUrl("", "Site URL"), /^Site URL is required$/);
  });

  test("refuses other schemes, which would end up in links and fetch()", () => {
    for (const url of ["javascript:alert(1)", "file:///C:/Windows/win.ini", "ftp://example.com", "data:text/html,hi"]) {
      refuses(() => httpUrl(url, "URL"), /^URL must start with http:\/\/ or https:\/\/$/);
    }
  });

  test("refuses a URL with a user name or password in it", () => {
    refuses(() => httpUrl("https://me:secret@example.com", "URL"), /^URL must not contain a password$/);
    refuses(() => httpUrl("https://me@example.com", "URL"), /must not contain a password/);
  });

  test("is at most 2000 characters", () => {
    const base = "https://example.com/";
    assert.ok(httpUrl(base + "a".repeat(2000 - base.length), "URL"));
    refuses(() => httpUrl(base + "a".repeat(2001 - base.length), "URL"), /longer than 2000/);
  });
});
