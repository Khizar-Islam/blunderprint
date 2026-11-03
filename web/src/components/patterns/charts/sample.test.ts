import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fewGames, MIN_GAMES } from "./sample";

describe("fewGames", () => {
  test("under 5 games is too few to read anything into", () => {
    assert.equal(MIN_GAMES, 5);
    for (const n of [0, 1, 4]) assert.equal(fewGames(n), true, String(n));
    for (const n of [5, 6, 200]) assert.equal(fewGames(n), false, String(n));
  });
});
