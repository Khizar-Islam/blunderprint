import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { retryAfterMsOf, runStreamUrl } from "./api";

describe("runStreamUrl", () => {
  test("a report run: no query string", () => {
    assert.match(runStreamUrl("6af545db4bd658825893842f"), /\/api\/runs\/6af545db4bd658825893842f\/stream$/);
    assert.ok(!runStreamUrl("abc", null).includes("?"));
  });
  test("an ask run: the token goes in ?token=, encoded", () => {
    assert.match(runStreamUrl("r1", "3f2b-9c"), /\/api\/runs\/r1\/stream\?token=3f2b-9c$/);
    assert.match(runStreamUrl("r1", "a b&c=d"), /\?token=a%20b%26c%3Dd$/);
  });
});

describe("retryAfterMsOf", () => {
  test("seconds → ms; absent or not a number of seconds → undefined", () => {
    assert.equal(retryAfterMsOf("60"), 60_000);
    assert.equal(retryAfterMsOf(" 5 "), 5_000);
    assert.equal(retryAfterMsOf(null), undefined);
    assert.equal(retryAfterMsOf("Wed, 21 Oct 2026 07:28:00 GMT"), undefined);
    assert.equal(retryAfterMsOf("-3"), undefined);
  });
});
