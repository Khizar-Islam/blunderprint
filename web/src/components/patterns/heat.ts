import type { ErrorKind, SquareCount, Summary } from "@/lib/api";

// The heat board's maths, kept out of the component so it can be tested.
//
// Squares are indexed 0–63 as a1, b1 … h1, a2 … h8 (file + 8 × rank), the same order the API
// sends them in.
//
// Three views:
// - white: White's games on a normal board (a1 bottom left).
// - black: Black's games on a flipped board (h8 bottom left), as Black sees it.
// - both:  every game seen from the player's side. Black's games are rank-mirrored (rank r
//          becomes 9 − r), so "rank 2" means "the player's second rank" in every game. Files
//          stay as they are, so the kingside is on the right in both. The labels say "from
//          your side", because e2 here can be Black's e7.

export type HeatMode = "both" | "white" | "black";
export type HeatSquare = SquareCount;

export const FILES = "abcdefgh";
const KINDS_BY_SEVERITY: ErrorKind[] = ["blunder", "mistake", "inaccuracy"];

const fileOf = (i: number) => i % 8;
const rankOf = (i: number) => Math.floor(i / 8); // 0 = rank 1
export const nameOf = (i: number) => `${FILES[fileOf(i)]}${rankOf(i) + 1}`;

// The same file, the opposite rank: e7 ↔ e2.
export const mirrorRank = (i: number) => fileOf(i) + 8 * (7 - rankOf(i));

// The 64 squares to draw for a view, indexed like the API. In "both", square i is the sum of
// White's i and Black's mirrored i.
export function heatSquares(squares: Summary["squares"], mode: HeatMode): HeatSquare[] {
  if (mode === "white") return squares.white;
  if (mode === "black") return squares.black;
  return squares.white.map((w, i) => {
    const b = squares.black[mirrorRank(i)]!;
    return {
      square: w.square,
      inaccuracy: w.inaccuracy + b.inaccuracy,
      mistake: w.mistake + b.mistake,
      blunder: w.blunder + b.blunder,
      total: w.total + b.total,
    };
  });
}

// Square indices in reading order (top row left to right, then down). White and "both" put
// rank 8 at the top; Black's board is flipped, so rank 1 is at the top and the h-file on the left.
export function displayOrder(mode: HeatMode): number[] {
  const order: number[] = [];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      order.push(mode === "black" ? 8 * row + (7 - col) : 8 * (7 - row) + col);
    }
  }
  return order;
}

// The labels along the edges, top to bottom (ranks) and left to right (files).
export function edgeLabels(mode: HeatMode): { ranks: string[]; files: string[] } {
  const ranks = ["8", "7", "6", "5", "4", "3", "2", "1"];
  const files = FILES.split("");
  if (mode === "black") return { ranks: ranks.reverse(), files: files.reverse() };
  return { ranks, files };
}

// What a screen reader (and the tooltip) calls a square in this view.
export function squareLabel(i: number, mode: HeatMode): string {
  return mode === "both" ? `${nameOf(i)} from your side` : nameOf(i);
}

// The kind with the most errors on a square; a tie goes to the more severe kind. Null when empty.
export function dominantKind(sq: Pick<HeatSquare, ErrorKind>): ErrorKind | null {
  let best: ErrorKind | null = null;
  for (const kind of KINDS_BY_SEVERITY) if (sq[kind] > 0 && (best === null || sq[kind] > sq[best])) best = kind;
  return best;
}

// Fill opacity for a square: 0 when empty, otherwise 0.15–0.9 on a square-root scale. The root
// keeps a square with 1–2 errors visible next to one with 30, where a straight line would make
// it nearly invisible.
export function intensity(total: number, max: number): number {
  if (total <= 0 || max <= 0) return 0;
  return 0.15 + 0.75 * Math.sqrt(Math.min(total, max) / max);
}
