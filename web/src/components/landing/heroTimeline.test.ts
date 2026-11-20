import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLY_CAP } from "../patterns/geometry";
import { demo } from "./demoData";
import { ARRIVE_MS, clockText, DEVELOPED_MS, heroFrame, KIND_MS, RECEDE_MS, recedeAt, TARGET_MS } from "./heroTimeline";

// The landing's first screen (heroTimeline.ts) and the committed demo snapshot it draws.

describe("heroFrame: the phases", () => {
  test("before it starts: nothing shown", () => {
    const f = heroFrame(-1, 200);
    assert.equal(f.games, 0);
    assert.equal(f.rowAlpha(0), 0);
    assert.deepEqual(f.kind, { inaccuracy: 0, mistake: 0, blunder: 0 });
    assert.equal(f.target, 0);
  });

  test("games arrive top to bottom and the counter follows", () => {
    const mid = heroFrame(ARRIVE_MS / 2, 200);
    assert.equal(mid.rowAlpha(0), 1);
    assert.equal(mid.rowAlpha(199), 0);
    assert.ok(mid.games > 90 && mid.games < 110, `games ${mid.games}`);
    const arrived = heroFrame(ARRIVE_MS, 200);
    assert.equal(arrived.games, 200);
    assert.deepEqual(arrived.kind, { inaccuracy: 0, mistake: 0, blunder: 0 }, "no mark before the rows are there");
  });

  test("the marks develop kind by kind, the faintest first, the followed move last", () => {
    const early = heroFrame(KIND_MS.inaccuracy[1], 200);
    assert.equal(early.kind.inaccuracy, 1);
    assert.ok(early.kind.mistake > 0 && early.kind.mistake < 1);
    assert.equal(early.kind.blunder, 0);
    const late = heroFrame(KIND_MS.blunder[1], 200);
    assert.deepEqual(late.kind, { inaccuracy: 1, mistake: 1, blunder: 1 });
    assert.equal(late.target, 0, "the followed move is still to come");
    assert.ok(KIND_MS.inaccuracy[0] < KIND_MS.mistake[0] && KIND_MS.mistake[0] < KIND_MS.blunder[0] && KIND_MS.blunder[1] <= TARGET_MS[0]);
    assert.equal(heroFrame(DEVELOPED_MS, 200).target, 1);
    assert.ok(DEVELOPED_MS <= 3_000, "the print is whole within the first three seconds");
  });

  test("Infinity is the final state (reduced motion, no frames, a scrolled page)", () => {
    const f = heroFrame(Infinity, 200);
    assert.equal(f.games, 200);
    assert.equal(f.rowAlpha(0), 1);
    assert.equal(f.rowAlpha(199), 1);
    assert.deepEqual(f.kind, { inaccuracy: 1, mistake: 1, blunder: 1 });
    assert.equal(f.target, 1);
  });

  test("a skipped stretch of frames lands on the right phase (time-based, not frame-counted)", () => {
    // The same t gives the same frame whatever came before it.
    assert.deepEqual({ ...heroFrame(1300, 200), rowAlpha: null }, { ...heroFrame(1300, 200), rowAlpha: null });
    assert.equal(heroFrame(4100, 200).target, 1);
  });
});

test("recedeAt: the marks outside the finding's band recede once the print is whole", () => {
  assert.equal(recedeAt(DEVELOPED_MS), 0, "not before the print is whole");
  assert.equal(recedeAt(RECEDE_MS[0]), 0);
  const mid = recedeAt((RECEDE_MS[0] + RECEDE_MS[1]) / 2);
  assert.ok(mid > 0.4 && mid < 0.6, `mid ${mid}`);
  assert.equal(recedeAt(RECEDE_MS[1]), 1);
  assert.equal(recedeAt(Infinity), 1, "the final state (reduced motion, no frames)");
  assert.ok(RECEDE_MS[1] - RECEDE_MS[0] === 600 && RECEDE_MS[1] <= 3_500);
});

test("clockText", () => {
  assert.equal(clockText(4.3), "0:04");
  assert.equal(clockText(67), "1:07");
  assert.equal(clockText(-1), "0:00");
});

describe("the committed demo snapshot (src/data/demo.json)", () => {
  test("has the demo player's games, all of them with ribbons", () => {
    assert.equal(demo.platform, "lichess");
    assert.ok(demo.username.length > 0);
    assert.equal(demo.ribbons.length, demo.analysedGames);
    for (const r of demo.ribbons) {
      assert.ok(r.color === "white" || r.color === "black");
      assert.ok(["win", "loss", "draw"].includes(r.result));
      assert.match(r.classes, /^[bgimx]+$/);
    }
  });

  test("three notes, each pointing at a drawn tick that really is the player's error", () => {
    assert.equal(demo.notes.length, 3);
    for (const n of demo.notes) {
      const ribbon = demo.ribbons.find((r) => r.gameId === n.evidence.gameId);
      assert.ok(ribbon, `${n.title}: its game is in the print`);
      assert.ok(n.evidence.ply <= PLY_CAP, `${n.title}: ply ${n.evidence.ply} is drawn`);
      const letter = ribbon.classes[n.evidence.ply - 1];
      assert.equal(letter, { inaccuracy: "i", mistake: "m", blunder: "x" }[n.evidence.kind], `${n.title}: the tick's class`);
      assert.equal(n.evidence.color, ribbon.color);
      assert.ok(n.title.length > 0 && Number.isFinite(n.stat.value) && Number.isFinite(n.stat.baseline));
    }
  });

  test("leaves out what the landing doesn't need (no opponent names, no ribbons in notes)", () => {
    const text = JSON.stringify(demo);
    assert.equal(text.includes("opponentName"), false);
    for (const n of demo.notes) assert.equal("ribbon" in n.evidence, false);
  });
});
