"use client";

import { useReducedMotion } from "motion/react";
import { Chessboard } from "react-chessboard";
import type { MoveClass } from "@/lib/api";
import { isError } from "./classes";

// A view-only board (react-chessboard, MIT). Stone squares from our palette, not Chess.com's
// green or Lichess's brown, and coordinates in our palette too (react-chessboard's default
// labels are Lichess-style browns, #B58863 / #F0D9B5): graphite on the light squares and ink on
// the dark ones, in Geist Mono. Dark labels on both because the dark stone (#8C8675) is a
// mid-tone: bone on it is only ~2.8:1 contrast, ink ~4.5:1. The last move's two squares are tinted: in its classification colour
// when it was an inaccuracy/mistake/blunder, otherwise a faint ink tint.

export interface BoardArrow {
  from: string;
  to: string;
  color: string; // hex: react-chessboard draws arrows as SVG attributes, where var() doesn't work
}

// Inline CSS (not SVG attributes), so the palette's CSS variables work here.
const NOTATION_ON_LIGHT = { color: "color-mix(in oklab, var(--color-graphite) 75%, transparent)" };
const NOTATION_ON_DARK = { color: "color-mix(in oklab, var(--color-ink) 85%, transparent)" };
const NOTATION_TEXT = { fontFamily: "var(--font-mono)", fontSize: "11px", userSelect: "none" as const };

const tint = (cls: MoveClass | undefined) =>
  isError(cls)
    ? `color-mix(in oklab, var(--color-${cls}) 55%, transparent)`
    : "color-mix(in oklab, var(--color-ink) 14%, transparent)";

export function Board({
  fen,
  orientation,
  lastMove,
  arrows = [],
  id = "review-board",
  animationMs = 180,
  showCoordinates = true,
}: {
  fen: string;
  orientation: "white" | "black";
  lastMove?: { from: string; to: string; cls?: MoveClass };
  arrows?: BoardArrow[];
  // Unique per board on the page (the coach page shows several).
  id?: string;
  // How long a piece takes to slide between positions.
  animationMs?: number;
  // Off on the coach's small evidence boards, where they'd crowd the squares.
  showCoordinates?: boolean;
}) {
  // Pieces slide between positions, except for visitors who asked for less motion.
  const reduced = useReducedMotion();
  const squareStyles = lastMove
    ? { [lastMove.from]: { background: tint(lastMove.cls) }, [lastMove.to]: { background: tint(lastMove.cls) } }
    : {};

  return (
    <div className="aspect-square w-full overflow-hidden rounded-sm">
      <Chessboard
        options={{
          id,
          position: fen,
          boardOrientation: orientation,
          allowDragging: false,
          allowDrawingArrows: false,
          showAnimations: !reduced,
          animationDurationInMs: animationMs,
          lightSquareStyle: { backgroundColor: "var(--color-square-light)" },
          darkSquareStyle: { backgroundColor: "var(--color-square-dark)" },
          showNotation: showCoordinates,
          lightSquareNotationStyle: NOTATION_ON_LIGHT,
          darkSquareNotationStyle: NOTATION_ON_DARK,
          alphaNotationStyle: { ...NOTATION_TEXT, position: "absolute", bottom: 1, right: 3 },
          numericNotationStyle: { ...NOTATION_TEXT, position: "absolute", top: 1, left: 3 },
          squareStyles,
          arrows: arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: a.color })),
        }}
      />
    </div>
  );
}
