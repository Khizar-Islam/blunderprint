"use client";

import { motion, useInView, useReducedMotion } from "motion/react";
import { useId, useRef } from "react";
import type { CoachEvidence } from "@/lib/api";
import { TICK_COLOR } from "../patterns/geometry";
import { lensPlies, lensRows, rowTicks, tickBox } from "./lens";

// The "fingerprint lens" (the coach page's signature visual): the pattern's evidence games
// drawn as Blunderprint ribbons, one row per game, the evidence move ringed. It points the
// coach's claim straight back into the player's fingerprint: here is where it happens.
//
// On reveal the rows draw left to right, then the rings settle on the mistakes. Hovering a row
// (or its board below) lights the pair. Rows link to that move in the game review. One SVG:
// at most 4 rows × ~200 ticks.

const W = 1000; // viewBox units across
const ROW_H = 8;
const GAP = 7;
const PAD = 4; // room above and below for the rings

export function FingerprintLens({
  evidence,
  hrefOf,
  active,
  onActive,
}: {
  evidence: CoachEvidence[];
  hrefOf: (e: { gameId: string; ply: number }) => string;
  active: number | null; // the lit evidence index (from a hovered board or row)
  onActive: (index: number | null) => void;
}) {
  const reduced = !!useReducedMotion();
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const id = useId();
  const rows = lensRows(evidence);
  if (rows.length === 0) return null; // a report saved before the lens existed
  const plies = lensPlies(rows);
  const height = PAD * 2 + rows.length * ROW_H + (rows.length - 1) * GAP;
  const drawn = reduced || inView;

  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between font-mono text-[11px] tracking-wide text-graphite/60 uppercase">
        <span>Where it happens in your games</span>
        <span className="hidden normal-case sm:inline">one row per game · ringed: the move below</span>
      </figcaption>
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${height}`}
        preserveAspectRatio="none"
        className="block h-auto w-full"
        style={{ height: `${Math.max(28, rows.length * 15 + 6)}px` }}
        role="list"
        aria-label="The evidence games' move ribbons"
      >
        <defs>
          {rows.map((_, i) => (
            <clipPath key={i} id={`${id}-clip-${i}`}>
              <motion.rect
                x={0}
                y={0}
                height={height}
                initial={{ width: reduced ? W : 0 }}
                animate={{ width: drawn ? W : 0 }}
                transition={reduced ? { duration: 0 } : { duration: 0.7, delay: i * 0.12, ease: [0.22, 1, 0.36, 1] }}
              />
            </clipPath>
          ))}
        </defs>
        {rows.map((row, i) => {
          const y = PAD + i * (ROW_H + GAP);
          const ev = evidence.findIndex((e) => e.gameId === row.gameId && e.ply === row.ply);
          const lit = active === null || active === ev;
          const ring = tickBox(row.ply, plies, W);
          const kind = row.ribbon[row.ply - 1] === "x" ? "blunder" : row.ribbon[row.ply - 1] === "m" ? "mistake" : "inaccuracy";
          return (
            <a
              key={`${row.gameId}:${row.ply}`}
              href={hrefOf(row)}
              role="listitem"
              aria-label={`Game ${i + 1}: the ${kind} at ply ${row.ply}, open it in the game review`}
              onMouseEnter={() => onActive(ev)}
              onMouseLeave={() => onActive(null)}
              onFocus={() => onActive(ev)}
              onBlur={() => onActive(null)}
            >
              <g clipPath={`url(#${id}-clip-${i})`} opacity={lit ? 1 : 0.35} style={{ transition: "opacity 150ms" }}>
                <rect x={0} y={y - 2} width={W} height={ROW_H + 4} fill="transparent" />
                {rowTicks(row).map((t) => {
                  const box = tickBox(t.ply, plies, W);
                  return <rect key={t.ply} x={box.x} y={y} width={Math.max(box.w - 1.2, 1)} height={ROW_H} fill={t.color} />;
                })}
              </g>
              <motion.rect
                x={ring.x - 5}
                y={y - 3}
                width={ring.w + 10}
                height={ROW_H + 6}
                rx={2}
                fill="none"
                stroke={TICK_COLOR[kind]}
                strokeWidth={active === ev ? 3 : 2}
                vectorEffect="non-scaling-stroke"
                initial={{ opacity: reduced ? 1 : 0 }}
                animate={{ opacity: drawn ? 1 : 0 }}
                transition={reduced ? { duration: 0 } : { duration: 0.3, delay: 0.7 + i * 0.12 }}
              />
            </a>
          );
        })}
      </svg>
    </figure>
  );
}
