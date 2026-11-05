import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CoachEvidence, CoachInfo, CoachReport, CoachStat } from "./api";
import { coachButtonState, factsLine, failureAction, fenAfterMove, moveCaption, msUntilPacificMidnight, statText, uciSquares } from "./coach";

const REPORT = { id: "rep" } as CoachReport;
const info = (over: Partial<CoachInfo> = {}): CoachInfo => ({
  report: null,
  stale: false,
  staleReason: null,
  newGames: 0,
  eligibility: { analysed: 25, needed: 20, ok: true },
  activeRun: null,
  ai: { enabled: true, budgetLeft: 400, canStart: true },
  ...over,
});

describe("coachButtonState", () => {
  test("every state of the dashboard button", () => {
    assert.deepEqual(coachButtonState(null), { kind: "loading" });
    assert.deepEqual(coachButtonState(info({ eligibility: { analysed: 12, needed: 20, ok: false } })), { kind: "locked", analysed: 12, needed: 20 });
    assert.deepEqual(coachButtonState(info()), { kind: "start" });
    assert.deepEqual(coachButtonState(info({ activeRun: { runId: "r1", status: "running" }, report: REPORT })), { kind: "running", runId: "r1" });
    assert.deepEqual(coachButtonState(info({ report: REPORT })), { kind: "report", stale: null, note: null });
    assert.deepEqual(coachButtonState(info({ report: REPORT, stale: true, staleReason: "new_games", newGames: 7 })), {
      kind: "report",
      stale: { reason: "new_games", newGames: 7 },
      note: null,
    });
    assert.deepEqual(coachButtonState(info({ report: REPORT, stale: true, staleReason: "new_version" })), { kind: "report", stale: { reason: "new_version" }, note: null });
    assert.deepEqual(coachButtonState(info({ ai: { enabled: false, budgetLeft: 0, canStart: false } })), { kind: "off" });
    assert.deepEqual(coachButtonState(info({ ai: { enabled: true, budgetLeft: 3, canStart: false } })), { kind: "resting" });
  });

  test("a report stays reachable when AI is off or resting; the note only matters when it's stale", () => {
    const off = { enabled: false, budgetLeft: 0, canStart: false };
    assert.deepEqual(coachButtonState(info({ report: REPORT, ai: off })), { kind: "report", stale: null, note: null });
    assert.deepEqual(coachButtonState(info({ report: REPORT, ai: off, stale: true, staleReason: "new_games", newGames: 2 })).kind, "report");
    assert.equal((coachButtonState(info({ report: REPORT, ai: off, stale: true, staleReason: "new_games", newGames: 2 })) as { note: string }).note, "off");
  });

  test("under 20 analysed beats AI off: the first thing to fix is the games", () => {
    assert.equal(coachButtonState(info({ eligibility: { analysed: 3, needed: 20, ok: false }, ai: { enabled: false, budgetLeft: 0, canStart: false } })).kind, "locked");
  });
});

describe("statText", () => {
  const stat = (over: Partial<CoachStat> = {}): CoachStat => ({
    measure: "blunderPer100",
    value: 7.94,
    unit: "per100",
    baseline: 3.1,
    direction: "higherIsWorse",
    gapPct: 156,
    games: 15,
    moves: 190,
    errors: 31,
    ...over,
  });
  test("a rate per 100 moves", () => {
    const t = statText(stat());
    assert.equal(t.value(7.94), "7.9");
    assert.equal(t.baseline, "3.1");
    assert.equal(t.unit, "blunders per 100 moves");
    assert.equal(t.gap, "156% more than usual");
    assert.equal(t.sample, "15 games · 190 moves · 31 errors");
  });
  test("a score, where lower is worse", () => {
    const t = statText(stat({ measure: "scorePct", unit: "percent", value: 40, baseline: 75.3, direction: "lowerIsWorse", gapPct: 47, moves: undefined, errors: undefined, games: 6 }));
    assert.equal(t.value(40), "40%");
    assert.equal(t.baseline, "75%");
    assert.equal(t.unit, "score");
    assert.equal(t.gap, "47% lower than usual");
    assert.equal(t.sample, "6 games");
  });
  test("one of each is singular", () => {
    assert.equal(statText(stat({ games: 1, moves: 1, errors: 1 })).sample, "1 game · 1 move · 1 error");
  });
});

