import { Chess } from "chess.js";

// Shared formatting for coach tool results. Two jobs:
//
// 1. Numbers in a fixed shape, so the verifier (Stage 5 chunk B) can match the model's
//    statistics against them: percentages are 0–100 with 1 decimal, never 0–1 ratios.
// 2. Text from outside our control kept out, or cleaned. Tool results go straight into the
//    model's context, and anything a stranger can type (a Lichess username, a game's
//    termination text) could carry a prompt injection: "ignore previous instructions...". So
//    tools never return opponent or player names, and the few platform strings they do return
//    (opening names, termination codes) pass through the filters below.

export const round1 = (n: number) => Math.round(n * 10) / 10;

// a ÷ b as a 0–100 percentage, 1 decimal; null when there's nothing to divide by.
export const pct = (a: number, b: number): number | null => (b > 0 ? round1((a / b) * 100) : null);

// "2026-10-01T13:45:00Z" → "2026-10-01". The model needs the day, not the second.
export const day = (d: Date | string | null | undefined): string | null =>
  d ? new Date(d).toISOString().slice(0, 10) : null;

// The move number a ply belongs to (ply 1 and 2 are move 1).
export const moveNumberOf = (ply: number) => Math.ceil(ply / 2);

// Opening names come from the platforms (the Lichess API, Chess.com's ECOUrl slug). Real ones
// are short and use letters, digits, spaces and a little punctuation ("Sicilian Defense: Najdorf
// Variation, 6.Bg5"). Anything else is dropped, and the length is capped, so an odd value can
// neither smuggle markup or quotes into the context nor run on into a paragraph of instructions.
const MAX_NAME = 80;
export function cleanOpeningName(name: string | null | undefined): string | null {
  if (!name) return null;
  const cleaned = name
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N} :,.'()\-/]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  return cleaned.length > MAX_NAME ? `${cleaned.slice(0, MAX_NAME - 1).trimEnd()}…` : cleaned;
}

// Termination: Lichess's status ("mate", "resign", "outoftime") or Chess.com's result code
// ("checkmated", "resigned", "timeout"). Only a short lowercase code passes; anything else is
// left out rather than shown.
export function cleanTermination(value: string | null | undefined): string | null {
  return value && /^[a-z_]{1,24}$/.test(value) ? value : null;
}

const PIECE_NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen" } as const;
export const pieceName = (p: string | null | undefined): string | null =>
  p && p in PIECE_NAMES ? PIECE_NAMES[p as keyof typeof PIECE_NAMES] : null;

// The engine's best move is stored as UCI ("g1f3"); the model and the player read SAN ("Nf3").
// `fen` is our normalized 4-field FEN of the position before the move; chess.js wants all 6,
// and the move counters don't change which moves are legal. null if the move isn't legal there
// (it never should be, but this is data from a browser).
export function uciToSan(fen: string, uci: string | null | undefined): string | null {
  if (!uci || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) return null;
  try {
    const chess = new Chess(fen.split(" ").length === 4 ? `${fen} 0 1` : fen);
    return chess.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch {
    return null;
  }
}
