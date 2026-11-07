"use client";

import { useState } from "react";
import type { Summary } from "@/lib/api";
import { AnimatedNumber } from "./charts/AnimatedNumber";
import { fewGames } from "./charts/sample";

// The most-played openings (grouped by ECO code on the server), with the score as a bar
// (a win counts 1, a draw ½) and errors per analysed game.

const SHOWN = 8;
const pct = (n: number) => `${Math.round(n)}%`;
const two = (n: number) => n.toFixed(2);

export function OpeningsTable({ openings }: { openings: Summary["openings"] }) {
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
            <th className="pb-1.5 pl-1 font-normal">Opening</th>
            <th className="w-12 pb-1.5 text-right font-normal">Games</th>
            <th className="w-[30%] pb-1.5 pl-3 font-normal sm:w-40">Score</th>
            <th className="w-14 pr-1 pb-1.5 text-right font-normal">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => {
            // Under 5 games, the score and error rate are greyed: a 1-game opening at 100% isn't a finding.
            const few = fewGames(o.games);
            return (
              <tr key={o.eco ?? "none"} className={`border-b border-ink/5 align-middle transition-colors duration-150 hover:bg-square-light/45 ${few ? "text-graphite/60" : ""}`}>
                <td className="py-1.5 pr-2 pl-1">
                  <span className="mr-2 font-mono text-xs text-graphite/60">{o.eco ?? "—"}</span>
                  <span className={few ? "" : "text-ink"}>{o.name ?? "Unknown opening"}</span>
                  {few && <span className="ml-2 font-mono text-[11px] whitespace-nowrap italic">few games</span>}
                </td>
                <td className="py-1.5 text-right font-mono tabular-nums">{o.games}</td>
                <td className="py-1.5 pl-3">
                  <span className="flex items-center gap-2">
                    <svg className="h-2 min-w-0 flex-1" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">
                      <rect x="0" y="0" width="100" height="10" style={{ fill: "var(--color-ink)", fillOpacity: 0.07 }} />
                      {/* Length = scaleX in the style (bar-x): grows in, glides on change, no frames needed. */}
                      <rect
                        x="0"
                        y="0"
                        width="100"
                        height="10"
                        className="bar-x"
                        style={{ fill: few ? "var(--color-square-dark)" : "var(--color-best)", transform: `scaleX(${o.score / 100})` }}
                      />
                    </svg>
                    <span className="w-9 text-right font-mono text-xs tabular-nums">
                      <AnimatedNumber value={o.score} format={pct} />
                    </span>
                  </span>
                </td>
                <td className="py-1.5 pr-1 text-right font-mono tabular-nums">
                  <AnimatedNumber value={o.mistakesPerGame} format={two} />
                </td>
              </tr>
            );
          })}
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
