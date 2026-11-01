import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEval, whiteWinPercent, winningChances, winPercentSeries } from "./winPercent";

// The same cases as backend/src/chess/classify.test.ts, so this copy matches the server's.
test("winningChances: Lichess's curve, symmetric, 0 at equality", () => {
  assert.equal(winningChances(0), 0);
  assert.ok(Math.abs(winningChances(300) + winningChances(-300)) < 1e-12);
  assert.ok(Math.abs(winningChances(100) - 0.18203) < 1e-4);
  assert.ok(winningChances(5000) < 1 && winningChances(5000) > 0.99);
});

test("whiteWinPercent: capped at ±1000 cp, mates count as ±1000, mate 0 = side to move lost", () => {
  assert.equal(whiteWinPercent({ cp: 0 }, 1), 50);
  assert.equal(whiteWinPercent({ cp: 5000 }, 1), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: 3 }, 1), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: -3 }, 1), whiteWinPercent({ cp: -1000 }, 1));
  assert.equal(whiteWinPercent({ mate: 0 }, 5), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: 0 }, 6), whiteWinPercent({ cp: -1000 }, 1));
});

test("winPercentSeries: the start position (+15 cp) first, then one point per ply", () => {
  const s = winPercentSeries([{ cp: 0 }, { mate: 0 }]);
  assert.equal(s.length, 3);
  assert.ok(s[0]! > 50 && s[0]! < 52); // +15 cp is a shade better for White
  assert.equal(s[1], 50);
  assert.equal(s[2], whiteWinPercent({ cp: -1000 }, 0)); // after 2 plies White is to move and mated
});

test("formatEval: pawns with a sign, mates with #", () => {
  assert.equal(formatEval({ cp: 123 }), "+1.2");
  assert.equal(formatEval({ cp: -40 }), "−0.4");
  assert.equal(formatEval({ cp: 0 }), "0.0");
  assert.equal(formatEval({ mate: 3 }), "#3");
  assert.equal(formatEval({ mate: -2 }), "#-2");
  assert.equal(formatEval({ mate: 0 }), "mate");
  assert.equal(formatEval(undefined), "");
});
