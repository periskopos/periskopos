import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { NO_TIME, ago, clock, exactTime, range } from "../web/src/format.ts";

// Some times on screen come from outside (an app reports its own clock), so a
// time that can't be read must show as a dash, never throw and stop the page.
describe("the web page's time formatting", () => {
  test("an unreadable time shows as a dash", () => {
    for (const bad of ["", "not a date", "2026-13-45T99:99:99Z"]) {
      assert.equal(ago(bad), NO_TIME);
      assert.equal(exactTime(bad), NO_TIME);
      assert.equal(clock(bad), NO_TIME);
      assert.equal(range(bad), `${NO_TIME} – now`);
    }
    assert.match(range("2026-10-06T23:10:00Z", "garbage"), new RegExp(`– ${NO_TIME}$`));
  });

  test("a readable time still formats", () => {
    const now = Date.parse("2026-10-17T12:00:00Z");
    assert.equal(ago("2026-10-17T11:59:50Z", now), "just now");
    assert.equal(ago("2026-10-17T11:50:00Z", now), "10 min ago");
    assert.equal(ago("2026-10-17T09:00:00Z", now), "3 h ago");
    assert.equal(ago("2026-10-15T12:00:00Z", now), "2 d ago");
    // The locale decides the layout, so these look for the parts that must
    // be there: the minutes, and for the exact time the year too.
    assert.match(exactTime("2026-10-17T11:50:00Z"), /2026/);
    assert.match(exactTime("2026-10-17T11:50:00Z"), /50/);
    assert.match(clock("2026-10-17T11:50:00Z"), /50/);
    assert.doesNotMatch(clock("2026-10-17T11:50:00Z"), /2026/, "a clock is the time alone");
  });

  test("a range names the day once when it ends the same day, again when it doesn't", () => {
    const from = "2026-10-06T12:10:00";
    const sameDay = range(from, "2026-10-06T13:45:00");
    const nextDay = range(from, "2026-10-08T13:45:00");
    assert.equal(sameDay, `${range(from).replace(/ – now$/, "")} – ${clock("2026-10-06T13:45:00")}`);
    assert.notEqual(nextDay.split(" – ")[1], clock("2026-10-08T13:45:00"), "another day says which");
    assert.match(range(from), / – now$/);
  });
});
