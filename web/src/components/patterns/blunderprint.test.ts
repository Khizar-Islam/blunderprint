import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { drawRows, errorPlies, hitTest, isPlayersPly, layout, loupePly, MARK_COLS, MARK_MIN_W, markAt, MARKER_W, moveName, NEUTRAL_MARKER, PLY_CAP, RIDGE, stepError, TICK_COLOR, tickAt, truncation, type Color } from "./geometry";

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

describe("markAt: the error whose mark is under a ply", () => {
  test("the error's own ply and the reply's ply are both its mark; elsewhere there is none", () => {
    // White's blunder on ply 3: its mark covers plies 3 and 4.
    assert.equal(markAt("ggxggg", "white", 3), 3);
    assert.equal(markAt("ggxggg", "white", 4), 3);
    assert.equal(markAt("ggxggg", "white", 5), null);
    assert.equal(markAt("ggxggg", "white", 2), null);
    // The opponent's blunder on ply 4 is no mark of the player's.
    assert.equal(markAt("gggxgg", "white", 4), null);
    assert.equal(markAt("gggxgg", "white", 5), null);
    assert.equal(markAt("xggggg", "white", 1), 1);
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

// What is actually painted. A fake 2D context records every rectangle with the fill colour and
// alpha in force when it was drawn, so the picture can be compared with the data tick by tick.
describe("drawRows", () => {
  interface Rect {
    x: number;
    y: number;
    w: number;
    h: number;
    fill: string;
    alpha: number;
  }
  function fakeCanvas() {
    const rects: Rect[] = [];
    const cleared: number[][] = [];
    const ctx = {
      fillStyle: "",
      globalAlpha: 1,
      clearRect: (x: number, y: number, w: number, h: number) => void cleared.push([x, y, w, h]),
      fillRect(x: number, y: number, w: number, h: number) {
        rects.push({ x, y, w, h, fill: this.fillStyle, alpha: this.globalAlpha });
      },
    };
    return { ctx: ctx as unknown as CanvasRenderingContext2D, raw: ctx, rects, cleared };
  }
  const row = (classes: string, color: Color = "white") => ({ classes, color });
  const full = () => 1;
  // 10 px per ply: the width is the plies shown × 10 plus the marker margin.
  const widthFor = (columns: number) => columns * 10 + MARKER_W;

  test("a game is one quiet line as long as the game, with a mark two columns wide at each of the player's errors", () => {
    // White: ply 1 good, ply 3 a blunder, ply 5 an inaccuracy. Black's ply 4 is a blunder too, but it's the opponent's.
    const rows = [row("ggxxigg")];
    const l = layout(widthFor(7), [7], false);
    const c = fakeCanvas();
    drawRows(c.ctx, l, rows, full);
    assert.deepEqual(c.cleared, [[0, 0, l.width, l.height]]);
    assert.deepEqual(
      c.rects.map((r) => [r.x, r.w, r.fill]),
      [
        [0, 70, RIDGE],
        [20, MARK_COLS * 10, TICK_COLOR.blunder],
        [40, MARK_COLS * 10, TICK_COLOR.inaccuracy],
      ],
    );
    assert.ok(c.rects.every((r) => r.y === 0 && r.h === l.rowH && r.alpha === 1));
  });

  test("the same game seen as Black marks the other plies", () => {
    const l = layout(widthFor(6), [6], false);
    const c = fakeCanvas();
    drawRows(c.ctx, l, [row("xmxmgg", "black")], full);
    assert.deepEqual(c.rects.map((r) => [r.x, r.fill]), [[0, RIDGE], [10, TICK_COLOR.mistake], [30, TICK_COLOR.mistake]]);
  });

  test("each row sits at row × pitch, and a shorter game's line simply ends earlier", () => {
    const rows = [row("gggg"), row("gg")];
    const l = layout(widthFor(4), [4, 2], false);
    const c = fakeCanvas();
    drawRows(c.ctx, l, rows, full);
    assert.deepEqual(c.rects.map((r) => [r.x, r.y, r.w]), [[0, 0, 40], [0, l.pitch, 20]]);
  });

  test("a mark is never thinner than MARK_MIN_W, and never runs past the cap into the end marker's margin", () => {
    // 400 columns in 406 px: 1 px a ply, so two columns would be 2 px.
    const thin = layout(406, [400], false, 400);
    const a = fakeCanvas();
    drawRows(a.ctx, thin, [row("x" + "g".repeat(399))], full);
    assert.equal(a.rects[1]!.w, MARK_MIN_W);
    // An error on the last column before the cap: its mark is cut at the cap.
    const l = layout(widthFor(4), [4], false, 4);
    const b = fakeCanvas();
    drawRows(b.ctx, l, [row("gggx", "black")], full);
    assert.deepEqual(b.rects.map((r) => [r.x, r.w, r.fill]), [[0, 40, RIDGE], [30, 10, TICK_COLOR.blunder]]);
  });

  test("before the engine pass reaches a ply its error is not marked yet: only the quiet line", () => {
    const rows = [row("xgxgxgxg")];
    const l = layout(widthFor(8), [8], false);
    const none = fakeCanvas();
    drawRows(none.ctx, l, rows, full, 0);
    assert.deepEqual(none.rects.map((r) => [r.x, r.w, r.fill]), [[0, 80, RIDGE]]);

    // Marked up to ply 3: the errors on plies 1 and 3, not those on 5 and 7.
    const some = fakeCanvas();
    drawRows(some.ctx, l, rows, full, 3);
    assert.deepEqual(some.rects.map((r) => [r.x, r.fill]), [[0, RIDGE], [0, TICK_COLOR.blunder], [20, TICK_COLOR.blunder]]);
  });

  test("a row cut at the cap gets an end marker in the colour of its worst hidden error, or neutral", () => {
    // Cap 4: White's hidden plies are 5 (inaccuracy) and 7 (blunder); the second game hides nothing bad.
    const rows = [row("ggggigxg"), row("gggggggg"), row("gggg")];
    const l = layout(widthFor(4), [8, 8, 4], false, 4);
    const c = fakeCanvas();
    drawRows(c.ctx, l, rows, full);
    const markers = c.rects.filter((r) => r.x === 4 * 10 + 2);
    assert.deepEqual(
      markers.map((r) => [r.y, r.w, r.fill]),
      [
        [0, MARKER_W - 2, TICK_COLOR.blunder],
        [l.pitch, MARKER_W - 2, NEUTRAL_MARKER],
      ],
    );
    // Nothing is painted past the cap except the markers.
    assert.ok(c.rects.every((r) => r.x + r.w <= 40 || r.x === 42));
  });

  test("while the engine pass is still colouring, no end marker yet", () => {
    const l = layout(widthFor(4), [8], false, 4);
    const c = fakeCanvas();
    drawRows(c.ctx, l, [row("ggggigxg")], full, 4);
    assert.equal(c.rects.filter((r) => r.x >= 40).length, 0);
  });

  test("rows fade in: alpha 0 draws nothing, a partial alpha applies to the whole row, and alpha is reset to 1 after", () => {
    const rows = [row("gg"), row("gg"), row("gg")];
    const l = layout(widthFor(2), [2, 2, 2], false);
    const c = fakeCanvas();
    drawRows(c.ctx, l, rows, (r) => [1, 0, 0.4][r]!);
    assert.deepEqual([...new Set(c.rects.map((r) => r.y))], [0, 2 * l.pitch]);
    assert.ok(c.rects.filter((r) => r.y === 2 * l.pitch).every((r) => r.alpha === 0.4));
    assert.equal(c.raw.globalAlpha, 1);
  });
});
