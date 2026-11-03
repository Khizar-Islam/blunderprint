import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SquareCount, Summary } from "@/lib/api";
import { displayOrder, edgeLabels, heatOpacity, heatSquares, HEAT_MAX_OPACITY, mirrorRank, nameOf, severity, squareLabel } from "./heat";

const FILES = "abcdefgh";
const empty = (): SquareCount[] =>
  Array.from({ length: 64 }, (_, i) => ({ square: `${FILES[i % 8]}${Math.floor(i / 8) + 1}`, inaccuracy: 0, mistake: 0, blunder: 0, total: 0 }));
const idx = (sq: string) => FILES.indexOf(sq[0]!) + 8 * (Number(sq[1]) - 1);
function board(counts: Record<string, Partial<SquareCount>>): SquareCount[] {
  const b = empty();
  for (const [sq, c] of Object.entries(counts)) {
    const cell = { ...b[idx(sq)]!, ...c };
    cell.total = cell.inaccuracy + cell.mistake + cell.blunder;
    b[idx(sq)] = cell;
  }
  return b;
}

describe("mirrorRank and nameOf", () => {
  test("same file, opposite rank", () => {
    assert.equal(nameOf(mirrorRank(idx("e7"))), "e2");
    assert.equal(nameOf(mirrorRank(idx("a1"))), "a8");
    assert.equal(nameOf(mirrorRank(idx("h4"))), "h5");
  });
});

describe("heatSquares", () => {
  const squares: Summary["squares"] = {
    white: board({ e4: { mistake: 1 }, f7: { blunder: 2 } }),
    black: board({ e7: { blunder: 1 }, e4: { inaccuracy: 3 }, a1: { mistake: 1 } }),
  };
  test("white and black views are the real squares of that colour's games", () => {
    assert.equal(heatSquares(squares, "white")[idx("e4")]!.total, 1);
    assert.equal(heatSquares(squares, "black")[idx("e7")]!.blunder, 1);
    assert.equal(heatSquares(squares, "black")[idx("e2")]!.total, 0);
  });
  test("both: Black's ranks are mirrored onto the player's side, then added to White's", () => {
    const both = heatSquares(squares, "both");
    assert.deepEqual(both[idx("e2")], { square: "e2", inaccuracy: 0, mistake: 0, blunder: 1, total: 1 }, "Black's e7 is their e2");
    assert.deepEqual(both[idx("e5")], { square: "e5", inaccuracy: 3, mistake: 0, blunder: 0, total: 3 }, "Black's e4 is their e5");
    assert.equal(both[idx("e4")]!.total, 1, "only White's e4 lands on e4");
    assert.equal(both[idx("a8")]!.mistake, 1, "Black's a1 is the far rank from Black's side");
    assert.equal(both[idx("f7")]!.blunder, 2);
    const sum = (b: SquareCount[]) => b.reduce((n, s) => n + s.total, 0);
    assert.equal(sum(both), sum(squares.white) + sum(squares.black), "nothing lost or doubled");
  });
});

describe("displayOrder and edgeLabels", () => {
  test("white and both: a8 top left, h1 bottom right", () => {
    for (const mode of ["white", "both"] as const) {
      const order = displayOrder(mode);
      assert.equal(nameOf(order[0]!), "a8");
      assert.equal(nameOf(order[7]!), "h8");
      assert.equal(nameOf(order[56]!), "a1");
      assert.equal(nameOf(order[63]!), "h1");
      assert.deepEqual(edgeLabels(mode), { ranks: ["8", "7", "6", "5", "4", "3", "2", "1"], files: [..."abcdefgh"] });
    }
  });
  test("black: the board is flipped, h1 top left, a8 bottom right", () => {
    const order = displayOrder("black");
    assert.equal(nameOf(order[0]!), "h1");
    assert.equal(nameOf(order[56]!), "h8");
    assert.equal(nameOf(order[63]!), "a8");
    assert.deepEqual(edgeLabels("black"), { ranks: ["1", "2", "3", "4", "5", "6", "7", "8"], files: [..."hgfedcba"] });
  });
  test("every square once", () => {
    for (const mode of ["white", "black", "both"] as const) assert.equal(new Set(displayOrder(mode)).size, 64);
  });
  test("labels read as relative only in the both view", () => {
    assert.equal(squareLabel(idx("e2"), "both"), "e2 from your side");
    assert.equal(squareLabel(idx("e2"), "black"), "e2");
  });
});

describe("severity", () => {
  test("a blunder counts 3, a mistake 2, an inaccuracy 1", () => {
    assert.equal(severity({ inaccuracy: 0, mistake: 0, blunder: 0 }), 0);
    assert.equal(severity({ inaccuracy: 1, mistake: 0, blunder: 0 }), 1);
    assert.equal(severity({ inaccuracy: 4, mistake: 2, blunder: 3 }), 4 + 4 + 9);
  });
  test("three blunders outweigh eight inaccuracies (the quilt problem)", () => {
    assert.ok(severity({ inaccuracy: 0, mistake: 0, blunder: 3 }) > severity({ inaccuracy: 8, mistake: 0, blunder: 0 }));
  });
});

describe("heatOpacity", () => {
  test("a straight line from 0: no floor, so quiet squares stay plain", () => {
    assert.equal(heatOpacity(0, 30), 0);
    assert.equal(heatOpacity(30, 30), HEAT_MAX_OPACITY);
    assert.ok(Math.abs(heatOpacity(15, 30) - HEAT_MAX_OPACITY / 2) < 1e-9);
    assert.ok(heatOpacity(1, 30) < 0.05, "one inaccuracy next to the hot spot barely tints");
  });
  test("an all-empty board (max 0) and out-of-range scores", () => {
    assert.equal(heatOpacity(1, 0), 0);
    assert.equal(heatOpacity(40, 30), HEAT_MAX_OPACITY, "never past the max");
  });
});
