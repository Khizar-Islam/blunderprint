import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { niceMax, ticks } from "./scale";

describe("niceMax", () => {
  test("the smallest 1, 2, 2.5 or 5 × 10^k at or above the value", () => {
    assert.equal(niceMax(3.7), 5);
    assert.equal(niceMax(5), 5);
    assert.equal(niceMax(5.01), 10);
    assert.equal(niceMax(2.2), 2.5);
    assert.equal(niceMax(0.27), 0.5);
    assert.equal(niceMax(0.3), 0.5);
    assert.equal(niceMax(17), 20);
    assert.equal(niceMax(1), 1);
  });
  test("no data still gives a usable axis", () => {
    assert.equal(niceMax(0), 1);
    assert.equal(niceMax(-2), 1);
    assert.equal(niceMax(Number.NaN), 1);
  });
});

describe("ticks", () => {
  test("evenly spaced from 0 to max, without float noise", () => {
    assert.deepEqual(ticks(5), [0, 1.25, 2.5, 3.75, 5]);
    assert.deepEqual(ticks(0.3, 3), [0, 0.1, 0.2, 0.3]);
  });
});
