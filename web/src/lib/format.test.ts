import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { count, dayDate, demoLine, formatTimeControl, relativeTime } from "./format";

describe("count", () => {
  test("singular only for exactly one", () => {
    assert.equal(count(1, "game", "games"), "1 game");
    assert.equal(count(0, "game", "games"), "0 games");
    assert.equal(count(5, "game", "games"), "5 games");
    assert.equal(count(1, "inaccuracy", "inaccuracies"), "1 inaccuracy");
    assert.equal(count(3, "inaccuracy", "inaccuracies"), "3 inaccuracies");
  });
});

describe("demoLine", () => {
  test("says when a frozen demo player's games were fetched", () => {
    assert.equal(demoLine("2026-11-06T12:00:00Z"), "Demo player · games as of 6 Nov 2026");
  });
  test("without an import date it is just the label", () => {
    assert.equal(demoLine(undefined), "Demo player");
  });
});

describe("formatTimeControl", () => {
  // Stored as "<initial seconds>+<increment seconds>" by both importers.
  test("minutes + increment, the way players say it", () => {
    assert.equal(formatTimeControl("180+2"), "3+2");
    assert.equal(formatTimeControl("600+0"), "10+0");
    assert.equal(formatTimeControl("60+1"), "1+1");
  });
  test("no increment stored means +0", () => {
    assert.equal(formatTimeControl("300"), "5+0");
  });
  test("half, quarter and three-quarter minutes get their fraction signs; other fractions one decimal", () => {
    assert.equal(formatTimeControl("30+0"), "½+0");
    assert.equal(formatTimeControl("15+1"), "¼+1");
    assert.equal(formatTimeControl("90+0"), "1.5+0");
    assert.equal(formatTimeControl("45+0"), "¾+0");
    assert.equal(formatTimeControl("20+0"), "0.3+0");
  });
  test("daily games (1/<seconds per move>) are shown in days", () => {
    assert.equal(formatTimeControl("1/259200"), "3d");
    assert.equal(formatTimeControl("1/86400"), "1d");
  });
  test("nothing, or something unreadable, is null (the row shows no time control) rather than NaN", () => {
    assert.equal(formatTimeControl(undefined), null);
    assert.equal(formatTimeControl(""), null);
    assert.equal(formatTimeControl("-"), null);
    assert.equal(formatTimeControl("abc+2"), null);
    assert.equal(formatTimeControl("1/x"), null);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-11-18T12:00:00Z");
  const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
  test("under a minute is just now, in either direction", () => {
    assert.equal(relativeTime(ago(0), now), "just now");
    assert.equal(relativeTime(ago(59), now), "just now");
    assert.equal(relativeTime(ago(-30), now), "just now");
  });
  test("the largest unit that fits", () => {
    assert.equal(relativeTime(ago(60), now), "1 minute ago");
    assert.equal(relativeTime(ago(2 * 3600), now), "2 hours ago");
    assert.equal(relativeTime(ago(24 * 3600), now), "yesterday");
    assert.equal(relativeTime(ago(3 * 24 * 3600), now), "3 days ago");
    assert.equal(relativeTime(ago(14 * 24 * 3600), now), "2 weeks ago");
    assert.equal(relativeTime(ago(60 * 24 * 3600), now), "2 months ago");
    assert.equal(relativeTime(ago(800 * 24 * 3600), now), "2 years ago");
  });
  test("a time ahead of the clock (the server's is a little ahead) reads as the future, not as garbage", () => {
    assert.equal(relativeTime(ago(-2 * 3600), now), "in 2 hours");
  });
});

describe("dayDate", () => {
  test("a day in British order, with the year", () => {
    assert.equal(dayDate("2026-11-06T12:00:00Z"), "6 Nov 2026");
  });
});
