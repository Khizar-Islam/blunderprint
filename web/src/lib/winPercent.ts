// White's chance of winning (0–100) for the eval graph. A copy of whiteWinPercent in
// backend/src/chess/classify.ts (scalachess's WinPercent, sources cited there): one small pure
// function isn't worth a shared package. winPercent.test.ts checks the same values as the
// backend's tests, so the two copies can't drift apart unnoticed.

export type Eval = { cp?: number; mate?: number }; // White's view; mate 0 = the side to move is mated

// lila evals.legacyInitial: the start position's eval, the graph's first point.
export const START_EVAL: Eval = { cp: 15 };

const CP_CEILING = 1000;

export function winningChances(cp: number): number {
  return 2 / (1 + Math.exp(-0.00368208 * cp)) - 1;
}

// evalIndex = plies played when the eval was taken (0 = start), which says who is to move.
export function whiteWinPercent(e: Eval, evalIndex: number): number {
  let cp: number;
  if (e.mate !== undefined) {
    if (e.mate === 0) {
      const whiteToMove = evalIndex % 2 === 0;
      cp = whiteToMove ? -CP_CEILING : CP_CEILING; // the side to move has been mated
    } else cp = e.mate > 0 ? CP_CEILING : -CP_CEILING;
  } else cp = Math.max(-CP_CEILING, Math.min(CP_CEILING, e.cp ?? 0));
  return 50 + 50 * winningChances(cp);
}

// An eval as text, White's view: "+1.2", "−0.4", "0.0", "#3" (White mates in 3), "#-2",
// "mate" (the game ended in checkmate).
export function formatEval(e: Eval | undefined): string {
  if (!e) return "";
  if (e.mate !== undefined) return e.mate === 0 ? "mate" : `#${e.mate}`;
  const pawns = (e.cp ?? 0) / 100;
  return `${pawns > 0 ? "+" : pawns < 0 ? "−" : ""}${Math.abs(pawns).toFixed(1)}`;
}

// The graph's points: the start position, then one per ply.
export function winPercentSeries(evals: Eval[]): number[] {
  return [whiteWinPercent(START_EVAL, 0), ...evals.map((e, i) => whiteWinPercent(e, i + 1))];
}
