// Game phases (opening / middlegame / endgame), ported from Lichess so "your endgame" means
// what it means on Lichess.
//
// Source (read 3 Nov 2026; pinned commit so the link doesn't drift):
// - scalachess core/src/main/scala/Divider.scala
//   https://github.com/lichess-org/scalachess/blob/b73baa55d67b4a3013c8114d5646b6c0d233f42b/core/src/main/scala/Divider.scala
//
// The rules, on the position after each ply:
// - The middlegame starts at the first position with ≤ 10 majors + minors (queens, rooks,
//   bishops, knights of both sides), OR a sparse back rank (fewer than 4 of White's pieces on
//   rank 1, or of Black's on rank 8: pieces have been developed), OR "mixedness" > 150 (the
//   armies have run into each other, see mixedness below).
// - The endgame starts at the first position with ≤ 6 majors + minors, and only counts if
//   the game reached a middlegame. If both start on the same position, it's an endgame
//   (no middlegame).
//
// Tested against Lichess's own `division` for 200 real games (phase.test.ts).
//
// Pure: works on a 64-square array, no chess.js, so it costs microseconds per position.

export type Phase = "opening" | "middlegame" | "endgame";

// One square: the piece's colour ("w" / "b") and type (p n b r q k, as chess.js names them),
// or null when empty. Index = file + 8 × rank, so a1 = 0, h1 = 7, a8 = 56, h8 = 63.
export type Square = { color: "w" | "b"; type: "p" | "n" | "b" | "r" | "q" | "k" } | null;
export type Board64 = Square[];

// Where the middlegame and endgame begin, as positions counted in plies from the start
// (Lichess's numbers: a game whose middlegame "begins at 22" has its 22nd ply position as the
// first middlegame position). undefined = that phase never came.
export interface Division {
  middle?: number;
  end?: number;
}

const isMajorOrMinor = (s: Square) => s !== null && s.type !== "p" && s.type !== "k";

function majorsAndMinors(board: Board64): number {
  let n = 0;
  for (const s of board) if (isMajorOrMinor(s)) n++;
  return n;
}

// Divider.backrankSparse: counts every white piece on rank 1 (pawns and king included, as
// `board.white` is all white pieces) and every black piece on rank 8.
function backrankSparse(board: Board64): boolean {
  let white = 0;
  let black = 0;
  for (let file = 0; file < 8; file++) {
    if (board[file]?.color === "w") white++;
    if (board[56 + file]?.color === "b") black++;
  }
  return white < 4 || black < 4;
}

// Divider.score: how "mixed" a 2×2 region is, given how many white and black pieces are in it
// and its row y (1–7, counted from White's side). Pieces deep in the other side's half, or
// both colours in one region, score high. Copied case by case.
function score(y: number, white: number, black: number): number {
  switch (white) {
    case 0:
      switch (black) {
        case 1:
          return 1 + y;
        case 2:
          return y < 6 ? 2 + (6 - y) : 0;
        case 3:
        case 4:
          return y < 7 ? 3 + (7 - y) : 0;
        default:
          return 0;
      }
    case 1:
      switch (black) {
        case 0:
          return 1 + (8 - y);
        case 1:
          return 5 + Math.abs(4 - y);
        case 2:
          return 4 + (7 - y);
        case 3:
          return 5 + (7 - y);
        default:
          return 0;
      }
    case 2:
      switch (black) {
        case 0:
          return y > 2 ? 2 + (y - 2) : 0;
        case 1:
          return 4 + (y - 1);
        case 2:
          return 7;
        default:
          return 0;
      }
    case 3:
      switch (black) {
        case 0:
          return y > 1 ? 3 + (y - 1) : 0;
        case 1:
          return 5 + (y - 1);
        default:
          return 0;
      }
    case 4:
      return black === 0 && y > 1 ? 3 + (y - 1) : 0; // a group of 4 on the home row = 0
    default:
      return 0;
  }
}

// Divider.mixedness: the sum of score() over all 49 overlapping 2×2 regions. The region with
// its lower-left corner on (file x, rank y) gets row number y + 1 (Divider: i / 7 + 1).
function mixedness(board: Board64): number {
  let acc = 0;
  for (let y = 0; y <= 6; y++) {
    for (let x = 0; x <= 6; x++) {
      let white = 0;
      let black = 0;
      for (const sq of [x + 8 * y, x + 1 + 8 * y, x + 8 * (y + 1), x + 1 + 8 * (y + 1)]) {
        const s = board[sq];
        if (s?.color === "w") white++;
        else if (s?.color === "b") black++;
      }
      acc += score(y + 1, white, black);
    }
  }
  return acc;
}

const isMiddlegame = (b: Board64) => majorsAndMinors(b) <= 10 || backrankSparse(b) || mixedness(b) > 150;
// Exported for feature extraction, which stops building boards once the endgame has started.
export const isEndgame = (b: Board64) => majorsAndMinors(b) <= 6;

// boards[i] = the position after i plies (boards[0] is the start position).
// Divider.apply: the first index matching each rule; the middlegame is dropped when the
// endgame starts at or before it.
export function divide(boards: Board64[]): Division {
  const middle = boards.findIndex(isMiddlegame);
  const end = middle === -1 ? -1 : boards.findIndex(isEndgame);
  const division: Division = {};
  if (middle !== -1 && (end === -1 || middle < end)) division.middle = middle;
  if (end !== -1) division.end = end;
  return division;
}

// The phase a move was played in: the phase of the position it was played FROM (the position
// after ply − 1 plies). A move that starts the endgame by trading queens was still played in
// the middlegame.
export function phaseOfPly(division: Division, ply: number): Phase {
  const from = ply - 1;
  if (division.end !== undefined && from >= division.end) return "endgame";
  if (division.middle !== undefined && from >= division.middle) return "middlegame";
  return "opening";
}
