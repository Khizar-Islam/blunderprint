import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "./tools/candidates.js";
import {
  allowedProseNumbers,
  candidatesIn,
  checkProse,
  examplesIn,
  filtersCover,
  labelNumbersIn,
  matchesValue,
  numbersIn,
  numberWordsIn,
  proseNumbers,
  withoutUnbackedSentences,
  type ToolLog,
} from "./verifier.js";

describe("matchesValue: the model may drop digits, never change them", () => {
  it("rounding the data is fine", () => {
    assert.equal(matchesValue(12, 12.04), true); // "12%" for 12.04
    assert.equal(matchesValue(12, 12.5), true); // 12.5 rounds to 12 or 13: both within half a unit
    assert.equal(matchesValue(12.5, 12.46), true);
    assert.equal(matchesValue(13.3, 13.3), true);
    assert.equal(matchesValue(0.25, 0.25), true);
  });
  it("a different number is not", () => {
    assert.equal(matchesValue(12.4, 12.04), false); // looks close, but the model wrote a digit that isn't there
    assert.equal(matchesValue(12, 12.6), false);
    assert.equal(matchesValue(41.5, 41.2), false);
    assert.equal(matchesValue(13, 12.4), false);
  });
});

describe("numbersIn", () => {
  it("every number at any depth, none from inside strings", () => {
    assert.deepEqual(numbersIn({ a: 1, b: [2, { c: 3.5 }], d: "12 games", e: null, f: true }), [1, 2, 3.5]);
  });
});

describe("candidatesIn: the candidates this run's get_weakness_candidates calls returned", () => {
  const c = (id: string) => ({ id, exampleFilter: {} }) as unknown as Candidate;
  it("by id, from successful calls only", () => {
    const log: ToolLog = new Map([
      [1, { ok: true, tool: "get_player_profile", data: { candidates: [c("not-a-candidate")] } }],
      [2, { ok: true, tool: "get_weakness_candidates", data: { candidates: [c("phase=endgame"), c("eco=B06")] } }],
      [3, { ok: false, tool: "get_weakness_candidates" }],
    ]);
    assert.deepEqual([...candidatesIn(log).keys()], ["phase=endgame", "eco=B06"]);
  });
});

describe("filtersCover: the evidence step must select the candidate's group", () => {
  it("the same filters, or narrower ones, cover it", () => {
    assert.equal(filtersCover({ phase: "endgame", kind: "blunder" }, { phase: "endgame", kind: "blunder" }), true);
    assert.equal(filtersCover({ phase: "endgame", kind: "blunder", clockBucket: "under10" }, { phase: "endgame", kind: "blunder" }), true);
  });
  it("broader or different filters don't", () => {
    assert.equal(filtersCover({ phase: "endgame" }, { phase: "endgame", kind: "blunder" }), false, "all endgame errors, not just blunders");
    assert.equal(filtersCover({ phase: "middlegame", kind: "blunder" }, { phase: "endgame", kind: "blunder" }), false);
    assert.equal(filtersCover({}, { eco: "B06" }), false);
  });
});

describe("examplesIn: the evidence step must be a find_example_mistakes result", () => {
  const log: ToolLog = new Map([
    [1, { ok: true, tool: "get_mistake_breakdown", data: { rows: [] } }],
    [2, { ok: true, tool: "find_example_mistakes", data: { filters: { phase: "endgame" }, examples: [{ gameId: "a", ply: 12 }, { gameId: "b", ply: 30 }] } }],
    [3, { ok: false, tool: "find_example_mistakes" }],
  ]);
  it("its examples, as gameId:ply keys", () => {
    const r = examplesIn(log, 2);
    assert.ok("keys" in r);
    assert.deepEqual([...r.keys], ["a:12", "b:30"]);
    assert.deepEqual(r.filters, { phase: "endgame" });
  });
  it("another tool, a failed call or a missing step is a problem", () => {
    assert.deepEqual(examplesIn(log, 1), { problem: "evidenceStep 1 is a get_mistake_breakdown result, not find_example_mistakes" });
    assert.deepEqual(examplesIn(log, 3), { problem: "evidenceStep 3 was a failed find_example_mistakes call" });
    assert.deepEqual(examplesIn(log, 9), { problem: "evidenceStep 9 doesn't exist" });
  });
});

