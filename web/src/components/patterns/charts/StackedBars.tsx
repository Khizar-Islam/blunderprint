"use client";

import type { ErrorKind, KindCounts } from "@/lib/api";
import { AnimatedNumber } from "./AnimatedNumber";
import { fewGames } from "./sample";
import { niceMax, ticks } from "./scale";

// A horizontal bar per bucket, split by error kind (blunders first from the left), hand-drawn in
// SVG. Colours go in `style`, not in fill=/stroke= attributes: var() only works in CSS, not
// in an SVG attribute. Each bar's SVG uses a 0–100 viewBox stretched to the width (preserveAspectRatio="none"),
// so it fits any screen; the text is plain HTML beside it, so it never stretches.
//
// The kinds are drawn as three rectangles that all start at x = 0 and overlap: the widest
// (all errors, inaccuracy colour) underneath, then blunders + mistakes, then blunders on top.
// Each rectangle is full width, and its length is a CSS transform, scaleX(share), in its style
// (the bar-x utility in globals.css): it grows from 0 when it first appears and glides from the
// old length to the new one when the filters change. CSS runs that without animation frames, so a
// throttled tab still ends on the right length. Bars are keyed by bucket, so a bucket keeps its
// rectangles (and glides) instead of being replaced.

export interface BarRow {
  key: string;
  label: string;
  sub?: string; // e.g. "38 games"
  games: number; // the games the bar is built on: under 5, it's greyed out (charts/sample.ts)
  counts: KindCounts;
  value: number | null; // the rate shown (per 100 moves or per game); null = no data
}

const FILL: Record<ErrorKind, string> = {
  inaccuracy: "var(--color-inaccuracy)",
  mistake: "var(--color-mistake)",
  blunder: "var(--color-blunder)",
};

// A bar on too few games keeps its shape but loses its colours: stone greys, darkest for blunders.
const FEW: Record<ErrorKind, string> = {
  inaccuracy: "var(--color-square-light)",
  mistake: "color-mix(in oklab, var(--color-square-dark) 60%, var(--color-square-light))",
  blunder: "var(--color-square-dark)",
};

export function StackedBars({
  title,
  caption,
  rows,
  format,
}: {
  title: string;
  caption?: string;
  rows: BarRow[];
  format: (n: number) => string;
}) {
  const max = niceMax(Math.max(0, ...rows.map((r) => r.value ?? 0)));
  const grid = ticks(max).slice(1, -1); // inner gridlines only

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-display text-xl text-ink">{title}</span>
        {caption && <span className="text-xs text-graphite/70">{caption}</span>}
      </figcaption>
      <ul className="flex flex-col gap-2.5">
        {rows.map((row) => {
          const v = row.value ?? 0;
          const total = row.counts.inaccuracy + row.counts.mistake + row.counts.blunder;
          // Each kind's share of the rate, stacked: blunder | mistake | inaccuracy.
          const part = (n: number) => (total > 0 ? (v * n) / total / max : 0) * 100;
          const widths = {
            blunder: part(row.counts.blunder),
            mistake: part(row.counts.blunder + row.counts.mistake),
            inaccuracy: part(total),
          };
          const few = fewGames(row.games);
          return (
            <li
              key={row.key}
              className="-mx-1.5 grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-1 rounded-sm px-1.5 py-0.5 transition-colors duration-150 hover:bg-square-light/45 sm:grid-cols-[8.5rem_1fr_3.5rem]"
              aria-label={`${row.label}: ${row.value === null ? "no data" : format(row.value)}; ${row.counts.blunder} blunders, ${row.counts.mistake} mistakes, ${row.counts.inaccuracy} inaccuracies${few ? "; few games, read with care" : ""}`}
            >
              <span className={`flex min-w-0 flex-col text-sm ${few ? "text-graphite/60" : "text-ink"}`}>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate">{row.label}</span>
                  {row.sub && <span className="shrink-0 font-mono text-xs text-graphite/60">{row.sub}</span>}
                </span>
                {/* Its own line, so it never squeezes the label in the narrow label column. */}
                {few && <span className="font-mono text-[11px] leading-tight text-graphite/60 italic">few games</span>}
              </span>
              <svg
                className="col-span-2 row-start-2 h-3 w-full sm:col-span-1 sm:row-start-auto"
                viewBox="0 0 100 10"
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                <rect x="0" y="0" width="100" height="10" style={{ fill: "var(--color-ink)", fillOpacity: 0.05 }} />
                {grid.map((t) => (
                  <line
                    key={t}
                    x1={(t / max) * 100}
                    x2={(t / max) * 100}
                    y1="0"
                    y2="10"
                    style={{ stroke: "var(--color-bone)" }}
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {(["inaccuracy", "mistake", "blunder"] as const).map((kind) => (
                  <rect
                    key={kind}
                    x="0"
                    y="0"
                    width="100"
                    height="10"
                    className="bar-x"
                    style={{ fill: few ? FEW[kind] : FILL[kind], transform: `scaleX(${widths[kind] / 100})` }}
                  />
                ))}
              </svg>
              <span className={`text-right font-mono text-sm tabular-nums ${few ? "text-graphite/60" : "text-ink"}`}>
                <AnimatedNumber value={row.value} format={format} />
              </span>
            </li>
          );
        })}
      </ul>
      <p className="font-mono text-[11px] text-graphite/60">
        scale 0–{format(max)}
      </p>
    </figure>
  );
}
