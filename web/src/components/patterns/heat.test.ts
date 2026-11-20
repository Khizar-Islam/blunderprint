import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SquareCount, Summary, WorstMove } from "@/lib/api";
import { baseline, cellOf, displayOrder, edgeLabels, heatSquares, MARK_MAX, MARK_MIN, markOf, mirrorRank, nameOf, severity, squareLabel, weightOf } from "./heat";

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

describe("heatSquares: the points lost and the costliest move (summary v3)", () => {
  const worst = (gameId: string, winDrop: number): WorstMove => ({ gameId, ply: 9, kind: "blunder", san: "Nd4", winDrop, fen: "8/8/8/8/8/8/8/8 w - -", playedUci: null, betterUci: null });
  // Summary v3 sends a cost for every square (0 where nothing landed).
  const v3 = (counts: Record<string, Partial<SquareCount>>) => board(counts).map((sq) => ({ cost: 0, ...sq }));
  const squares: Summary["squares"] = {
    white: v3({ e2: { blunder: 1, cost: 30.5, worst: worst("w", 30.5) }, a1: { mistake: 1, cost: 12, worst: worst("w2", 12) } }),
    black: v3({ e7: { blunder: 2, cost: 61.2, worst: worst("b", 40) }, h8: { inaccuracy: 1, cost: 10, worst: worst("b2", 10) } }),
  };
  test("one colour: its own squares, the worst move's side is that colour", () => {
    const black = heatSquares(squares, "black");
    assert.equal(black[idx("e7")]!.cost, 61.2);
    assert.equal(black[idx("e7")]!.worstColor, "black");
    assert.equal(black[idx("a1")]!.worst, undefined);
  });
  test("both: costs add up, and the costlier of the two colours' worst moves is kept, with its side", () => {
    const both = heatSquares(squares, "both");
    const e2 = both[idx("e2")]!; // White's e2 + Black's e7
    assert.equal(e2.cost, 91.7);
    assert.equal(e2.worst!.gameId, "b");
    assert.equal(e2.worstColor, "black");
    assert.equal(both[idx("a1")]!.worst!.gameId, "w2");
    assert.equal(both[idx("a1")]!.worstColor, "white");
    assert.equal(both[idx("h1")]!.worstColor, "black", "Black's h8 is their h1");
    assert.equal(both[idx("d4")]!.cost, 0);
    assert.equal(both[idx("d4")]!.worst, undefined);
  });
  test("an API still on summary v2 (no cost): none is invented, and the weighted count stands in", () => {
    const v2: Summary["squares"] = { white: board({ e4: { blunder: 2 } }), black: board({}) };
    const cell = heatSquares(v2, "both")[idx("e4")]!;
    assert.equal(cell.cost, undefined);
    assert.equal(weightOf(cell), 6);
    assert.equal(weightOf({ ...cell, cost: 41.5 }), 41.5);
  });
});

describe("cellOf: the board square an error belongs to in a view", () => {
  test("its own square, except Black's games in the both view, which are rank-mirrored", () => {
    assert.equal(cellOf("e7", "black", "black"), idx("e7"));
    assert.equal(cellOf("e7", "black", "both"), idx("e2"));
    assert.equal(cellOf("e7", "white", "both"), idx("e7"));
    assert.equal(cellOf("g1", "white", "white"), idx("g1"));
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

describe("baseline and markOf: only the costly squares stand out", () => {
  test("the baseline is the weight 85% of the 64 squares stay under; 0 when most squares are empty", () => {
    assert.equal(baseline(Array.from({ length: 64 }, (_, i) => i)), 54);
    assert.equal(baseline([...new Array(60).fill(0), 5, 9, 20, 40]), 0);
  });
  test("few errors (baseline 0): the mark's AREA is proportional to the cost", () => {
    const full = markOf(40, 40, 0);
    const quarter = markOf(10, 40, 0);
    assert.equal(full.size, MARK_MAX);
    // A quarter of the cost → half the diameter range.
    assert.ok(Math.abs(quarter.size - (MARK_MIN + (MARK_MAX - MARK_MIN) / 2)) < 0.002, String(quarter.size));
    assert.ok(quarter.opacity < full.opacity);
  });
  test("a busy board: squares at or below the baseline are a small faint dot, fading toward nothing", () => {
    const ordinary = markOf(300, 400, 300);
    const quiet = markOf(30, 400, 300);
    assert.equal(ordinary.size, MARK_MIN);
    assert.equal(quiet.size, MARK_MIN);
    assert.ok(ordinary.opacity <= 0.3);
    assert.ok(quiet.opacity < 0.05);
  });
  test("the demo player's shape: 16 squares within 26% of the top one no longer look alike", () => {
    // Costs as shares of the top square, as measured on the demo player (both colours).
    const top = [1, 0.91, 0.91, 0.9, 0.89, 0.86, 0.86, 0.83, 0.83, 0.8, 0.79, 0.76, 0.75, 0.75, 0.75, 0.74];
    const sizes = top.map((share) => markOf(share * 400, 400, 0.8 * 400).size); // the 10th is the baseline
    assert.equal(sizes[0], MARK_MAX);
    assert.ok(sizes[4]! > 0.55 && sizes[4]! < 0.66, `the next four are clearly smaller than the top one: ${sizes[4]}`);
    assert.equal(sizes[9], MARK_MIN, "from the 10th on: a small dot");
    assert.equal(sizes[15], MARK_MIN);
    // Sized on the raw cost, the 16th would still have 86% of the top one's diameter.
    assert.ok(Math.sqrt(0.74) > 0.85);
  });
  test("nothing lost, or an empty board: no mark", () => {
    assert.deepEqual(markOf(0, 400, 100), { size: 0, opacity: 0 });
    assert.deepEqual(markOf(5, 0, 0), { size: 0, opacity: 0 });
  });
  test("every square the same (max = baseline): small dots, never a division by zero", () => {
    const m = markOf(50, 50, 50);
    assert.equal(m.size, MARK_MIN);
    assert.ok(Number.isFinite(m.opacity));
  });
});
