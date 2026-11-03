import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clampPly, parsePlyParam } from "./plyParam";

describe("parsePlyParam", () => {
  test("a whole number", () => {
    assert.equal(parsePlyParam("23"), 23);
    assert.equal(parsePlyParam("0"), 0);
    assert.equal(parsePlyParam(["41", "7"]), 41, "a repeated ?ply takes the first");
  });
  test("anything else is ignored", () => {
    for (const v of [undefined, "", "-3", "2.5", "abc", "1e3", "99999", " 4"]) assert.equal(parsePlyParam(v), null, String(v));
  });
});

describe("clampPly", () => {
  test("clamps to the game", () => {
    assert.equal(clampPly(23, 80), 23);
    assert.equal(clampPly(500, 80), 80);
    assert.equal(clampPly(null, 80), 0);
    assert.equal(clampPly(5, 0), 0, "an unreadable PGN has no plies");
  });
});
