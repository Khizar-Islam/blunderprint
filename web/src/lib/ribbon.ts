import type { MoveClass } from "./api";

// The move ribbon under each game row: one tick per ply, coloured by classification. Drawn as
// ONE CSS linear-gradient with hard stops instead of one element per tick, because 200 rows ×
// ~80 plies would be 16,000 DOM nodes. Runs of the same colour merge into one stop pair.

// Only the imported player's own moves carry colour: the Blunderprint is about their habits.
// Their good/best moves are dark stone ticks, the opponent's moves faint light stone, so the
// player's moves read as a dotted texture and their mistakes stand out. The full palette
// (best = teal) is for the game review page. Colours are the @theme tokens in globals.css.
const COLOR: Record<MoveClass, string> = {
  best: "var(--color-square-dark)",
  good: "var(--color-square-dark)",
  inaccuracy: "var(--color-inaccuracy)",
  mistake: "var(--color-mistake)",
  blunder: "var(--color-blunder)",
};
const OPPONENT = "var(--color-square-light)";
const EVALUATED = "var(--color-square-dark)"; // analysed but not yet classified (live)
const EMPTY = "transparent";

const pct = (n: number) => `${Math.round(n * 10_000) / 100}%`;

function gradient(colors: string[]): string {
  if (colors.length === 0) return "none";
  const stops: string[] = [];
  let start = 0;
  for (let i = 1; i <= colors.length; i++) {
    if (i === colors.length || colors[i] !== colors[start]) {
      stops.push(`${colors[start]} ${pct(start / colors.length)} ${pct(i / colors.length)}`);
      start = i;
    }
  }
  return `linear-gradient(to right, ${stops.join(", ")})`;
}

// A classified game, seen from the imported player's side. Ply 1 (index 0) is White's move;
// our importers keep standard games only, so White always moves first.
export function classifiedRibbon(classifications: MoveClass[], player: "white" | "black"): string {
  const playerParity = player === "white" ? 0 : 1;
  return gradient(classifications.map((c, i) => (i % 2 === playerParity ? COLOR[c] : OPPONENT)));
}

// A game the engine is working on: the first `evaluated` of `plies` ticks filled.
export function progressRibbon(evaluated: number, plies: number): string {
  if (plies <= 0) return "none";
  const done = Math.max(0, Math.min(evaluated, plies));
  return gradient(Array.from({ length: plies }, (_, i) => (i < done ? EVALUATED : EMPTY)));
}
