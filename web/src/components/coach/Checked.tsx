"use client";

import type { ReactNode } from "react";
import type { Source } from "@/lib/checked";

// A figure on a pattern card that can say where it comes from (lib/checked.ts). It looks like
// the figures in a coach answer (Figure.tsx): Geist Mono on a teal rule, drawn in once when the
// card is revealed. Pointing at it, focusing it or tapping it hands its source to the card,
// which shows it in one line and outlines the position the figure belongs to.
// A real <button>: reachable by keyboard, and `describedBy` (the card's source line) is read
// after the number by a screen reader.

export interface Shown {
  text: string; // the figure as written ("49.4")
  source: Source;
}

export function Checked({
  text,
  source,
  onSource,
  animate,
  delayMs = 0,
  describedBy,
  className = "font-mono text-[0.86em] font-medium tracking-tight",
  children,
}: {
  text: string;
  source: Source;
  onSource: (shown: Shown | null) => void;
  animate: boolean;
  delayMs?: number;
  describedBy?: string;
  className?: string;
  children?: ReactNode; // what to draw instead of the text (the big number counts up)
}) {
  const on = () => onSource({ text, source });
  const off = () => onSource(null);
  return (
    <button
      type="button"
      data-checked
      aria-describedby={describedBy}
      className={`figure-rule cursor-help rounded-[2px] text-ink tabular-nums transition-colors hover:bg-best/15 active:bg-best/30 ${className} ${animate ? "figure-in" : ""}`}
      style={animate ? { animationDelay: `${delayMs}ms` } : undefined}
      onPointerEnter={on}
      onPointerLeave={off}
      onFocus={on}
      onBlur={off}
      onClick={on}
    >
      {children ?? text}
    </button>
  );
}
