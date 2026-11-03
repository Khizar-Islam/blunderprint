import { Chess } from "chess.js";
import type { Board64 } from "./phase.js";

// FEN normalization (CLAUDE.md 8.4), used everywhere positions are compared: our games from
// both sites, and (Stage 4) the positionStats built from the Lichess database.
//
// A FEN has 6 fields: pieces, side to move, castling rights, en-passant square, halfmove
// clock, fullmove number. Two games reach "the same position" when the first four match, so:
// - the two move counters are dropped (how you got there doesn't change the position);
// - the en-passant square is kept only when an en-passant capture is actually legal. FEN
//   writers differ here: some write it after every double pawn push, some only when a pawn
//   could take. Without this, identical positions from different sources wouldn't match and
//   position lookups would silently miss.
//
// "Legal", not just "a pawn stands next to it": a capture that would leave your own king in
// check (a pinned pawn, or the two pawns leaving a rank with king and rook) doesn't count.

const fields = (fen: string) => fen.trim().split(/\s+/);

// Normalize any FEN (4 to 6 fields). Throws on a FEN chess.js can't load.
export function normalizeFen(fen: string): string {
  const [pieces, turn, castling, ep] = fields(fen);
  if (!pieces || !turn || !castling || !ep) throw new Error(`Invalid FEN: ${fen}`);
  // Loading it validates it (chess.js throws on a malformed FEN), even when there's no
  // en-passant square to check. Replays use normalizedFenOf, which skips this second load.
  const chess = new Chess(`${pieces} ${turn} ${castling} ${ep} 0 1`);
  return `${pieces} ${turn} ${castling} ${ep !== "-" && hasLegalEnPassant(chess) ? ep : "-"}`;
}

// The same, for a position we're already replaying: no second chess.js instance, and the
// legal-move check only runs when there is an en-passant square to check.
export function normalizedFenOf(chess: Chess): string {
  const [pieces, turn, castling, ep] = fields(chess.fen());
  const keepEp = ep !== "-" && hasLegalEnPassant(chess);
  return `${pieces} ${turn} ${castling} ${keepEp ? ep : "-"}`;
}

// chess.js marks an en-passant capture with the "e" flag; moves() lists legal moves only.
function hasLegalEnPassant(chess: Chess): boolean {
  return chess.moves({ verbose: true }).some((m) => m.flags.includes("e"));
}

// The position as a 64-square array for chess/phase.ts (index = file + 8 × rank, a1 = 0).
// chess.js's board() lists ranks from 8 down to 1.
export function board64(chess: Chess): Board64 {
  const out: Board64 = new Array(64).fill(null);
  chess.board().forEach((row, i) => {
    const rank = 7 - i;
    row.forEach((s, file) => {
      if (s) out[file + 8 * rank] = { color: s.color, type: s.type };
    });
  });
  return out;
}
