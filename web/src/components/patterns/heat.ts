import type { ErrorKind, SquareCount, Summary, WorstMove } from "@/lib/api";

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
// worstColor: the colour the player had in the worst move's game (the side its position is
// drawn from). In "both" it can be either.
export type HeatSquare = SquareCount & { worstColor?: "white" | "black" };

export const FILES = "abcdefgh";

const fileOf = (i: number) => i % 8;
const rankOf = (i: number) => Math.floor(i / 8); // 0 = rank 1
export const nameOf = (i: number) => `${FILES[fileOf(i)]}${rankOf(i) + 1}`;

// The same file, the opposite rank: e7 ↔ e2.
export const mirrorRank = (i: number) => fileOf(i) + 8 * (7 - rankOf(i));

// The 64 squares to draw for a view, indexed like the API. In "both", square i is the sum of
// White's i and Black's mirrored i.
export function heatSquares(squares: Summary["squares"], mode: HeatMode): HeatSquare[] {
  if (mode !== "both") return squares[mode].map((sq) => (sq.worst ? { ...sq, worstColor: mode } : sq));
  return squares.white.map((w, i) => {
    const b = squares.black[mirrorRank(i)]!;
    // The costlier of the two colours' worst moves (White's on a tie).
    const fromBlack = b.worst !== undefined && (w.worst === undefined || b.worst.winDrop > w.worst.winDrop);
    const worst: WorstMove | undefined = fromBlack ? b.worst : w.worst;
    return {
      square: w.square,
      inaccuracy: w.inaccuracy + b.inaccuracy,
      mistake: w.mistake + b.mistake,
      blunder: w.blunder + b.blunder,
      total: w.total + b.total,
      ...(w.cost !== undefined && b.cost !== undefined ? { cost: Math.round((w.cost + b.cost) * 10) / 10 } : {}),
      ...(worst ? { worst, worstColor: fromBlack ? ("black" as const) : ("white" as const) } : {}),
    };
  });
}

// The board square (0–63, in this view) an error on `square` belongs to: Black's games are
// rank-mirrored in "both", like heatSquares does.
const indexOf = (square: string) => FILES.indexOf(square[0]!) + 8 * (Number(square[1]) - 1);
export function cellOf(square: string, color: "white" | "black", mode: HeatMode): number {
  const i = indexOf(square);
  return mode === "both" && color === "black" ? mirrorRank(i) : i;
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

// How costly a square's errors were: a blunder counts 3, a mistake 2, an inaccuracy 1. Plain
// counts let the many inaccuracies (which land everywhere) tint the whole board evenly; the
// weighting lets the squares where real damage happens stand out.
export const SEVERITY_WEIGHT: Record<ErrorKind, number> = { blunder: 3, mistake: 2, inaccuracy: 1 };
export const severity = (sq: Pick<HeatSquare, ErrorKind>) =>
  SEVERITY_WEIGHT.blunder * sq.blunder + SEVERITY_WEIGHT.mistake * sq.mistake + SEVERITY_WEIGHT.inaccuracy * sq.inaccuracy;

// What a square weighs on the board: the win-chance points lost there. An API still on summary
// v2 sends no cost; the weighted count stands in (only the squares' proportions matter).
export const weightOf = (sq: HeatSquare) => sq.cost ?? severity(sq);

// The weight 85% of the 64 squares stay at or under: what a busy-but-ordinary square weighs. A strong
// player's errors land almost everywhere (on the demo player the 16 costliest squares are all
// within 26% of the top one), so marks sized on the raw cost come out nearly equal and the
// board reads as a full grid of dots. Sizing on the cost ABOVE this line lets the few squares
// that really stand out do so. With few errors (most squares empty) it is 0, and the mark is
// simply area-proportional to the cost.
export const BASELINE_SHARE = 0.85;
export function baseline(weights: number[]): number {
  const sorted = [...weights].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * BASELINE_SHARE)] ?? 0;
}

// A square's mark: a brick disc. size is its diameter as a share of the square (0–1).
// - Above the baseline: the AREA grows with the cost above it (diameter = sqrt), up to
//   MARK_MAX for the costliest square, and it gets more solid.
// - At or below the baseline: a small faint dot that fades toward nothing, so "something
//   happened here" stays readable without competing.
export const MARK_MAX = 0.8;
export const MARK_MIN = 0.12;
export function markOf(weight: number, max: number, base: number): { size: number; opacity: number } {
  if (weight <= 0 || max <= 0) return { size: 0, opacity: 0 };
  const round = (n: number) => Math.round(n * 1000) / 1000;
  if (weight <= base || max <= base) return { size: MARK_MIN, opacity: round(0.3 * (weight / Math.max(base, max))) };
  const t = Math.min(1, (weight - base) / (max - base));
  return { size: round(MARK_MIN + (MARK_MAX - MARK_MIN) * Math.sqrt(t)), opacity: round(0.35 + 0.6 * t) };
}
