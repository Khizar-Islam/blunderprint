import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { Summary } from "@/lib/api";
import { bucketWords, densest, DIGEST_MOVES, moveDigest } from "./digest";
import { annotated, markInfoAt, marksByPly } from "./link";

type Ribbon = Summary["ribbons"][number];
const ribbon = (classes: string, color: "white" | "black" = "white", more: Partial<Ribbon> = {}): Ribbon => ({
  gameId: "g",
  playedAt: "2026-11-01T00:00:00.000Z",
  color,
  result: "win",
  speed: "blitz",
  classes,
  ...more,
});

describe("moveDigest: the print in one line", () => {
  test("60 cells; a move number is the player's own move (White's ply 5 is move 3)", () => {
    // Three games (the least a move number needs): White blunders on ply 5 in each.
    const strip = moveDigest([ribbon("ggggxg"), ribbon("ggggxg"), ribbon("ggggxg")]);
    assert.equal(strip.length, DIGEST_MOVES);
    assert.equal(strip[2], 1, "move 3 is the busiest: full strength");
    assert.equal(strip[0], 0);
    assert.equal(strip[1], 0);
  });
  test("the opponent's errors don't count", () => {
    const strip = moveDigest([ribbon("gxgggg"), ribbon("gxgggg"), ribbon("gxgggg")]);
    assert.ok(strip.every((s) => s === 0));
  });
  test("shares of the busiest move, on a slight curve, to two decimals", () => {
    // Move 1 goes wrong in all 4 games, move 2 in 2 of them: 0.5 ^ 1.4 = 0.38.
    const strip = moveDigest([ribbon("xgxg"), ribbon("xgxg"), ribbon("xggg"), ribbon("xggg")]);
    assert.equal(strip[0], 1);
    assert.equal(strip[1], 0.38);
  });
  test("a move number too few games reach stays empty, however bad it was there", () => {
    const long = "g".repeat(20) + "x"; // White's blunder on ply 21 = move 11
    const strip = moveDigest([ribbon(long), ribbon("xg"), ribbon("gg"), ribbon("gg")]);
    assert.equal(strip[10], 0, "only one game reaches move 11");
    assert.equal(strip[0], 1);
  });
  test("moves past 60 share the last cell", () => {
    const long = "g".repeat(130) + "x"; // ply 131 = White's move 66
    const strip = moveDigest([ribbon(long), ribbon(long), ribbon(long)]);
    assert.equal(strip[59], 1);
  });
  test("no games: all empty", () => {
    assert.ok(moveDigest([]).every((s) => s === 0));
  });
});

describe("densest: where the errors are densest, in the API's own figures", () => {
  const rate = (bucket: string, per100: number | null, moves: number) => ({ bucket, per100, moves, total: 0, perGame: null, inaccuracy: 0, mistake: 0, blunder: 0 });
  const totals = (moves: number, total: number) => ({ games: 10, analysed: 10, moves, mistakes: { inaccuracy: total, mistake: 0, blunder: 0, total }, firstPlayedAt: null, lastPlayedAt: null });
  test("the bucket with the highest rate, with the overall figure", () => {
    const d = densest({ byMoveNumber: [rate("1-10", 2, 2000), rate("11-20", 3.1, 2000), rate("41+", 5.5, 900)], totals: totals(8000, 240) });
    assert.deepEqual(d, { bucket: "41+", per100: 5.5, overall: 3 });
  });
  test("a bucket on too few moves is not named", () => {
    const d = densest({ byMoveNumber: [rate("1-10", 3.4, 2000), rate("41+", 20, 40)], totals: totals(2040, 60) });
    assert.equal(d!.bucket, "1-10");
  });
  test("nothing stands clear of the overall figure (under 10% above it): null", () => {
    assert.equal(densest({ byMoveNumber: [rate("1-10", 3.1, 2000), rate("11-20", 2.9, 2000)], totals: totals(4000, 120) }), null);
    assert.equal(densest({ byMoveNumber: [], totals: totals(0, 0) }), null);
  });
  test("in words", () => {
    assert.equal(bucketWords("41+"), "from move 41 on");
    assert.equal(bucketWords("11-20"), "in moves 11 to 20");
  });
});

describe("the print's marks (link.ts)", () => {
  const r = ribbon("ggggxgm", "white", { marks: [[5, "d4", "Nd4", 49.4], [7, "f7", "Bxf7+", 21]] });
  test("the error at a ply, with its move, square and cost", () => {
    assert.deepEqual(markInfoAt(r, 5), { gameId: "g", color: "white", playedAt: r.playedAt, speed: "blitz", ply: 5, kind: "blunder", square: "d4", san: "Nd4", winDrop: 49.4 });
    assert.equal(markInfoAt(r, 7)!.kind, "mistake");
  });
  test("not an error, no ply, or no marks sent (summary v2): null", () => {
    assert.equal(markInfoAt(r, 3), null);
    assert.equal(markInfoAt(r, null), null);
    assert.equal(markInfoAt(ribbon("ggggxg"), 5), null);
    assert.equal(marksByPly(ribbon("ggggxg")).size, 0);
  });
  test("by ply, and the annotation signs", () => {
    assert.deepEqual(marksByPly(r).get(7), { square: "f7", san: "Bxf7+", winDrop: 21 });
    assert.equal(annotated("Nd4", "blunder"), "Nd4??");
    assert.equal(annotated("e5", "mistake"), "e5?");
    assert.equal(annotated("Qh5", "inaccuracy"), "Qh5?!");
  });
});