const evidence = (over: Partial<CoachEvidence> = {}): CoachEvidence => ({
  gameId: "g1",
  ply: 36,
  moveNumber: 18,
  kind: "blunder",
  played: "Rad8",
  betterMove: "Qc4",
  playedUci: "a8d8",
  betterUci: "c5c4",
  winPctLost: 40.2,
  fen: "r4rk1/pp3p1p/1np1b1p1/2q5/4PP2/2b1B1P1/PP2Q1BP/R2R3K b - -",
  color: "black",
  facts: { speed: "bullet", phase: "middlegame", clockBucket: "over50", clockLeftSeconds: 50.03, opening: { eco: "A05", name: "King's Indian Attack" } },
  ...over,
});

describe("an evidence position", () => {
  test("the caption", () => {
    assert.deepEqual(moveCaption(evidence()), { move: "Move 18…", played: "Rad8??", kind: "blunder", better: "Qc4", cost: "−40 pts win chance" });
    // Points, not percent: 69.6 points rounds to 70, and the text never says "%".
    assert.equal(moveCaption(evidence({ winPctLost: 69.6 })).cost, "−70 pts win chance");
    assert.ok(!moveCaption(evidence()).cost.includes("%"));
    assert.equal(moveCaption(evidence({ color: "white", kind: "inaccuracy", played: "Nf3" })).played, "Nf3?!");
  });
  test("the facts from code, missing ones left out", () => {
    assert.deepEqual(factsLine(evidence()), ["bullet", "middlegame", "50 s left (over half the clock left)", "A05 King's Indian Attack"]);
    assert.deepEqual(factsLine(evidence({ facts: { speed: "rapid", phase: null, clockBucket: null, clockLeftSeconds: 125, opening: { eco: "B06", name: null } } })), [
      "rapid",
      "2:05 left",
      "B06",
    ]);
    assert.deepEqual(factsLine(evidence({ facts: { speed: null, phase: null, clockBucket: null, clockLeftSeconds: null, opening: null } })), []);
  });
  test("UCI → squares, and the position after the played move", () => {
    assert.deepEqual(uciSquares("a8d8"), { from: "a8", to: "d8" });
    assert.equal(uciSquares(null), null);
    assert.equal(fenAfterMove("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -", "g1f3")!.split(" ")[0], "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R");
    // Castling moves the rook too.
    assert.equal(fenAfterMove("r3k2r/8/8/8/8/8/8/R3K2R w KQkq -", "e1g1")!.split(" ")[0], "r3k2r/8/8/8/8/8/8/R4RK1");
    assert.equal(fenAfterMove("8/8/8/8/8/8/8/K6k w - -", "a1a5"), null, "an illegal move gives null");
  });
});

describe("failureAction", () => {
  test("what each friendly code offers", () => {
    assert.equal(failureAction("ai_disabled"), "none");
    assert.equal(failureAction("ai_budget_exhausted"), "wait");
    assert.equal(failureAction("not_enough_games"), "dashboard");
    assert.equal(failureAction("player_not_found"), "import");
    assert.equal(failureAction("run_not_found"), "reload");
    for (const code of ["ai_busy", "ai_unavailable", "coach_timeout", "coach_too_long", "coach_no_answer", "coach_interrupted", "internal", "something_new", undefined]) {
      assert.equal(failureAction(code), "retry", String(code));
    }
  });
});

describe("msUntilPacificMidnight", () => {
  test("matches the backend's rule, across DST", () => {
    assert.equal(msUntilPacificMidnight(new Date("2026-11-05T15:00:00Z")), 17 * 3_600_000);
    assert.equal(msUntilPacificMidnight(new Date("2026-03-08T08:30:00Z")), 22.5 * 3_600_000);
    assert.equal(msUntilPacificMidnight(new Date("2026-11-01T07:30:00Z")), 24.5 * 3_600_000);
  });
});
