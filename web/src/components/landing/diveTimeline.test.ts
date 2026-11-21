import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLY_CAP } from "../patterns/geometry";
import { demo } from "./demoData";
import { DIVE_COLS, divePhases, diveRows, errorsFoundUpTo, resultWords, seg, splitFigure, stageBox, utcDay, xlerp } from "./diveTimeline";

// The landing's dive (diveTimeline.ts): its phases as a function of the scroll, and the snapshot's
// `dive` block that scripts/snapshot-demo.mjs writes.

describe("divePhases", () => {
  test("not scrolled: nothing has started", () => {
    assert.deepEqual(divePhases(0), { a: 0, b: 0, c: 0, slide: 0, played: 0, better: 0, shrink: 0, words: 0, check: 0, ctas: 0 });
  });

  test("scrolled to the end: the final picture (piece back home, both arrows, the words, the rule)", () => {
    assert.deepEqual(divePhases(1), { a: 1, b: 1, c: 1, slide: 0, played: 1, better: 1, shrink: 1, words: 1, check: 1, ctas: 1 });
  });

  test("one thing at a time, in order", () => {
    const mid = divePhases(0.45);
    assert.equal(mid.a, 1);
    assert.ok(mid.b > 0 && mid.b < 1);
    assert.equal(mid.c, 0);
    // The played piece is out on its square while the rust arrow is drawn, and home before the teal one starts.
    const out = divePhases(0.77);
    assert.equal(out.slide, 1);
    assert.equal(out.played, 1);
    assert.equal(out.better, 0);
    assert.equal(divePhases(0.82).slide, 0);
    assert.ok(divePhases(0.85).better > 0);
    // The words come only once the board's story is told.
    assert.equal(divePhases(0.87).words, 0);
  });

  test("every phase only ever moves forward as the page scrolls (except the piece sliding back)", () => {
    const keys = ["a", "b", "c", "played", "better", "shrink", "words", "check", "ctas"] as const;
    let last = divePhases(0);
    for (let p = 0; p <= 1.0001; p += 0.005) {
      const now = divePhases(Math.min(1, p));
      for (const k of keys) assert.ok(now[k] >= last[k] - 1e-9, `${k} went back at ${p}`);
      assert.ok(now.slide >= -1e-9 && now.slide <= 1 + 1e-9);
      last = now;
    }
  });

  test("a scroll position gives the same picture whatever came before it", () => {
    assert.deepEqual(divePhases(0.6), divePhases(0.6));
  });
});

test("seg and xlerp", () => {
  assert.equal(seg(0.1, 0.2, 0.4), 0);
  assert.ok(Math.abs(seg(0.3, 0.2, 0.4) - 0.5) < 1e-9);
  assert.equal(seg(0.9, 0.2, 0.4), 1);
  assert.equal(xlerp(2, 32, 0), 2);
  assert.ok(Math.abs(xlerp(2, 32, 0.5) - 8) < 1e-9); // half-way is the same factor from both ends
  assert.equal(xlerp(2, 32, 1), 32);
});

describe("the rows and the counter", () => {
  test("only the player's errors are marks, and the counter ends on all of them", () => {
    const rows = diveRows([
      { gameId: "a", playedAt: "2026-10-06T10:00:00.000Z", color: "white", result: "win", speed: "bullet", classes: "xgigm" }, // plies 1, 3, 5 are White's
      { gameId: "b", playedAt: "2026-10-05T10:00:00.000Z", color: "black", result: "loss", speed: "bullet", classes: "xmgx" }, // plies 2, 4 are Black's
    ]);
    assert.deepEqual(rows[0]!.errs, [
      { ply: 1, kind: "blunder" },
      { ply: 3, kind: "inaccuracy" },
      { ply: 5, kind: "mistake" },
    ]);
    assert.deepEqual(rows[1]!.errs, [
      { ply: 2, kind: "mistake" },
      { ply: 4, kind: "blunder" },
    ]);
    const found = errorsFoundUpTo(rows, 4);
    assert.deepEqual(found, [0, 1, 2, 3, 5]); // ply 5 is past the last column: counted in it
  });

  test("the demo's counter ends on every error of the 200 games", () => {
    const rows = diveRows(demo.ribbons);
    const found = errorsFoundUpTo(rows);
    assert.equal(found.length, DIVE_COLS + 1);
    assert.equal(found[DIVE_COLS], rows.reduce((n, r) => n + r.errs.length, 0));
  });
});

