"use client";

import { useId, useMemo, useState } from "react";
import type { CoachPattern, Platform } from "@/lib/api";
import { checkedParts, type ProsePart } from "@/lib/checked";
import { useReveal } from "@/lib/useReveal";
import { Checked, type Shown } from "./Checked";
import { EvidenceBoard } from "./EvidenceBoard";
import { FingerprintLens } from "./FingerprintLens";
import { StatLine } from "./StatLine";

// One verified pattern: its label (written by code), the fingerprint lens, the big statistic,
// the coach's explanation and drill, and 2-4 evidence boards. The lens and the boards share a
// "lit" index, so hovering either lights the other.
// "Checked", made visible: every figure the page can place (the big number, the player's usual
// one, the numbers in the coach's sentences) sits on a teal rule that is drawn once when the
// card is revealed. Pointing at one (or focusing or tapping it) says where it comes from in the
// line under the explanation, and outlines the position it belongs to (lib/checked.ts).
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
  const { ref, shown: revealed, delayMs } = useReveal<HTMLElement>(0.15, true);
  const [lit, setLit] = useState<number | null>(null);
  // The figure being pointed at, with its source.
  const [shown, setShown] = useState<Shown | null>(null);
  const sourceId = useId();
  const explanation = useMemo(() => checkedParts(pattern.explanation, pattern), [pattern]);
  const drill = useMemo(() => checkedParts(pattern.drill, pattern), [pattern]);
  // The position a pointed-at figure belongs to is lit like a hovered board or lens row.
  const litNow = shown?.source.evidence ?? lit;
  const prose = (parts: ProsePart[], from: number) =>
    parts.map((part, i) =>
      part.kind === "text" ? (
        part.text
      ) : (
        <Checked key={i} text={part.text} source={part.source} onSource={setShown} animate={revealed} delayMs={from + i * 60} describedBy={sourceId} />
      ),
    );
  const hrefOf = (e: { gameId: string; ply: number }) => `/p/${platform}/${encodeURIComponent(username)}/game/${encodeURIComponent(e.gameId)}?ply=${e.ply}`;
  const cols = BOARD_COLS[Math.min(4, pattern.evidence.length)] ?? BOARD_COLS[4];

  return (
    <article
      ref={ref}
      className={`flex flex-col gap-6 border-t-2 border-ink pt-5 [--bp-rise:16px] [animation-duration:500ms] ${revealed ? "anim-rise" : "reveal-wait"}`}
      style={{ animationDelay: `${delayMs}ms` }}
      aria-labelledby={`pattern-${index}`}
    >
      <header className="flex flex-col gap-1">
        <p className="font-mono text-xs text-graphite/70">
          Pattern {index + 1} of {total}
        </p>
        <h2 id={`pattern-${index}`} className="font-display text-2xl leading-tight text-ink">
          {pattern.title}
        </h2>
      </header>

      <FingerprintLens evidence={pattern.evidence} hrefOf={hrefOf} active={litNow} onActive={setLit} />

      <div className="grid gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
        <StatLine stat={pattern.stat} onSource={setShown} describedBy={sourceId} />
        <div className="flex flex-col gap-4">
          <p className="text-base leading-relaxed text-ink">{prose(explanation, 300)}</p>
          {/* Where the pointed-at figure comes from. Its height is reserved (three lines on a
              phone, two from sm), so showing a source never moves the page. */}
          <p id={sourceId} className="min-h-12 font-mono text-xs leading-4 text-best-text sm:min-h-8">
            {shown ? (
              <>
                ✓ <span className="font-semibold">{shown.text}</span> {shown.source.line}
              </>
            ) : (
              "✓ Code checked every figure here against your games. Point at one, or tap it, to see where it comes from."
            )}
          </p>
          <div className="border-l-2 border-best pl-4">
            <p className="font-mono text-xs text-best-text">Exercise</p>
            <p className="mt-1 font-display text-lg leading-snug text-ink italic">{prose(drill, 500)}</p>
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
            active={litNow === i}
            onActive={(on) => setLit(on ? i : null)}
          />
        ))}
      </div>
    </article>
  );
}
