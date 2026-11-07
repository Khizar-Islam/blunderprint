"use client";

import { useState } from "react";
import type { CoachPattern, Platform } from "@/lib/api";
import { useReveal } from "@/lib/useReveal";
import { EvidenceBoard } from "./EvidenceBoard";
import { FingerprintLens } from "./FingerprintLens";
import { StatLine } from "./StatLine";

// One verified pattern: its label (written by code), the fingerprint lens, the big statistic,
// the coach's explanation and drill, and 2-4 evidence boards. The lens and the boards share a
// "lit" index, so hovering either lights the other.
// The card rises in when it scrolls into view. Cards that come into view together (the first
// screen) start 120 ms apart; one scrolled to later starts at once (lib/useReveal.ts). It's a
// CSS animation from below to the card's normal style, so it ends in place even without frames.

const BOARD_COLS: Record<number, string> = {
  1: "grid-cols-2 md:grid-cols-3",
  2: "grid-cols-2",
  3: "grid-cols-2 md:grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
};

export function PatternCard({
  pattern,
  index,
  total,
  platform,
  username,
}: {
  pattern: CoachPattern;
  index: number;
  total: number;
  platform: Platform;
  username: string;
}) {
  const { ref, shown, delayMs } = useReveal<HTMLElement>(0.15, true);
  const [lit, setLit] = useState<number | null>(null);
  const hrefOf = (e: { gameId: string; ply: number }) => `/p/${platform}/${encodeURIComponent(username)}/game/${encodeURIComponent(e.gameId)}?ply=${e.ply}`;
  const cols = BOARD_COLS[Math.min(4, pattern.evidence.length)] ?? BOARD_COLS[4];

  return (
    <article
      ref={ref}
      className={`flex flex-col gap-6 border-t-2 border-ink pt-5 [--bp-rise:16px] [animation-duration:500ms] ${shown ? "anim-rise" : "reveal-wait"}`}
      style={{ animationDelay: `${delayMs}ms` }}
      aria-labelledby={`pattern-${index}`}
    >
      <header className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-wide text-graphite/60 uppercase">
          Pattern {index + 1} of {total}
        </p>
        <h2 id={`pattern-${index}`} className="font-display text-2xl leading-tight text-ink sm:text-3xl">
          {pattern.title}
        </h2>
      </header>

      <FingerprintLens evidence={pattern.evidence} hrefOf={hrefOf} active={lit} onActive={setLit} />

      <div className="grid gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <StatLine stat={pattern.stat} />
        <div className="flex flex-col gap-4">
          <p className="text-base leading-relaxed text-ink">{pattern.explanation}</p>
          <div className="border-l-2 border-best pl-4">
            <p className="font-mono text-xs tracking-wide text-best uppercase">Exercise</p>
            <p className="mt-1 font-display text-lg leading-snug text-ink italic">{pattern.drill}</p>
          </div>
        </div>
      </div>

      <div className={`grid gap-x-4 gap-y-6 ${cols}`}>
        {pattern.evidence.map((e, i) => (
          <EvidenceBoard
            key={`${e.gameId}:${e.ply}`}
            boardId={`coach-${index}-${i}`}
            evidence={e}
            index={i}
            href={hrefOf(e)}
            active={lit === i}
            onActive={(on) => setLit(on ? i : null)}
          />
        ))}
      </div>
    </article>
  );
}
