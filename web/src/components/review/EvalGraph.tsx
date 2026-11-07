"use client";

import { useRef } from "react";
import type { MoveClass } from "@/lib/api";
import { formatEval, winPercentSeries, type Eval } from "@/lib/winPercent";
import { isError } from "./classes";

// White's winning chances over the game, hand-drawn in SVG: one point per position (start +
// every ply), White's share light at the bottom, Black's dark at the top, a dashed 50% line.
// Dots mark the imported player's inaccuracies, mistakes and blunders.
//
// - Draws itself in once, left to right: a CSS clip-path wipe (anim-wipe), so it ends fully drawn
//   even in a browser that runs no animation frames; none with reduced motion.
// - Drag across it (mouse, pen or finger) to scrub the board; ←/→ work anywhere on the page.
// - The teal cursor glides to the current move (a short CSS transition on its transform).
// - The SVG stretches to its box (preserveAspectRatio="none", strokes don't scale), and the dots
//   are HTML positioned in %, so they stay round at any width.

const W = 1000;
const H = 100;

export function EvalGraph({
  evals,
  classes,
  player,
  current,
  onScrub,
  labelFor,
}: {
  evals: Eval[];
  classes?: MoveClass[];
  player: "white" | "black";
  current: number;
  onScrub: (ply: number) => void;
  labelFor: (ply: number) => string; // "15… a6??", for the slider's spoken value
}) {
  const box = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const series = winPercentSeries(evals);
  const n = series.length - 1;
  const x = (i: number) => (n === 0 ? 0 : (i / n) * W);
  const y = (wp: number) => ((100 - wp) / 100) * H;

  const line = series.map((wp, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(wp).toFixed(2)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;

  const plyAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * n);
  };

  const playerParity = player === "white" ? 1 : 0; // white plays odd plies (1, 3, …)
  const dots = (classes ?? []).flatMap((c, i) =>
    isError(c) && (i + 1) % 2 === playerParity ? [{ ply: i + 1, cls: c }] : [],
  );

  return (
    <div className="flex flex-col gap-1">
      <div
        ref={box}
        role="slider"
        tabIndex={0}
        aria-label="Evaluation graph: drag to move through the game"
        aria-valuemin={0}
        aria-valuemax={n}
        aria-valuenow={current}
        aria-valuetext={current === 0 ? "start position" : `${labelFor(current)}, eval ${formatEval(evals[current - 1])}`}
        className="relative h-24 w-full cursor-ew-resize touch-pan-y overflow-hidden rounded-sm bg-graphite outline-1 outline-offset-2 outline-transparent transition-[outline-color] duration-150 select-none hover:outline-ink/40 active:outline-ink sm:h-28"
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          dragging.current = true;
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {}
          onScrub(plyAt(e.clientX));
        }}
        onPointerMove={(e) => {
          if (dragging.current) onScrub(plyAt(e.clientX));
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
      >
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="anim-wipe absolute inset-0 h-full w-full" aria-hidden>
          <path d={area} fill="var(--color-square-light)" />
          <line
            x1={0}
            x2={W}
            y1={H / 2}
            y2={H / 2}
            stroke="var(--color-square-dark)"
            strokeDasharray="4 4"
            vectorEffect="non-scaling-stroke"
          />
          <path d={line} fill="none" stroke="var(--color-ink)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        </svg>
        {/* The cursor: a full-width layer moved by translateX(% of its own width = the graph's), so
            it can glide with a CSS transition; the 2 px teal line sits at its left edge. */}
        <div
          className="motion-slide pointer-events-none absolute inset-0 transition-transform duration-150 ease-out"
          style={{ transform: `translateX(${(x(current) / W) * 100}%)` }}
          aria-hidden
        >
          <div className="absolute inset-y-0 left-0 w-0.5 -translate-x-1/2 bg-best" />
        </div>
        {dots.map((d) => (
          <span
            key={d.ply}
            className="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-bone"
            style={{
              left: `${(x(d.ply) / W) * 100}%`,
              top: `${(y(series[d.ply]!) / H) * 100}%`,
              background: `var(--color-${d.cls})`,
            }}
          />
        ))}
      </div>
      <p className="flex justify-between font-mono text-xs text-graphite/70" aria-hidden>
        <span>White ↑ · Black ↓</span>
        <span className="tabular-nums">{current === 0 ? "start" : formatEval(evals[current - 1])}</span>
      </p>
    </div>
  );
}
