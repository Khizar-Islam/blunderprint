import { Chess } from "chess.js";

// Turns a stored PGN into the list of moves the engine needs, in UCI notation ("e2e4",
// "e7e8q", castling as the king's move "e1g1"). The server counted the plies from the PGN
// text at import time without checking legality (CLAUDE.md 8.1); this real replay is the check.
// If chess.js can't replay it, or gets a different number of moves, the game is reported as
// unanalysable instead of sending evals that don't line up with the moves.

export type ReplayResult =
  | { ok: true; startFen: string; moves: string[] }
  | { ok: false; error: "illegal_pgn" | "ply_mismatch"; atPly?: number };

export function replayPgn(pgn: string, expectedPlies: number): ReplayResult {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    // chess.js throws on the first illegal or unreadable move. It doesn't say which ply, so
    // atPly stays unset.
    return { ok: false, error: "illegal_pgn" };
  }
  const history = chess.history({ verbose: true });
  if (history.length !== expectedPlies) return { ok: false, error: "ply_mismatch", atPly: history.length };
  return {
    ok: true,
    // Normally the standard start position. Our importers keep standard games only, but a PGN
    // with a [FEN] header would start elsewhere, and the engine must start from the same place.
    startFen: history[0]?.before ?? chess.fen(),
    moves: history.map((m) => m.from + m.to + (m.promotion ?? "")),
  };
}
