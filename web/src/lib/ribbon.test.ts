import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { classifiedRibbon, progressRibbon } from "./ribbon";

describe("classifiedRibbon", () => {
  const LIGHT = "var(--color-square-light)"; // opponent's moves
  const DARK = "var(--color-square-dark)"; // player's good/best moves

  test("as White: odd plies (index 0, 2, …) are the player's and keep their colour", () => {
    assert.equal(
      classifiedRibbon(["good", "blunder", "blunder", "good"], "white"),
      `linear-gradient(to right, ${DARK} 0% 25%, ${LIGHT} 25% 50%, var(--color-blunder) 50% 75%, ${LIGHT} 75% 100%)`,
    );
  });

  test("as Black: the opponent's blunder is a neutral tick, the player's mistake is coloured", () => {
    assert.equal(
      classifiedRibbon(["blunder", "mistake", "good", "best"], "black"),
      `linear-gradient(to right, ${LIGHT} 0% 25%, var(--color-mistake) 25% 50%, ${LIGHT} 50% 75%, ${DARK} 75% 100%)`,
    );
  });

  test("odd counts round to 2 decimals", () => {
    assert.match(classifiedRibbon(["mistake", "good", "good"], "white"), /var\(--color-mistake\) 0% 33.33%/);
  });

  test("no moves → no background", () => {
    assert.equal(classifiedRibbon([], "white"), "none");
  });
});

describe("progressRibbon", () => {
  test("fills the evaluated part", () => {
    assert.equal(
      progressRibbon(1, 4),
      "linear-gradient(to right, var(--color-square-dark) 0% 25%, transparent 25% 100%)",
    );
  });

  test("clamps out-of-range progress", () => {
    assert.equal(progressRibbon(9, 2), "linear-gradient(to right, var(--color-square-dark) 0% 100%)");
    assert.equal(progressRibbon(-1, 2), "linear-gradient(to right, transparent 0% 100%)");
    assert.equal(progressRibbon(0, 0), "none");
  });
});
