"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { ErrorKind, Summary } from "@/lib/api";
import { displayOrder, dominantKind, edgeLabels, heatSquares, intensity, squareLabel, type HeatMode } from "./heat";

// The 8×8 board of where the player's errors land (the moved piece's destination square).
// 64 plain elements: cheap at this size, and each square can be a focusable button with a real
// label for screen readers. Colour = the square's most common kind, strength = how many errors
// (heat.ts intensity). The view follows the colour filter: both / White / Black.

const KIND_COLOR: Record<ErrorKind, string> = {
  inaccuracy: "var(--color-inaccuracy)",
  mistake: "var(--color-mistake)",
  blunder: "var(--color-blunder)",
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const describe = (sq: { inaccuracy: number; mistake: number; blunder: number; total: number }) =>
  sq.total === 0
    ? "no errors"
    : [
        sq.blunder && plural(sq.blunder, "blunder"),
        sq.mistake && plural(sq.mistake, "mistake"),
        sq.inaccuracy && (sq.inaccuracy === 1 ? "1 inaccuracy" : `${sq.inaccuracy} inaccuracies`),
      ]
        .filter(Boolean)
        .join(", ");

export function HeatBoard({ squares, mode }: { squares: Summary["squares"]; mode: HeatMode }) {
  const reduced = useReducedMotion();
  const cells = heatSquares(squares, mode);
  const max = Math.max(0, ...cells.map((c) => c.total));
  const order = displayOrder(mode);
  const labels = edgeLabels(mode);
  const [focus, setFocus] = useState<number | null>(null);
  const focused = focus === null ? null : cells[focus]!;

  return (
    <figure className="flex w-full max-w-[22rem] flex-col gap-2">
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-display text-xl text-ink">Where it goes wrong</span>
        <span className="text-xs text-graphite/70">
          {mode === "both"
            ? "Both colours, seen from your side: Black's games are mirrored, so rank 1 is always your back rank."
            : `Your games as ${mode === "white" ? "White" : "Black"}, from your side of the board.`}
        </span>
      </figcaption>

      <p className="text-center font-mono text-[11px] tracking-wide text-graphite/60 uppercase">their side</p>
      <div className="grid grid-cols-[1rem_1fr] gap-1">
        <ol className="grid grid-rows-8 text-center font-mono text-[11px] text-graphite/60" aria-hidden="true">
          {labels.ranks.map((r) => (
            <li key={r} className="flex items-center justify-center">
              {r}
            </li>
          ))}
        </ol>
        <div className="grid aspect-square grid-cols-8 overflow-hidden rounded-sm" role="list" aria-label="Errors by square">
          {order.map((i, n) => {
            const cell = cells[i]!;
            const kind = dominantKind(cell);
            const light = (Math.floor(n / 8) + n) % 2 === 0; // top-left is a light square, like a real board
            const label = `${squareLabel(i, mode)}: ${describe(cell)}`;
            return (
              <button
                key={i}
                type="button"
                role="listitem"
                aria-label={label}
                title={label}
                onFocus={() => setFocus(i)}
                onMouseEnter={() => setFocus(i)}
                onMouseLeave={() => setFocus(null)}
                onBlur={() => setFocus(null)}
                className={`relative transition-transform duration-100 active:scale-95 ${light ? "bg-square-light/60" : "bg-square-dark/35"} focus-visible:z-10`}
              >
                {kind && (
                  <motion.span
                    className="absolute inset-0"
                    style={{ backgroundColor: KIND_COLOR[kind] }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: intensity(cell.total, max) }}
                    transition={reduced ? { duration: 0 } : { duration: 0.5, delay: (n % 8) * 0.02 + Math.floor(n / 8) * 0.02 }}
                  />
                )}
                {focus === i && <span className="absolute inset-0 outline-2 -outline-offset-2 outline-ink" />}
              </button>
            );
          })}
        </div>
        <span />
        <ol className="grid grid-cols-8 text-center font-mono text-[11px] text-graphite/60" aria-hidden="true">
          {labels.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ol>
      </div>
      <p className="text-center font-mono text-[11px] tracking-wide text-graphite/60 uppercase">your side</p>

      <p className="min-h-5 font-mono text-xs text-graphite" aria-live="polite">
        {focused ? `${squareLabel(focus!, mode)}: ${describe(focused)}` : max === 0 ? "No errors yet." : "Hover a square for its count."}
      </p>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-graphite/80">
        {(["blunder", "mistake", "inaccuracy"] as const).map((k) => (
          <li key={k} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-[2px]" style={{ backgroundColor: KIND_COLOR[k] }} />
            {k === "blunder" ? "mostly blunders" : k === "mistake" ? "mostly mistakes" : "mostly inaccuracies"}
          </li>
        ))}
        <li className="text-graphite/60">paler = fewer</li>
      </ul>
    </figure>
  );
}
