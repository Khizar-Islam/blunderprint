import { Chess } from "chess.js";

// The game as a list of plies, built once from the PGN: the board, the move list and the eval
// graph all index into it. Index 0 of `fens` is the start position, fens[k] the position after
// ply k, so "ply k" (1-based) is the move from fens[k − 1] to fens[k].

export interface Ply {
  san: string; // "Nf3", "exd5", "O-O", "e8=Q+"
  uci: string; // "g1f3"
  from: string;
  to: string;
  color: "white" | "black"; // who played it
}

export interface Timeline {
  fens: string[]; // plies.length + 1 positions
  plies: Ply[];
}

// null when chess.js can't replay the PGN (the review page then shows the PGN can't be read).
export function buildTimeline(pgn: string): Timeline | null {
  const chess = new Chess();
  try {
    chess.loadPgn(pgn);
  } catch {
    return null;
  }
  const history = chess.history({ verbose: true });
  return {
    fens: history.length ? [history[0]!.before, ...history.map((m) => m.after)] : [chess.fen()],
    plies: history.map((m) => ({
      san: m.san,
      uci: m.from + m.to + (m.promotion ?? ""),
      from: m.from,
      to: m.to,
      color: m.color === "w" ? "white" : "black",
    })),
  };
}

// The engine's best move (UCI) in SAN, for "Better was Nf3". null if it isn't legal there
// (it always should be; the browser engine produced it from this very position).
export function uciToSan(fen: string, uci: string): string | null {
  try {
    const move = new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return move.san;
  } catch {
    return null;
  }
}
