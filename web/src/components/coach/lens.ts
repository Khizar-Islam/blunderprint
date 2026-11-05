import type { CoachEvidence } from "@/lib/api";
import { TICK_COLOR, tickAt, type Color } from "../patterns/geometry";

// The "fingerprint lens": a pattern card's strip of its evidence games' move ribbons, in the
// Blunderprint's own language (one tick per ply, only the player's errors coloured, opponent
// moves faint), with the evidence move ringed. Its maths lives here so it can be tested.
//
// Unlike the Blunderprint, the strip isn't cut at 120 plies: it has only 2-4 rows, so every row
// is drawn whole on one shared scale (the longest game fills the width), and an evidence move
// late in a long game is still on the strip.

export interface LensRow {
  gameId: string;
  ply: number; // the evidence move (1-based)
  color: Color;
  ribbon: string; // one letter per ply (b/g/i/m/x)
}

// The evidence that can be drawn: a ribbon and a colour, and the ply inside the ribbon.
export function lensRows(evidence: CoachEvidence[]): LensRow[] {
  return evidence
    .filter((e): e is CoachEvidence & { ribbon: string; color: Color } => !!e.ribbon && !!e.color && e.ply >= 1 && e.ply <= e.ribbon.length)
    .map((e) => ({ gameId: e.gameId, ply: e.ply, color: e.color, ribbon: e.ribbon }));
}

// Plies on the shared scale: the longest row.
export const lensPlies = (rows: LensRow[]) => Math.max(1, ...rows.map((r) => r.ribbon.length));

// The tick's left edge and width, in the strip's own units (0…width).
export function tickBox(ply: number, plies: number, width: number): { x: number; w: number } {
  const w = width / plies;
  return { x: (ply - 1) * w, w };
}

// Every tick of a row with its colour (the Blunderprint's palette, as hex for SVG).
export function rowTicks(row: LensRow): { ply: number; color: string }[] {
  return Array.from(row.ribbon, (_, i) => ({ ply: i + 1, color: TICK_COLOR[tickAt(row.ribbon, i + 1, row.color)] }));
}
