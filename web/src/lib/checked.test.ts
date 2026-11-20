import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CoachEvidence, CoachPattern } from "./api";
import { checkedParts, matchesValue, moveLabel, proseNumbers, statSources } from "./checked";

const ev = (over: Partial<CoachEvidence> & { clock?: number; bucket?: string }): CoachEvidence => ({
  gameId: "g",
  ply: 1,
  moveNumber: 1,
  kind: "blunder",
  played: "Nd4",
  betterMove: "Kd3",
  playedUci: null,
  betterUci: null,
  winPctLost: 10,
  fen: "",
  color: "white",
  facts: { speed: "bullet", phase: "endgame", clockBucket: over.bucket ?? null, clockLeftSeconds: over.clock ?? null, opening: null },
  ...over,
});

// The demo report's second pattern, as the API sends it (20 Nov 2026).
const late: Pick<CoachPattern, "title" | "stat" | "evidence"> = {
  title: "Blunders per 100 moves from move 41 on",
  stat: { measure: "blunderPer100", value: 5.5, unit: "per100", baseline: 3, direction: "higherIsWorse", gapPct: 83, games: 101, moves: 1457, errors: 80 },
  evidence: [
    ev({ moveNumber: 72, played: "Re3", winPctLost: 58.7, clock: 4.62, bucket: "under10" }),
    ev({ moveNumber: 47, played: "Nd4", winPctLost: 49.4, clock: 4.46, bucket: "under10" }),
  ],
};
const LATE_TEXT =
  "Deep into bullet games past move 41, you struggle in the endgame under extreme time pressure with under 10 percent of your clock remaining. In these positions, rook and knight moves such as Re3 and Nd4 cost 58.7 and 49.4 win-chance points. Maintaining composure and playing precise alternative moves like Kxf3 or Kd3 is vital here.";

const figures = (text: string, p = late) => checkedParts(text, p).flatMap((x) => (x.kind === "figure" ? [x] : []));

describe("the verifier's rules, as the page uses them", () => {
  test("a number matches a value it could be a rounding of", () => {
    assert.equal(matchesValue("12", 12.04), true);
    assert.equal(matchesValue("12.4", 12.04), false);
    assert.equal(matchesValue("12.5", 12.46), true);
    assert.equal(matchesValue("49.4", 49.4), true);
  });
  test("numbers in prose, with their place; not squares, opening codes, the unit's 100 or castling", () => {
    const text = "After Nf3 in the B06, 5.5 per 100 moves and 0-0 on move 12, 70% of e4.";
    assert.deepEqual(
      proseNumbers(text).map((n) => n.text),
      ["5.5", "12", "70"],
    );
    for (const n of proseNumbers(text)) assert.equal(text.slice(n.index, n.index + n.text.length), n.text);
  });
});

describe("checkedParts", () => {
  test("the parts put back together are the text, unchanged", () => {
    assert.equal(
      checkedParts(LATE_TEXT, late)
        .map((p) => p.text)
        .join(""),
      LATE_TEXT,
    );
  });
  test("each figure of the demo pattern finds its own source", () => {
    const f = figures(LATE_TEXT);
    assert.deepEqual(
      f.map((x) => [x.text, x.source.evidence]),
      [
        ["41", null],
        ["10", null],
        ["58.7", 0],
        ["49.4", 1],
      ],
    );
    assert.match(f[0]!.source.line, /bound of this group/);
    assert.match(f[1]!.source.line, /bound of this group/);
    assert.equal(f[2]!.source.line, "is what 72. Re3?? lost in win chance: the outlined position.");
    assert.equal(f[3]!.source.line, "is what 47. Nd4?? lost in win chance: the outlined position.");
  });
  test("two cited moves with the same cost: the first mention is the first position", () => {
    const p = { ...late, title: "Inaccuracies", evidence: [ev({ played: "fxe5", winPctLost: 10, bucket: "over50" }), ev({ played: "b5", winPctLost: 10, bucket: "over50" })] };
    const f = figures("With over 50 percent of your clock left, fxe5 cost 10 win-chance points, and b5 cost another 10 win-chance points.", p);
    assert.deepEqual(
      f.map((x) => [x.text, x.source.evidence]),
      [
        ["50", null],
        ["10", 0],
        ["10", 1],
      ],
    );
  });
  test("the group's own figures and its sample", () => {
    const f = figures("You make 5.5 here against 3 usually, 83 percent more, over 101 games and 1457 moves.");
    assert.match(f[0]!.source.line, /80 blunders in 1,457 of your moves, over 101 games/);
    assert.match(f[1]!.source.line, /your own figure/);
    assert.match(f[2]!.source.line, /from your usual 3\.0, in percent/);
    assert.match(f[3]!.source.line, /the size of this group: 101 games · 1,457 moves · 80 errors/);
    assert.equal(f[3]!.source.line, f[4]!.source.line);
  });
  test("a move number and a clock time point at their position", () => {
    const f = figures("On move 47 with 4 seconds left you played Nd4.");
    assert.deepEqual(
      f.map((x) => [x.text, x.source.evidence]),
      [
        ["47", 1],
        ["4", 1],
      ],
    );
    assert.match(f[0]!.source.line, /move number of 47\. Nd4\?\?/);
    assert.match(f[1]!.source.line, /4\.46 seconds left/);
  });
  test("an exact value beats one the number is only a rounding of", () => {
    const p = { ...late, evidence: [ev({ played: "Re3", winPctLost: 10.4 }), ev({ played: "Nd4", winPctLost: 10 })] };
    assert.equal(figures("It cost 10 win-chance points.", p)[0]!.source.evidence, 1);
  });
  test("a number the page can't place stays plain text", () => {
    const parts = checkedParts("It happened in 999 of them.", late);
    assert.deepEqual(parts, [{ kind: "text", text: "It happened in 999 of them." }]);
  });
  test("text without numbers is one part; an empty text is none", () => {
    assert.deepEqual(checkedParts("Play Kd3.", late), [{ kind: "text", text: "Play Kd3." }]);
    assert.deepEqual(checkedParts("", late), []);
  });
});

describe("sources", () => {
  test("a black move is written with an ellipsis", () => {
    assert.equal(moveLabel(ev({ moveNumber: 24, played: "Qa3", kind: "mistake", color: "black" })), "24… Qa3?");
  });
  test("the stat's source, per unit", () => {
    assert.equal(statSources(late.stat).value.line, "is this group's own rate: 80 blunders in 1,457 of your moves, over 101 games.");
    assert.equal(
      statSources({ ...late.stat, measure: "errorsPerGame", unit: "perGame", games: 1, errors: 3 }).value.line,
      "is this group's own rate: 3 errors in 1 game.",
    );
    assert.equal(statSources({ ...late.stat, measure: "scorePct", unit: "percent", errors: undefined }).value.line, "is this group's own figure, over 101 games.");
    assert.equal(statSources(late.stat).baseline.evidence, null);
  });
});
