// The square a move started from, worked out from the position (FEN) and the move's SAN
// ("Nd4" → "f3"), without replaying anything.
//
// Why not chess.js: the dashboard summary needs it for up to 128 moves per request (each
// square's worst move, to draw the arrow of the move played), and on Render's CPU a chess.js
// load + move costs milliseconds each. This is plain geometry on the 64 squares.
//
// It does NOT check pins. That only matters when two pieces of the same kind could reach the
// square and SAN names neither because one of them is pinned: then the answer isn't certain and
// this returns null (the caller draws no arrow) rather than guess. sanFrom.test.ts checks every
// answer against chess.js over thousands of positions.

const FILES = "abcdefgh";
type Board = (string | undefined)[]; // index = file + 8 × rank (a1 = 0); "P" white pawn, "p" black

function readBoard(fen: string): { board: Board; white: boolean } | null {
  const [placement, side] = fen.split(" ");
  if (!placement || (side !== "w" && side !== "b")) return null;
  const rows = placement.split("/");
  if (rows.length !== 8) return null;
  const board: Board = new Array(64).fill(undefined);
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]!) {
      if (ch >= "1" && ch <= "8") file += Number(ch);
      else {
        if (file > 7) return null;
        board[file + 8 * (7 - r)] = ch;
        file++;
      }
    }
  }
  return { board, white: side === "w" };
}

const name = (i: number) => `${FILES[i % 8]}${Math.floor(i / 8) + 1}`;

const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]] as const;
const DIAGONAL = [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const;
const STRAIGHT = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

// Can the piece on `from` reach `to` by its own way of moving, with nothing in between?
function reaches(board: Board, piece: string, from: number, to: number): boolean {
  const df = (to % 8) - (from % 8);
  const dr = Math.floor(to / 8) - Math.floor(from / 8);
  if (df === 0 && dr === 0) return false;
  if (piece === "N") return KNIGHT.some(([f, r]) => f === df && r === dr);
  if (piece === "K") return Math.abs(df) <= 1 && Math.abs(dr) <= 1;
  const lines = piece === "B" ? DIAGONAL : piece === "R" ? STRAIGHT : [...DIAGONAL, ...STRAIGHT];
  const step = [Math.sign(df), Math.sign(dr)] as const;
  const straight = df === 0 || dr === 0;
  const diagonal = Math.abs(df) === Math.abs(dr);
  if (!(straight || diagonal) || !lines.some(([f, r]) => f === step[0] && r === step[1])) return false;
  for (let sq = from + step[0] + 8 * step[1]; sq !== to; sq += step[0] + 8 * step[1]) if (board[sq]) return false;
  return true;
}

export function sanFrom(fen: string, san: string): string | null {
  const pos = readBoard(fen);
  if (!pos) return null;
  const { board, white } = pos;
  const own = (ch: string | undefined, piece: string) => ch === (white ? piece : piece.toLowerCase());
  const clean = san.replace(/[+#!?]/g, "");

  if (clean === "O-O" || clean === "O-O-O") {
    const king = white ? 4 : 60; // e1 / e8
    return own(board[king], "K") ? name(king) : null;
  }

  const m = /^([KQRBN])?([a-h])?([1-8])?x?([a-h][1-8])(?:=[QRBN])?$/.exec(clean);
  if (!m) return null;
  const [, piece, fromFile, fromRank, dest] = m;
  const to = FILES.indexOf(dest![0]!) + 8 * (Number(dest![1]) - 1);

  if (!piece) {
    const back = white ? -8 : 8;
    if (fromFile && fromFile !== dest![0]) {
      // A capture (en passant too): one rank back, on the file SAN names.
      const from = FILES.indexOf(fromFile) + 8 * Math.floor((to + back) / 8);
      return from >= 0 && from < 64 && own(board[from], "P") ? name(from) : null;
    }
    const one = to + back;
    if (one < 0 || one > 63) return null;
    if (own(board[one], "P")) return name(one);
    const two = one + back;
    const startRank = white ? 1 : 6;
    if (!board[one] && two >= 0 && two < 64 && Math.floor(two / 8) === startRank && own(board[two], "P")) return name(two);
    return null;
  }

  const candidates: number[] = [];
  for (let sq = 0; sq < 64; sq++) {
    if (!own(board[sq], piece)) continue;
    if (fromFile && FILES[sq % 8] !== fromFile) continue;
    if (fromRank && Math.floor(sq / 8) + 1 !== Number(fromRank)) continue;
    if (reaches(board, piece, sq, to)) candidates.push(sq);
  }
  return candidates.length === 1 ? name(candidates[0]!) : null;
}
