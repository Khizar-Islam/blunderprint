"use client";

import { useState } from "react";
import type { Summary } from "@/lib/api";
import { displayOrder, edgeLabels, heatOpacity, heatSquares, severity, squareLabel, type HeatMode } from "./heat";

// The 8×8 board of where the player's errors land (the moved piece's destination square).
// 64 plain elements: cheap at this size, and each square can be a focusable button with a real
// label for screen readers. One hue (brick); the strength is how costly the square's errors
// were (heat.ts severity: blunder 3, mistake 2, inaccuracy 1), on a scale from 0, so only the
// hot spots stand out. The label still breaks the count down by kind. The view follows the
// colour filter: both / White / Black.
// Each square's heat is its opacity, in its normal style: it fades in square by square (a CSS
// animation from 0) and glides to the new strength when the filters change (a CSS transition),
// so it needs no animation frames. Hover outlines a square in ink; a press dips it.

const HEAT = "var(--color-blunder)";

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
  const cells = heatSquares(squares, mode);
  const max = Math.max(0, ...cells.map(severity));
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
                className={`relative cursor-default transition-transform duration-100 hover:z-10 hover:outline-2 hover:-outline-offset-2 hover:outline-ink active:scale-90 ${light ? "bg-square-light/60" : "bg-square-dark/35"} focus-visible:z-10`}
              >
                {cell.total > 0 && (
                  <span
                    className="anim-fade absolute inset-0 transition-opacity duration-500 [animation-duration:500ms] motion-reduce:transition-none"
                    style={{
                      backgroundColor: HEAT,
                      opacity: heatOpacity(severity(cell), max),
                      animationDelay: `${(n % 8) * 20 + Math.floor(n / 8) * 20}ms`,
                    }}
                  />
                )}
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

      {/* Two lines held (min-h-8): a long square description wraps, and a one-line height made the
          legend below jump 12 px as the pointer moved between squares. */}
      <p className="min-h-8 font-mono text-xs text-graphite" aria-live="polite">
        {focused ? `${squareLabel(focus!, mode)}: ${describe(focused)}` : max === 0 ? "No errors yet." : "Hover a square for its count."}
      </p>
      <div className="flex flex-col gap-1 text-xs text-graphite/80">
        <span className="flex items-center gap-2">
          <span
            className="h-2.5 w-24 rounded-[2px]"
            style={{ backgroundImage: `linear-gradient(to right, transparent, color-mix(in oklab, ${HEAT} 90%, transparent))` }}
            aria-hidden="true"
          />
          darker = more costly errors
        </span>
        <span className="text-graphite/60">A blunder counts 3, a mistake 2, an inaccuracy 1.</span>
      </div>
    </figure>
  );
}
