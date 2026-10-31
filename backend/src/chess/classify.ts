// Move classification, ported from Lichess so our labels mean what Lichess's mean.
//
// Sources (read 31 Oct 2026; pinned commits so the links don't drift):
// - Win chances: scalachess core/src/main/scala/eval.scala (WinPercent)
//   https://github.com/lichess-org/scalachess/blob/a4988192e6531f92c806e1603a87467c729d5db1/core/src/main/scala/eval.scala
// - Judgements: lila modules/tree/src/main/Advice.scala (CpAdvice, MateAdvice)
//   https://github.com/lichess-org/lila/blob/4dcff2a4653c092a5e333fd6843e37c5f0277882/modules/tree/src/main/Advice.scala
// - Advice only when the played move wasn't the engine's best ("info.hasVariation"), and the
//   first move is judged against a fixed start eval of +15 cp: lila modules/tree/src/main/Analysis.scala
//   and modules/tree/src/main/eval.scala (legacyInitial)
// - Accuracy per move: lila modules/analyse/src/main/AccuracyPercent.scala (fromWinPercents)
//
// Pure maths, no chess.js: it runs on Render's slow CPU in microseconds per game.

import type { Classification } from "../db/models/game.js";

// One engine evaluation from White's point of view; exactly one of cp / mate is set.
// mate > 0: White mates in N; mate < 0: Black mates in N.
// mate === 0: the side to move is checkmated (Lichess's convention, see scalachess
// WhiteScore.exportMate). Only the final position of a game can be { mate: 0 }.
export interface Eval {
  cp?: number;
  mate?: number;
}

export type Side = "white" | "black";
export type Judgement = "inaccuracy" | "mistake" | "blunder";

// lila evals.legacyInitial: the eval of the start position, used to judge the first move.
export const START_EVAL: Eval = { cp: 15 };

// A score from one side's point of view, mirroring scalachess's Score enum:
// Mate(0) means "this side is mated"; MateGiven means "this side has delivered mate".
type PovScore = { kind: "cp"; cp: number } | { kind: "mate"; moves: number } | { kind: "mateGiven" };

// Side to move after `plies` plies of a standard game (we skip non-standard starts).
export const sideToMoveAfter = (plies: number): Side => (plies % 2 === 0 ? "white" : "black");

// Who played ply n (1-based).
export const moverOfPly = (ply: number): Side => sideToMoveAfter(ply - 1);

// evalIndex = how many plies have been played when this eval was taken (0 = start position).
function toPov(e: Eval, pov: Side, evalIndex: number): PovScore {
  if (e.mate !== undefined) {
    if (e.mate === 0) return sideToMoveAfter(evalIndex) === pov ? { kind: "mate", moves: 0 } : { kind: "mateGiven" };
    return { kind: "mate", moves: pov === "white" ? e.mate : -e.mate };
  }
  const cp = e.cp ?? 0;
  return { kind: "cp", cp: pov === "white" ? cp : -cp };
}

// scalachess WinPercent.winningChances: a logistic curve fitted to real Lichess games
// (lila PR #11148). −1 = certainly losing, +1 = certainly winning. Not capped here:
// CpAdvice uses the raw cp.
export function winningChances(cp: number): number {
  const MULTIPLIER = -0.00368208;
  return 2 / (1 + Math.exp(MULTIPLIER * cp)) - 1;
}

const CP_CEILING = 1000;
const ceil = (cp: number) => Math.max(-CP_CEILING, Math.min(CP_CEILING, cp));

// scalachess WinPercent.fromScore, 0–100. cp capped at ±1000; a mate counts as ±1000 cp
// (Mate(0), being mated, counts as −1000; MateGiven as +1000).
function winPercentOf(s: PovScore): number {
  const cp = s.kind === "cp" ? ceil(s.cp) : s.kind === "mateGiven" ? CP_CEILING : s.moves > 0 ? CP_CEILING : -CP_CEILING;
  return 50 + 50 * winningChances(cp);
}

// White's win% for the eval graph (0–100).
export function whiteWinPercent(e: Eval, evalIndex: number): number {
  return winPercentOf(toPov(e, "white", evalIndex));
}

// CpAdvice thresholds on the −1…+1 win-chance scale (= 15 / 10 / 5 points of win%).
const CP_JUDGEMENTS: [number, Judgement][] = [
  [0.3, "blunder"],
  [0.2, "mistake"],
  [0.1, "inaccuracy"],
];