test("splitFigure: the sentence around the move's own figure", () => {
  assert.deepEqual(splitFigure("Moves such as Re3 and Nd4 cost 58.7 and 49.4 win-chance points.", "49.4 win-chance points"), [
    "Moves such as Re3 and Nd4 cost 58.7 and ",
    "49.4 win-chance points",
    ".",
  ]);
  assert.deepEqual(splitFigure("No figure here.", null), ["No figure here.", "", ""]);
  assert.deepEqual(splitFigure("No figure here.", "49.4"), ["No figure here.", "", ""]);
});

test("resultWords and utcDay", () => {
  assert.equal(resultWords("win", "white"), "won as White");
  assert.equal(resultWords("loss", "black"), "lost as Black");
  assert.equal(resultWords("draw", "white"), "drew as White");
  // UTC, so the server and every visitor's browser write the same day.
  assert.equal(utcDay("2026-10-06T23:30:00.000Z"), "6 Oct 2026");
});

describe("stageBox", () => {
  test("side by side: the print keeps the right, 3 px rows when 200 of them fit", () => {
    const b = stageBox(1088, 900, true, 200);
    assert.equal(b.hx, 413);
    assert.equal(b.pitch0, 3);
    assert.equal(b.board, 440);
    assert.ok(b.by + b.board < 900);
  });
  test("a short laptop screen: 2 px rows, so the whole print is on the first screen", () => {
    const b = stageBox(1088, 650, true, 200);
    assert.equal(b.pitch0, 2);
    assert.ok(b.hy + 200 * b.pitch0 < 650);
    assert.equal(stageBox(1088, 593, true, 200).pitch0, 2);
    // A tall screen gets taller rows, never more than 4 px apart.
    assert.equal(stageBox(1088, 1080, true, 200).pitch0, 4);
    assert.equal(stageBox(1088, 1080, true, 200).rowH0, 3);
    assert.equal(stageBox(1088, 2000, true, 200).pitch0, 4);
    assert.equal(b.board, 338);
  });
  test("a phone: a big board for the move, then it shrinks to what the words leave", () => {
    const b = stageBox(350, 660, false, 200, 190);
    assert.equal(b.board, 330);
    assert.equal(b.bx, 10);
    assert.equal(b.small, 190);
    assert.equal(stageBox(350, 900, false, 200, 400).small, 350, "room to spare: it doesn't shrink");
    assert.equal(stageBox(350, 660, false, 200, 40).small, 96, "never smaller than a readable board");
  });
  test("each height step of --print-top (globals.css) fits the masthead, the figure, 200 rows and the caption", () => {
    // [screen height, --print-top at that height, the rows' pitch it must give]
    const steps = [
      [593, 140, 2],
      [699, 140, 2],
      [700, 176, 2],
      [799, 176, 2],
      [800, 136, 3],
      [839, 136, 3],
      [840, 176, 3],
      [897, 176, 3],
      [942, 176, 3],
      [1040, 176, 4],
      [1080, 176, 4],
    ] as const;
    for (const [H, top, pitch] of steps) {
      const b = stageBox(1088, H, true, 200, Infinity, top);
      assert.equal(b.hy, top, String(H));
      assert.equal(b.pitch0, pitch, String(H));
      assert.ok(b.hy + 200 * b.pitch0 + 12 + 28 <= H, `${H}: the caption fits under the print`);
    }
    assert.equal(stageBox(390, 844, false, 200, Infinity, 196).hy, 88, "under the words the print's top is fixed");
  });
  test("side by side the board never shrinks", () => {
    const b = stageBox(1088, 900, true, 200);
    assert.equal(b.small, b.board);
  });
});

describe("the snapshot's dive (src/data/demo.json)", () => {
  const d = demo.dive;
  const note = demo.notes[d.note];

  test("follows one of the notes' moves, with everything the board needs", () => {
    assert.ok(note, "the dive's note exists");
    const e = note.evidence;
    assert.ok(e.ply <= PLY_CAP, "the move is in the drawn print");
    assert.match(e.playedUci ?? "", /^[a-h][1-8][a-h][1-8]/);
    assert.match(e.betterUci ?? "", /^[a-h][1-8][a-h][1-8]/);
    assert.ok(e.betterMove);
  });

  test("has every move of that game, and the move itself where the note says", () => {
    const e = note!.evidence;
    const ribbon = demo.ribbons.find((r) => r.gameId === e.gameId)!;
    assert.equal(d.sans.length, ribbon.classes.length);
    assert.equal(d.sans[e.ply - 1]!.replace(/[+#]$/, ""), e.played.replace(/[+#]$/, ""));
  });

  test("the sentence names the move, and the figure is the move's own number inside it", () => {
    const e = note!.evidence;
    assert.ok(d.sentence.includes(e.played));
    if (d.figure !== null) {
      assert.ok(d.sentence.includes(d.figure));
      assert.ok(d.figure.startsWith(String(e.winPctLost)));
    }
  });
});
