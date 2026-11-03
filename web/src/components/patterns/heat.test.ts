import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SquareCount, Summary } from "@/lib/api";
import { displayOrder, dominantKind, edgeLabels, heatSquares, intensity, mirrorRank, nameOf, squareLabel } from "./heat";

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

describe("dominantKind", () => {
  test("the most common kind", () => {
    assert.equal(dominantKind({ inaccuracy: 4, mistake: 1, blunder: 2 }), "inaccuracy");
    assert.equal(dominantKind({ inaccuracy: 0, mistake: 3, blunder: 2 }), "mistake");
  });
  test("a tie goes to the more severe kind", () => {
    assert.equal(dominantKind({ inaccuracy: 2, mistake: 2, blunder: 2 }), "blunder");
    assert.equal(dominantKind({ inaccuracy: 1, mistake: 1, blunder: 0 }), "mistake");
  });
  test("no errors: none", () => {
    assert.equal(dominantKind({ inaccuracy: 0, mistake: 0, blunder: 0 }), null);
  });
});

describe("intensity", () => {
  test("0 when empty; 0.15 to 0.9 on a square-root scale otherwise", () => {
    assert.equal(intensity(0, 10), 0);
    assert.equal(intensity(10, 10), 0.9);
    assert.equal(intensity(1, 0), 0, "an all-empty board has max 0");
    assert.ok(Math.abs(intensity(1, 4) - (0.15 + 0.75 * 0.5)) < 1e-9);
    assert.ok(intensity(1, 30) > 0.25, "one error next to thirty is still visible");
  });
});
