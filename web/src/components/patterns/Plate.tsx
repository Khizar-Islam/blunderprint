"use client";

import { useEffect, useMemo, useState } from "react";
import type { Summary } from "@/lib/api";
import { count } from "@/lib/format";
import { AnimatedNumber } from "./charts/AnimatedNumber";
import { bucketWords, densest, DIGEST_MOVES, moveDigest } from "./digest";

// The player's plate: the first thing in the patterns section. Three numbers that count to
// their value (and on to the new one when a filter changes), the whole print pressed into one
// line (how often each move number goes wrong), and one sentence saying where the errors are
// densest, in the API's own figures.
//
// Everything here comes from the summary the section already has: no request of its own.

const one = (n: number) => n.toFixed(1);
const percent = (n: number) => `${n.toFixed(1)}%`;
const LABELS = [1, 10, 20, 30, 40, 50];

export function Plate({ summary, extracting }: { summary: Summary; extracting: boolean }) {
  const t = summary.totals;
  const strip = useMemo(() => moveDigest(summary.ribbons), [summary.ribbons]);
  const dense = useMemo(() => densest(summary), [summary]);
  const per100 = t.moves > 0 ? (t.mistakes.total / t.moves) * 100 : null;
  const blunders = t.moves > 0 ? (t.mistakes.blunder / t.moves) * 100 : null;

  return (
    <div className="flex flex-col gap-5 border-b border-ink/15 pb-6">
      <dl className="grid grid-cols-3 gap-x-4 sm:max-w-xl sm:gap-x-10">
        <Stat value={per100} format={one} label="errors per 100 moves" />
        <Stat value={blunders} format={one} label="blunders per 100 moves" />
        <Stat value={t.accuracy ?? null} format={percent} label="average accuracy" />
      </dl>

      {t.analysed > 0 && (
        <div className="flex flex-col gap-1.5">
          {/* data-print-line: where a print carried over from the landing page is pressed flat (lib/printCarry.ts). */}
          <div
            data-print-line
            className="flex h-4 w-full gap-px"
            role="img"
            aria-label={
              dense
                ? `How often each move number goes wrong. The errors are densest ${bucketWords(dense.bucket)}.`
                : "How often each move number goes wrong, from move 1 to move 60 and later."
            }
          >
            {strip.map((share, i) => (
              <span key={i} className="relative h-full flex-1 bg-square-light">
                <span className="absolute inset-0 bg-blunder transition-opacity duration-500 motion-reduce:transition-none" style={{ opacity: share }} />
              </span>
            ))}
          </div>
          <div className="relative h-4 font-mono text-xs text-graphite/80" aria-hidden="true">
            {LABELS.map((n) => (
              <span key={n} className="absolute" style={{ left: `${((n - 1) / DIGEST_MOVES) * 100}%` }}>
                {n === 1 ? "move 1" : n}
              </span>
            ))}
            <span className="absolute right-0">60+</span>
          </div>
          {/* One line held, with or without a sentence, so a filter change moves nothing below. */}
          <p className="min-h-7 pt-1 font-display text-lg text-ink sm:text-xl">
            {dense
              ? `The errors are densest ${bucketWords(dense.bucket)}: ${one(dense.per100)} per 100 moves there, ${one(dense.overall)} overall.`
              : "The errors are spread evenly through the game: no stretch stands clear of the rest."}
          </p>
        </div>
      )}

      <div className="flex flex-col gap-1">
        <p className="font-mono text-sm text-graphite">
          {t.analysed} of {t.games} games analysed
          {per100 !== null && (
            <>
              {" · "}
              {count(t.mistakes.blunder, "blunder", "blunders")}, {count(t.mistakes.mistake, "mistake", "mistakes")},{" "}
              {count(t.mistakes.inaccuracy, "inaccuracy", "inaccuracies")}
            </>
          )}
        </p>
        {extracting && (
          <p className="font-mono text-xs text-graphite/70" role="status">
            Working out patterns for the newest analysed games…
          </p>
        )}
      </div>
    </div>
  );
}

// The number starts at 0 and counts up once the plate is on the page (AnimatedNumber's `hold`);
// later changes count from the old value. Released on the first frame, or by a timer when the
// browser gives no frames. The label comes first for screen readers and is shown under the number.
function Stat({ value, format, label }: { value: number | null; format: (n: number) => string; label: string }) {
  const [held, setHeld] = useState(true);
  useEffect(() => {
    const release = () => setHeld(false);
    const frame = requestAnimationFrame(release);
    const timer = window.setTimeout(release, 120);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  return (
    <div className="flex flex-col-reverse justify-end gap-1">
      <dt className="max-w-[9rem] text-sm leading-snug text-graphite">{label}</dt>
      <dd className="font-mono text-2xl text-ink tabular-nums sm:text-4xl">
        <AnimatedNumber value={value} format={format} hold={held} />
      </dd>
    </div>
  );
}
