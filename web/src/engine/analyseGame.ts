import { replayPgn } from "./replay";
import { ENGINE_ID, type EngineLike } from "./stockfish";
import { toWhitePov, type WhiteEval } from "./uci";

// Analyses one game with one engine and builds the body for POST /api/analysis/results.
//
// A game of N plies has N+1 positions (0 = the start). Position k gives:
//   evals[k-1]: the eval after ply k, from White's point of view (k ≥ 1)
//   best[k]:    the engine's move in that position, i.e. what it would have played as ply k+1
//               (k < N); the server compares it with the move actually played ("best").
// Positions are analysed in game order, so the move ribbon can fill tick by tick.

export interface ClaimedGame {
  id: string;
  pgn: string;
  plies: number;
}

export type AnalysisResult =
  | {
      gameId: string;
      evals: WhiteEval[];
      best: (string | null)[];
      moves: string[];
      engine: typeof ENGINE_ID;
      nodes: number;
      durationMs: number;
    }
  | { gameId: string; error: "illegal_pgn" | "ply_mismatch"; atPly?: number };

export interface AnalyseOptions {
  nodes: number;
  signal?: AbortSignal;
  // Called after each ply's eval, for live progress (ply is 1-based).
  onPly?: (ply: number, evaluation: WhiteEval) => void;
}

export async function analyseGame(
  engine: EngineLike,
  game: ClaimedGame,
  { nodes, signal, onPly }: AnalyseOptions,
): Promise<AnalysisResult> {
  const replay = replayPgn(game.pgn, game.plies);
  if (!replay.ok) return { gameId: game.id, error: replay.error, atPly: replay.atPly };

  const { startFen, moves } = replay;
  const whiteStarts = startFen.split(" ")[1] === "w";
  const started = performance.now();
  const evals: WhiteEval[] = [];
  const best: (string | null)[] = [];

  await engine.newGame();
  for (let k = 0; k <= moves.length; k++) {
    signal?.throwIfAborted();
    const result = await engine.evaluate(startFen, moves.slice(0, k), nodes);
    const whiteToMove = whiteStarts === (k % 2 === 0);
    if (k > 0) {
      const evaluation = toWhitePov(result.score, whiteToMove);
      evals.push(evaluation);
      onPly?.(k, evaluation);
    }
    if (k < moves.length) best.push(result.best);
  }

  return {
    gameId: game.id,
    evals,
    best,
    moves,
    engine: ENGINE_ID,
    nodes,
    durationMs: Math.round(performance.now() - started),
  };
}
