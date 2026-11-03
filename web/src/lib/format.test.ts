import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { count } from "./format";

describe("count", () => {
  test("singular only for exactly one", () => {
    assert.equal(count(1, "game", "games"), "1 game");
    assert.equal(count(0, "game", "games"), "0 games");
    assert.equal(count(5, "game", "games"), "5 games");
    assert.equal(count(1, "inaccuracy", "inaccuracies"), "1 inaccuracy");
    assert.equal(count(3, "inaccuracy", "inaccuracies"), "3 inaccuracies");
  });
});