// Judge the move that took the game from `prev` to `next`. `ply` is that move's 1-based
// number, so prev was taken after ply − 1 plies and next after ply plies.
// Returns null when Lichess would give no judgement.
export function judgeMove(prev: Eval, next: Eval, ply: number): Judgement | null {
  const mover = moverOfPly(ply);
  const p = toPov(prev, mover, ply - 1);
  const n = toPov(next, mover, ply);

  // CpAdvice: both sides of the move are plain centipawn scores.
  if (p.kind === "cp" && n.kind === "cp") {
    const delta = winningChances(p.cp) - winningChances(n.cp); // how much the mover lost
    return CP_JUDGEMENTS.find(([threshold]) => threshold <= delta)?.[1] ?? null;
  }

  // MateAdvice: at least one side is a mate score. Lila's MateSequence, from the mover's view.
  const prevCpOrZero = p.kind === "cp" ? p.cp : 0;
  const nextCpOrZero = n.kind === "cp" ? n.cp : 0;
  const nextIsMatedOrGettingMated = n.kind === "mate" && n.moves <= 0;
  const prevHadMate = p.kind === "mate" && p.moves > 0;

  // MateCreated: from a cp position, the mover walked into a forced mate against them.
  if (p.kind === "cp" && nextIsMatedOrGettingMated) {
    if (prevCpOrZero < -999) return "inaccuracy"; // already lost anyway
    if (prevCpOrZero < -700) return "mistake";
    return "blunder";
  }
  // MateLost: the mover had a forced mate and let it go (to a cp score or to mate against them).
  if (prevHadMate && (n.kind === "cp" || nextIsMatedOrGettingMated)) {
    if (nextCpOrZero > 999) return "inaccuracy"; // still completely winning
    if (nextCpOrZero > 700) return "mistake";
    return "blunder";
  }
  // MateDelayed (mate → slower mate), mate → mate given, or the losing side's mate getting
  // longer: no judgement, same as Lichess.
  return null;
}

export interface ClassifyInput {
  // evals[i] = eval after ply i + 1 (so evals.length === plies), White's view.
  evals: Eval[];
  // Optional, from our own engine: best[i] = engine's best move (UCI) in the position before
  // ply i + 1, and moves[i] = the move actually played (UCI). When they match, the move is
  // "best" and gets no judgement, like lila's hasVariation check.
  best?: (string | null)[];
  moves?: string[];
  // Imported Lichess games: Lichess's own judgement per ply (null = none), used as is.
  // Why not recompute them from the evals: Lichess gives no judgement when the played move
  // was the engine's best (lila's hasVariation check), even if the eval moved past a
  // threshold between search depths, and its export only says which move was best on the
  // judged plies. On 3 real games (301 plies) our formula matched all 50 of Lichess's
  // judgements but added 3 extra inaccuracies, exactly on such best-move plies. See classify.test.ts.
  judgments?: (Judgement | null)[];
}

// One label per ply: best / good / inaccuracy / mistake / blunder.
export function classifyGame({ evals, best, moves, judgments }: ClassifyInput): Classification[] {
  if (judgments) return evals.map((_, i) => judgments[i] ?? "good");
  return evals.map((next, i) => {
    const ply = i + 1;
    const bestMove = best?.[i];
    if (bestMove && moves?.[i] === bestMove) return "best";
    const prev = i === 0 ? START_EVAL : evals[i - 1]!;
    return judgeMove(prev, next, ply) ?? "good";
  });
}

// lila AccuracyPercent.fromWinPercents: 100 when the move didn't lose win%, otherwise a curve
// fitted to real games (+1 "uncertainty bonus"), clamped to 0–100.
export function moveAccuracy(winBefore: number, winAfter: number): number {
  if (winAfter >= winBefore) return 100;
  const winDiff = winBefore - winAfter;
  const raw = 103.1668100711649 * Math.exp(-0.04354415386753951 * winDiff) - 3.166924740191411 + 1;
  return Math.min(100, Math.max(0, raw));
}

// The plain mean of one side's per-move accuracies, rounded to 0.1. Lichess's own game
// accuracy also weights moves by volatility (a harmonic + weighted mean); we don't, so this
// is labelled "average move accuracy". undefined when the side made no moves.
export function averageAccuracy(evals: Eval[], side: Side): number | undefined {
  let sum = 0;
  let count = 0;
  evals.forEach((next, i) => {
    const ply = i + 1;
    if (moverOfPly(ply) !== side) return;
    const prev = i === 0 ? START_EVAL : evals[i - 1]!;
    const before = winPercentOf(toPov(prev, side, ply - 1));
    const after = winPercentOf(toPov(next, side, ply));
    sum += moveAccuracy(before, after);
    count++;
  });
  return count === 0 ? undefined : Math.round((sum / count) * 10) / 10;
}
