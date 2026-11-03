import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { errorPlies, hitTest, isPlayersPly, layout, loupePly, MARKER_W, moveName, PLY_CAP, stepError, tickAt, truncation } from "./geometry";

// Tests for the Blunderprint's geometry (geometry.ts, drawn by Blunderprint.tsx).
// classes: one letter per ply, b best, g good, i inaccuracy, m mistake, x blunder.

describe("ticks", () => {
  test("White plays the odd plies", () => {
    assert.equal(isPlayersPly(1, "white"), true);
    assert.equal(isPlayersPly(2, "white"), false);
    assert.equal(isPlayersPly(2, "black"), true);
  });
  test("only the player's errors are coloured; the opponent's are neutral whatever their class", () => {
    const classes = "gxmibg"; // White: g m b, Black: x i g
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((p) => tickAt(classes, p, "white")), ["own", "opponent", "mistake", "opponent", "own", "opponent"]);
    assert.deepEqual([1, 2, 3, 4, 5, 6].map((p) => tickAt(classes, p, "black")), ["opponent", "blunder", "opponent", "inaccuracy", "opponent", "own"]);
  });
  test("move names", () => {
    assert.equal(moveName(1), "1.");
    assert.equal(moveName(46), "23…");
  });
});

describe("errors and keyboard stepping", () => {
  const classes = "gxgiggmggx"; // Black errs at 2 (x), 4 (i), 10 (x); White at 7 (m)
  test("the player's error plies", () => {
    assert.deepEqual(errorPlies(classes, "black"), [2, 4, 10]);
    assert.deepEqual(errorPlies(classes, "white"), [7]);
  });
  test("next and previous from a ply, or from the edges", () => {
    assert.equal(stepError(classes, "black", null, 1), 2);
    assert.equal(stepError(classes, "black", 2, 1), 4);
    assert.equal(stepError(classes, "black", 4, 1), 10);
    assert.equal(stepError(classes, "black", 10, 1), null, "no wrap-around");
    assert.equal(stepError(classes, "black", null, -1), 10);
    assert.equal(stepError(classes, "black", 4, -1), 2);
    assert.equal(stepError(classes, "black", 2, -1), null);
    assert.equal(stepError(classes, "black", 3, 1), 4, "from a non-error ply too");
  });
});

describe("truncation past the cap", () => {
  const long = (tail: string) => "g".repeat(PLY_CAP) + tail;
  test("a row within the cap isn't cut", () => {
    assert.deepEqual(truncation("g".repeat(PLY_CAP), "white"), { cut: false, worstHidden: null });
  });
  test("a cut row with no hidden errors gets a neutral marker", () => {
    assert.deepEqual(truncation(long("gggg"), "white"), { cut: true, worstHidden: null });
  });
  test("the marker takes the worst of the player's hidden errors", () => {
    // Plies 121.. : 121 i (White), 122 x (Black), 123 m (White)
    const classes = long("ixm");
    assert.deepEqual(truncation(classes, "white"), { cut: true, worstHidden: "mistake" });
    assert.deepEqual(truncation(classes, "black"), { cut: true, worstHidden: "blunder" });
  });
  test("an opponent's hidden blunder doesn't tint the player's marker", () => {
    assert.deepEqual(truncation(long("gx"), "white"), { cut: true, worstHidden: null });
  });
  test("errors past the cap are still reachable by keyboard", () => {
    const classes = long("gggx"); // ply 124: Black's blunder
    assert.equal(stepError(classes, "black", null, 1), 124);
    assert.equal(stepError(classes, "black", PLY_CAP, 1), 124);
  });
  test("the loupe maps the FULL game across its width", () => {
    assert.equal(loupePly(400, 160, 399), 160, "the last ply, past the cap");
    assert.equal(loupePly(400, 160, 0), 1);
    assert.equal(loupePly(400, 160, 200), 81);
    assert.equal(loupePly(400, 160, 400), null);
    assert.equal(loupePly(400, 0, 10), null);
  });
});

describe("layout", () => {
  test("desktop rows 3 px + 1 px gap, compact 2 + 1", () => {
    const l = layout(606, [80, 40], false);
    assert.equal(l.rowH, 3);
    assert.equal(l.pitch, 4);
    assert.equal(l.height, 8);
    const c = layout(358, [80, 40], true);
    assert.equal(c.pitch, 3);
    assert.equal(c.height, 6);
  });
  test("columns follow the longest game, up to the cap; the marker margin stays free", () => {
    assert.equal(layout(606, [80, 40], false).columns, 80);
    const l = layout(606, [80, 300], false);
    assert.equal(l.columns, PLY_CAP, "one 300-ply game doesn't squash every row");
    assert.equal(l.tickW, (606 - MARKER_W) / PLY_CAP);
  });
  test("no games", () => {
    const l = layout(600, [], false);
    assert.equal(l.height, 0);
    assert.equal(l.columns, 1);
  });
});

describe("hitTest", () => {
  const lengths = [80, 40, 300];
  const l = layout(606, lengths, false); // 120 columns of 5 px, rows every 4 px
  test("row and ply under the point", () => {
    assert.deepEqual(hitTest(l, lengths, 0, 0), { row: 0, ply: 1 });
    assert.deepEqual(hitTest(l, lengths, 12, 5), { row: 1, ply: 3 });
  });
  test("the gap under a row belongs to that row (no flicker)", () => {
    assert.deepEqual(hitTest(l, lengths, 12, 3.5), { row: 0, ply: 3 });
  });
  test("past a short row's end: the row, but no ply", () => {
    assert.deepEqual(hitTest(l, lengths, 300, 5), { row: 1, ply: null }); // column 61 > 40 plies
  });
  test("a cut row: ticks up to the cap, none over the marker margin", () => {
    assert.deepEqual(hitTest(l, lengths, 599, 9), { row: 2, ply: PLY_CAP });
    assert.deepEqual(hitTest(l, lengths, 603, 9), { row: 2, ply: null });
  });
  test("outside the canvas: nothing", () => {
    assert.equal(hitTest(l, lengths, -1, 0), null);
    assert.equal(hitTest(l, lengths, 0, 12), null);
    assert.equal(hitTest(l, lengths, 606, 0), null);
  });
});
