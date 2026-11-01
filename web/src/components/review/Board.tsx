"use client";

import { useReducedMotion } from "motion/react";
import { Chessboard } from "react-chessboard";
import type { MoveClass } from "@/lib/api";
import { isError } from "./classes";

// A view-only board (react-chessboard, MIT). Stone squares from our palette, not Chess.com's
// green or Lichess's brown. The last move's two squares are tinted: in its classification colour
// when it was an inaccuracy/mistake/blunder, otherwise a faint ink tint.

export interface BoardArrow {
  from: string;
  to: string;
  color: string; // hex: react-chessboard draws arrows as SVG attributes, where var() doesn't work
}

const tint = (cls: MoveClass | undefined) =>
  isError(cls)
    ? `color-mix(in oklab, var(--color-${cls}) 55%, transparent)`
    : "color-mix(in oklab, var(--color-ink) 14%, transparent)";

export function Board({
  fen,
  orientation,
  lastMove,
  arrows = [],
}: {
  fen: string;
  orientation: "white" | "black";
  lastMove?: { from: string; to: string; cls?: MoveClass };
  arrows?: BoardArrow[];
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
          id: "review-board",
          position: fen,
          boardOrientation: orientation,
          allowDragging: false,
          allowDrawingArrows: false,
          showAnimations: !reduced,
          animationDurationInMs: 180,
          lightSquareStyle: { backgroundColor: "var(--color-square-light)" },
          darkSquareStyle: { backgroundColor: "var(--color-square-dark)" },
          squareStyles,
          arrows: arrows.map((a) => ({ startSquare: a.from, endSquare: a.to, color: a.color })),
        }}
      />
    </div>
  );
}
