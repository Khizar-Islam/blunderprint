"use client";

import type { CoachStat } from "@/lib/api";
import { statText } from "@/lib/coach";
import { useReveal } from "@/lib/useReveal";
import { AnimatedNumber } from "../patterns/charts/AnimatedNumber";

// The pattern's number, big: "7.9 vs your 3.1", with the unit in words and the sample size.
// Two thin bars put the two figures side by side on one scale (this situation in ink, the
// player's usual in stone). All numbers come from code (the verifier copied them from the
// candidate), never from the model.
// The bars' length is scaleX in their style (bar-x): 0 until the stat scrolls into view, then a
// CSS transition grows them, so they land on the right length even without animation frames.
export function StatLine({ stat }: { stat: CoachStat }) {
  const { ref, shown } = useReveal<HTMLDivElement>(0.6);
  const t = statText(stat);
  const max = Math.max(stat.value, stat.baseline) || 1;

  return (
    <div ref={ref} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-5xl leading-none tracking-tight text-ink tabular-nums sm:text-6xl">
          <AnimatedNumber value={stat.value} hold={!shown} format={t.value} />
        </span>
        <span className="font-mono text-lg text-graphite tabular-nums">
          vs your <span className="text-ink">{t.baseline}</span>
        </span>
      </div>
      <p className="text-sm text-graphite">
        {t.unit} · <span className="text-ink">{t.gap}</span>
      </p>
      <div className="flex flex-col gap-1.5" aria-hidden="true">
        {[
          { label: "here", value: stat.value, color: "bg-ink" },
          { label: "usual", value: stat.baseline, color: "bg-square-dark/60" },
        ].map((bar, i) => (
          <div key={bar.label} className="grid grid-cols-[3rem_1fr] items-center gap-2">
            <span className="font-mono text-[11px] text-graphite/60">{bar.label}</span>
            <div className="h-1.5 bg-square-light/60">
              <div
                className={`bar-x h-full w-full ${bar.color}`}
                style={{ transform: `scaleX(${shown ? bar.value / max : 0})`, transitionDuration: "700ms", transitionDelay: `${100 + i * 100}ms` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="font-mono text-xs text-graphite/70">{t.sample}</p>
    </div>
  );
}
