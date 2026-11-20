import type { ErrorKind, Summary } from "@/lib/api";
import { errorKindAt } from "./geometry";

// What the print and the heat board tell each other while the pointer is on one of them
// (PatternsDashboard holds it): the error under the pointer in the print, or the board square.

type Ribbon = Summary["ribbons"][number];

// One error of one game, as the print knows it from the summary's marks.
export interface MarkInfo {
  gameId: string;
  color: "white" | "black";
  playedAt: string;
  speed: Ribbon["speed"];
  ply: number;
  kind: ErrorKind;
  square: string; // where the move landed, on the real board
  san: string;
  winDrop: number;
}

// The game's marks by ply (empty when the API sent none: summary v2, or features not extracted).
export function marksByPly(ribbon: Ribbon): Map<number, { square: string; san: string; winDrop: number }> {
  return new Map((ribbon.marks ?? []).map(([ply, square, san, winDrop]) => [ply, { square, san, winDrop }]));
}

// The error at `ply` of a game, or null when that ply isn't an error of the player's or its mark
// isn't known.
export function markInfoAt(ribbon: Ribbon, ply: number | null): MarkInfo | null {
  if (ply === null) return null;
  const kind = errorKindAt(ribbon.classes, ply, ribbon.color);
  const mark = (ribbon.marks ?? []).find((m) => m[0] === ply);
  if (!kind || !mark) return null;
  return {
    gameId: ribbon.gameId,
    color: ribbon.color,
    playedAt: ribbon.playedAt,
    speed: ribbon.speed,
    ply,
    kind,
    square: mark[1],
    san: mark[2],
    winDrop: mark[3],
  };
}

// "??" after a blunder, "?" a mistake, "?!" an inaccuracy: the usual annotation signs.
export const GLYPH: Record<ErrorKind, string> = { blunder: "??", mistake: "?", inaccuracy: "?!" };
export const annotated = (san: string, kind: ErrorKind) => `${san}${GLYPH[kind]}`;
