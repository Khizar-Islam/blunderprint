"use client";

import { motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { Summary } from "@/lib/api";
import { AnimatedNumber } from "./charts/AnimatedNumber";

// The most-played openings (grouped by ECO code on the server), with the score as a bar
// (a win counts 1, a draw ½) and errors per analysed game.

const SHOWN = 8;
const pct = (n: number) => `${Math.round(n)}%`;
const two = (n: number) => n.toFixed(2);

export function OpeningsTable({ openings }: { openings: Summary["openings"] }) {
  const reduced = useReducedMotion();
  const [all, setAll] = useState(false);
  const rows = all ? openings : openings.slice(0, SHOWN);
  if (openings.length === 0) return null;

  return (
    <figure className="flex flex-col gap-3">
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-display text-xl text-ink">Openings</span>
        <span className="text-xs text-graphite/70">Most played first. Score: a win counts 1, a draw ½. Errors per analysed game.</span>
      </figcaption>
      <table className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="border-b border-ink/15 text-left font-mono text-[11px] font-normal text-graphite/60">
            <th className="pb-1.5 font-normal">Opening</th>
            <th className="w-12 pb-1.5 text-right font-normal">Games</th>
            <th className="w-[30%] pb-1.5 pl-3 font-normal sm:w-40">Score</th>
            <th className="w-14 pb-1.5 text-right font-normal">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.eco ?? "none"} className="border-b border-ink/5 align-middle">
              <td className="py-1.5 pr-2">
                <span className="mr-2 font-mono text-xs text-graphite/60">{o.eco ?? "—"}</span>
                <span className="text-ink">{o.name ?? "Unknown opening"}</span>
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums">{o.games}</td>
              <td className="py-1.5 pl-3">
                <span className="flex items-center gap-2">
                  <svg className="h-2 min-w-0 flex-1" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                    <rect x="0" y="0" width="100" height="10" style={{ fill: "var(--color-ink)", fillOpacity: 0.07 }} />
                    <motion.rect
                      x="0"
                      y="0"
                      height="10"
                      style={{ fill: "var(--color-best)" }}
                      initial={{ width: 0 }}
                      animate={{ width: o.score }}
                      transition={reduced ? { duration: 0 } : { duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
                    />
                  </svg>
                  <span className="w-9 text-right font-mono text-xs tabular-nums">
                    <AnimatedNumber value={o.score} format={pct} />
                  </span>
                </span>
              </td>
              <td className="py-1.5 text-right font-mono tabular-nums">
                <AnimatedNumber value={o.mistakesPerGame} format={two} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {openings.length > SHOWN && (
        <button type="button" className="btn-quiet self-start text-xs" onClick={() => setAll((v) => !v)}>
          {all ? "Show fewer" : `Show all ${openings.length}`}
        </button>
      )}
    </figure>
  );
}
