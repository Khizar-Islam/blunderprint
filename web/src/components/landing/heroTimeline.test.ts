import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLY_CAP } from "../patterns/geometry";
import { demo } from "./demoData";
import { ARRIVE_MS, clockText, heroFrame, SCAN_END_MS, SCAN_START_MS } from "./heroTimeline";

// The landing's first screen (heroTimeline.ts) and the committed demo snapshot it draws.

const L = { columns: 100, tickW: 4 };

describe("heroFrame: the phases", () => {
  test("before it starts: nothing shown", () => {
    const f = heroFrame(-1, 200, L);
    assert.equal(f.games, 0);
    assert.equal(f.rowAlpha(0), 0);
    assert.equal(f.colouredUpTo, 0);
  });

  test("games arrive top to bottom and the counter follows", () => {
    const mid = heroFrame(ARRIVE_MS / 2, 200, L);
    assert.equal(mid.rowAlpha(0), 1);
    assert.equal(mid.rowAlpha(199), 0);
    assert.ok(mid.games > 90 && mid.games < 110, `games ${mid.games}`);
    const arrived = heroFrame(ARRIVE_MS, 200, L);
    assert.equal(arrived.games, 200);
    assert.equal(arrived.colouredUpTo, 0, "nothing coloured before the engine pass");
    assert.equal(arrived.scanX, null);
  });

  test("the engine pass colours the print left to right behind the scan line", () => {
    const mid = heroFrame((SCAN_START_MS + SCAN_END_MS) / 2, 200, L);
    assert.equal(mid.colouredUpTo, 50);
    assert.equal(mid.scanX, 200);
    const later = heroFrame(SCAN_END_MS - 100, 200, L);
    assert.ok(later.colouredUpTo > mid.colouredUpTo);
    const over = heroFrame(SCAN_END_MS, 200, L);
    assert.equal(over.colouredUpTo, Infinity);
    assert.equal(over.scanX, null);
    assert.ok(SCAN_END_MS <= 4_500, "the first screen is final in under 5 s");
  });

  test("Infinity is the final state (reduced motion, no frames, a scrolled page)", () => {
    const f = heroFrame(Infinity, 200, L);
    assert.equal(f.games, 200);
    assert.equal(f.rowAlpha(0), 1);
    assert.equal(f.rowAlpha(199), 1);
    assert.equal(f.colouredUpTo, Infinity);
    assert.equal(f.scanX, null);
  });

  test("a skipped stretch of frames lands on the right phase (time-based, not frame-counted)", () => {
    // The same t gives the same frame whatever came before it.
    assert.deepEqual({ ...heroFrame(3100, 200, L), rowAlpha: null }, { ...heroFrame(3100, 200, L), rowAlpha: null });
    assert.equal(heroFrame(4100, 200, L).colouredUpTo, Infinity);
  });
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