describe("numbers in the prose", () => {
  it("proseNumbers: numbers in digits, not the digits of squares or moves", () => {
    assert.deepEqual(proseNumbers("You make 16.2 errors per 100 moves, 70% of them on moves 21-30."), [16.2, 70, 21, 30], "'per 100' is the unit");
    assert.deepEqual(proseNumbers("100 games, per-100 rate"), [100], "a bare 100 is still a figure");
    assert.deepEqual(proseNumbers("After Nf3 and e4 you play Qxf7+ on f7."), []);
    assert.deepEqual(proseNumbers("Ends with 16.2."), [16.2]);
  });

  // A candidate (its own figures) and the result its evidence came from.
  const candidate = {
    id: "phase=endgame|clockBucket=under10",
    value: 11.8,
    baseline: 9.5,
    gapPct: 24,
    games: 60,
    moves: 2680,
    errors: 317,
    exampleFilter: { phase: "endgame", clockBucket: "under10" },
  } as unknown as Candidate;
  // The examples result's fields the prose may use: its filters (for bucket bounds) and match counts.
  const step = { filters: { phase: "endgame", clockBucket: "under10" }, matchingErrors: 122, matchingGames: 60 };
  // A pattern's evidence items (move number, win % lost, clock), by move number.
  const item = (moveNumber: number, winPctLost = 60.3, clockLeftSeconds: number | null = 7) => ({
    moveNumber,
    winPctLost,
    facts: { clockLeftSeconds, clockBucket: clockLeftSeconds === null ? null : "under10" },
  });
  const pattern = (explanation: string, drill = "Practise rook endgames.") => ({ explanation, drill });
  const allowed = (_p: unknown, moves: number[] = []) => allowedProseNumbers(candidate, step, moves.map((m) => item(m)));

  it("a wrong number is caught", () => {
    const p = pattern("You make over 300 mistakes and blunders in the endgame.");
    assert.deepEqual(checkProse(p, allowed(p)), [{ field: "explanation", value: 300 }]);
    const drill = pattern("Fine.", "Do 25 endgame puzzles a day.");
    assert.deepEqual(checkProse(drill, allowed(drill)), [{ field: "drill", value: 25 }]);
  });

  it("only named fields back a number: '5 seconds per move' isn't backed by some 5 elsewhere in the results", () => {
    // The real run-5 drill. A 5 was somewhere in that examples result (another example's
    // field), but in none of the fields a number may come from.
    const p = pattern("Fine.", "Practice with a timer set to 5 seconds per move.");
    assert.deepEqual(checkProse(p, allowedProseNumbers(candidate, step, [item(59, 60.3, 7)])), [{ field: "drill", value: 5 }]);
  });

  it("an evidence item's move number, win % lost and clock left (seconds) are fine; another example's aren't", () => {
    const ev = [item(59, 60.3, 7), item(47, 49.4, 12)];
    const ok = pattern("At move 59 you had 7 seconds left and the move cost 60.3 points; at move 47, 12 seconds and 49.4.");
    assert.deepEqual(checkProse(ok, allowedProseNumbers(candidate, step, ev)), []);
    const other = pattern("With 3 seconds left at move 72 it cost 58.7.");
    assert.deepEqual(checkProse(other, allowedProseNumbers(candidate, step, ev)), [
      { field: "explanation", value: 3 },
      { field: "explanation", value: 72 },
      { field: "explanation", value: 58.7 },
    ]);
  });

  it("without a candidate or an examples step, only the evidence's own numbers are left", () => {
    assert.deepEqual(allowedProseNumbers(undefined, undefined, [item(59, 60.3, null)]), [59, 60.3]);
  });

  it("correct numbers pass: the candidate's figures and its examples' match counts, rounded the honest way", () => {
    const p = pattern("You make 11.8 errors per 100 endgame moves: 317 in all, 122 blunders across 60 games.");
    assert.deepEqual(checkProse(p, allowed(p)), []);
    const rounded = pattern("About 12 errors per 100 endgame moves.");
    assert.deepEqual(checkProse(rounded, allowed(rounded)), []);
  });

  it("bucket labels in the candidate's filter back their bounds; other strings don't", () => {
    assert.deepEqual(labelNumbersIn({ a: "under10", b: ["from25to50", "21-30", "41+"], c: "Sicilian 99 Variation", d: "over50" }), [10, 25, 50, 21, 30, 41, 50]);
    const p = pattern("You blunder with under 10% of your clock left.");
    assert.deepEqual(checkProse(p, allowed(p)), []);
    const name = pattern("Like the 99 in your opening's name.");
    assert.deepEqual(checkProse(name, allowed(name)), [{ field: "explanation", value: 99 }]);
  });

  it("move numbers of the pattern's evidence are fine", () => {
    const p = pattern("Your blunder on move 59 is typical.");
    assert.deepEqual(checkProse(p, allowed(p, [59])), []);
    assert.deepEqual(checkProse(pattern("Your blunder on move 61 is typical."), allowed(pattern(""), [59])), [{ field: "explanation", value: 61 }]);
  });

  it("final trim: only the sentences with unbacked numbers go", () => {
    const p = pattern("");
    assert.equal(
      withoutUnbackedSentences("You blunder in endgames. It happens 300 times! You make 11.8 errors per 100 moves.", allowed(p)),
      "You blunder in endgames. You make 11.8 errors per 100 moves.",
    );
  });

  it("number words are caught: they can't be checked against the data", () => {
    assert.deepEqual(numberWordsIn("Under ten percent of your clock, twice as often, in half your games, one of them."), ["ten", "twice", "half", "one"]);
    assert.deepEqual(numberWordsIn("Three hundred blunders; a double or triple loss."), ["three", "hundred", "double", "triple"]);
    assert.deepEqual(numberWordsIn("Someone, alone, often: no number words inside other words."), []);
    const p = pattern("With under ten percent of the clock left, you blunder.", "Play twice as slowly.");
    assert.deepEqual(checkProse(p, allowed(p)), [
      { field: "explanation", word: "ten" },
      { field: "drill", word: "twice" },
    ]);
  });

  it("chess terms that only look like numbers are fine", () => {
    assert.deepEqual(numberWordsIn("A double attack, a double-check, the half-open file."), []);
  });

  it("final trim removes sentences with number words too", () => {
    assert.equal(
      withoutUnbackedSentences("You panic late. With under ten percent left, you blunder. Slow down at move 59.", allowed(pattern(""), [59])),
      "You panic late. Slow down at move 59.",
    );
  });
});
