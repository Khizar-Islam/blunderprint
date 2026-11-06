import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLY_CAP } from "../patterns/geometry";
import { demo } from "./demoData";
import {
  ARRIVE_MS,
  clockText,
  heroDurationMs,
  heroFrame,
  heroLayout,
  noteStartMs,
  placeNotes,
  SCAN_END_MS,
  SCAN_START_MS,
} from "./heroTimeline";

// The landing hero's timeline (heroTimeline.ts) and the committed demo snapshot it draws.

const L = { columns: 100, tickW: 4 };

describe("heroFrame: the phases", () => {
  test("before it starts: nothing shown", () => {
    const f = heroFrame(-1, 200, L, 3);
    assert.equal(f.games, 0);
    assert.equal(f.rowAlpha(0), 0);
    assert.equal(f.colouredUpTo, 0);
    assert.equal(f.notes, 0);
    assert.equal(f.done, false);
  });

  test("games arrive top to bottom and the counter follows", () => {
    const mid = heroFrame(ARRIVE_MS / 2, 200, L, 3);
    assert.equal(mid.rowAlpha(0), 1);
    assert.equal(mid.rowAlpha(199), 0);
    assert.ok(mid.games > 90 && mid.games < 110, `games ${mid.games}`);
    const arrived = heroFrame(ARRIVE_MS, 200, L, 3);
    assert.equal(arrived.games, 200);
    assert.equal(arrived.colouredUpTo, 0, "nothing coloured before the engine pass");
    assert.equal(arrived.scanX, null);
  });

  test("the engine pass colours the print left to right behind the scan line", () => {
    const mid = heroFrame((SCAN_START_MS + SCAN_END_MS) / 2, 200, L, 3);
    assert.equal(mid.colouredUpTo, 50);
    assert.equal(mid.scanX, 200);
    const later = heroFrame(SCAN_END_MS - 100, 200, L, 3);
    assert.ok(later.colouredUpTo > mid.colouredUpTo);
    const over = heroFrame(SCAN_END_MS, 200, L, 3);
    assert.equal(over.colouredUpTo, Infinity);
    assert.equal(over.scanX, null);
  });

  test("the coach's notes come one by one, then it's done", () => {
    assert.equal(heroFrame(noteStartMs(0) - 1, 200, L, 3).notes, 0);
    assert.equal(heroFrame(noteStartMs(0), 200, L, 3).notes, 1);
    assert.equal(heroFrame(noteStartMs(2), 200, L, 3).notes, 3);
    assert.equal(heroFrame(heroDurationMs(3) - 1, 200, L, 3).done, false);
    assert.equal(heroFrame(heroDurationMs(3), 200, L, 3).done, true);
    assert.ok(heroDurationMs(3) <= 6_000, "the hero finishes in about 6 s");
  });

  test("Infinity is the final state (reduced motion, the safety timer)", () => {
    const f = heroFrame(Infinity, 200, L, 3);
    assert.equal(f.games, 200);
    assert.equal(f.rowAlpha(0), 1);
    assert.equal(f.rowAlpha(199), 1);
    assert.equal(f.colouredUpTo, Infinity);
    assert.equal(f.scanX, null);
    assert.equal(f.notes, 3);
    assert.equal(f.done, true);
  });

  test("a skipped stretch of frames lands on the right phase (time-based, not frame-counted)", () => {
    // The same t gives the same frame whatever came before it.
    assert.deepEqual(
      { ...heroFrame(4100, 200, L, 3), rowAlpha: null },
      { ...heroFrame(4100, 200, L, 3), rowAlpha: null },
    );
    assert.equal(heroFrame(4100, 200, L, 3).colouredUpTo, Infinity);
  });
});

describe("heroLayout", () => {
  test("200 games: 600 px on desktop, 300 px on a phone", () => {
    const lengths = new Array(200).fill(80);
    assert.equal(heroLayout(480, lengths, false).height, 600);
    assert.equal(heroLayout(350, lengths, true).height, 300);
    assert.equal(heroLayout(350, lengths, true).rowH, 1);
  });
});

describe("placeNotes", () => {
  test("notes far apart stay level with their move", () => {
    assert.deepEqual(placeNotes([10, 200, 400], 600, 90), [10, 200, 400]);
  });
  test("close notes are pushed apart, in input order", () => {
    assert.deepEqual(placeNotes([300, 100, 120], 600, 90), [300, 100, 190]);
  });
  test("a stack that runs past the bottom is pulled back up", () => {
    assert.deepEqual(placeNotes([500, 520, 540], 600, 90), [330, 420, 510]);
  });
  test("never above the top", () => {
    assert.deepEqual(placeNotes([-20, 0], 600, 90), [0, 90]);
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
