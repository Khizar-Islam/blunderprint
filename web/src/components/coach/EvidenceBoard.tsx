"use client";

import { useInView, useReducedMotion } from "motion/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CoachEvidence } from "@/lib/api";
import { factsLine, fenAfterMove, moveCaption, uciSquares } from "@/lib/coach";
import { Board } from "../review/Board";

// One evidence position on a pattern card. When it scrolls into view:
//   1. it fades in at the position BEFORE the mistake;
//   2. the piece that was played slides along a muted rust arrow, and holds there ~0.6 s;
//   3. it slides back, and a teal arrow draws the better move.
// It ends on the position before the move with both arrows, which is also what visitors who
// ask for reduced motion see at once. Under the board: the move, its cost, and the situation
// from code (speed, phase, clock, opening), plus a link to that move in the game review.

// Arrow colours as hex: these are SVG attributes, where var(--…) doesn't work.
const RUST = "#D9772B";
const TEAL = "#3E7C74";

// Literal class names, so Tailwind sees them (it can't read a class built at runtime).
const KIND_TEXT = { inaccuracy: "text-inaccuracy", mistake: "text-mistake", blunder: "text-blunder" } as const;

const SLIDE_MS = 450;
const HOLD_MS = 600;
const FADE_MS = 350;

type Phase = "hidden" | "before" | "played" | "back" | "better";

const fullFen = (fen: string) => (fen.split(" ").length === 4 ? `${fen} 0 1` : fen);

// A square's centre in the board's 8 × 8 units, from the viewer's side.
function centre(square: string, orientation: "white" | "black") {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === "white" ? { x: file + 0.5, y: 7 - rank + 0.5 } : { x: 7 - file + 0.5, y: rank + 0.5 };
}

function Arrow({ uci, color, orientation, draw, reduced }: { uci: string | null; color: string; orientation: "white" | "black"; draw: boolean; reduced: boolean }) {
  const sq = uciSquares(uci);
  if (!sq) return null;
  const a = centre(sq.from, orientation);
  const b = centre(sq.to, orientation);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const ux = (b.x - a.x) / len;
  const uy = (b.y - a.y) / len;
  // Stop short of the centre so the head sits inside the target square.
  const tip = { x: b.x - ux * 0.18, y: b.y - uy * 0.18 };
  const base = { x: tip.x - ux * 0.42, y: tip.y - uy * 0.42 };
  const side = { x: -uy * 0.24, y: ux * 0.24 };
  const head = `${tip.x},${tip.y} ${base.x + side.x},${base.y + side.y} ${base.x - side.x},${base.y - side.y}`;
  const shown = draw || reduced;
  // The shaft draws itself with a dash the length of the line (pathLength 1, offset 1 → 0) and
  // the head fades in as it arrives: CSS transitions on the styles, so the arrow ends drawn even
  // without animation frames. Reduced motion: no transition.
  return (
    <g opacity={0.85}>
      <line
        x1={a.x}
        y1={a.y}
        x2={base.x}
        y2={base.y}
        stroke={color}
        strokeWidth={0.17}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray="1"
        style={{
          strokeDashoffset: shown ? 0 : 1,
          opacity: shown ? 1 : 0,
          transition: reduced ? undefined : `stroke-dashoffset ${SLIDE_MS}ms cubic-bezier(0.22, 1, 0.36, 1), opacity ${SLIDE_MS}ms`,
        }}
      />
      <polygon
        points={head}
        fill={color}
        style={{ opacity: shown ? 1 : 0, transition: reduced ? undefined : `opacity 150ms ${shown ? SLIDE_MS - 100 : 0}ms` }}
      />
    </g>
  );
}

export function EvidenceBoard({
  evidence,
  index,
  href,
  active,
  onActive,
  boardId,
}: {
  evidence: CoachEvidence;
  index: number; // its place on the card: later boards start a little later
  href: string;
  active: boolean; // lit from the fingerprint lens
  onActive: (on: boolean) => void;
  boardId: string;
}) {
  const reduced = !!useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const orientation = evidence.color ?? "white";
  const before = fullFen(evidence.fen);
  const after = fenAfterMove(evidence.fen, evidence.playedUci);
  const [phase, setPhase] = useState<Phase>(reduced ? "better" : "hidden");

  useEffect(() => {
    if (reduced || !inView) return;
    const start = index * 300;
    const steps: [number, Phase][] = after
      ? [
          [start, "before"],
          [start + FADE_MS + 350, "played"],
          [start + FADE_MS + 350 + SLIDE_MS + HOLD_MS, "back"],
          [start + FADE_MS + 350 + 2 * SLIDE_MS + HOLD_MS, "better"],
        ]
      : // A move chess.js can't replay here: no slide, just the two arrows in turn.
        [
          [start, "before"],
          [start + FADE_MS + 350, "back"],
          [start + FADE_MS + 350 + SLIDE_MS + HOLD_MS, "better"],
        ];
    const timers = steps.map(([at, p]) => setTimeout(() => setPhase(p), at));
    return () => timers.forEach(clearTimeout);
  }, [inView, reduced, index, after]);

  const shownPhase: Phase = reduced ? "better" : phase;
  const position = shownPhase === "played" && after ? after : before;
  const caption = moveCaption(evidence);
  const facts = factsLine(evidence);

  return (
    <figure className="flex min-w-0 flex-col gap-2" onMouseEnter={() => onActive(true)} onMouseLeave={() => onActive(false)}>
      <div
        ref={ref}
        className={`relative rounded-sm transition-[outline-color] duration-150 outline-2 outline-offset-2 ${active ? "outline-ink" : "outline-transparent"}`}
        style={{ opacity: shownPhase === "hidden" ? 0 : 1, transition: reduced ? undefined : `opacity ${FADE_MS}ms ease-out, outline-color 150ms` }}
      >
        <Board
          id={boardId}
          fen={position}
          orientation={orientation}
          animationMs={SLIDE_MS}
          showCoordinates={false}
          label={`Position before ${caption.move.toLowerCase()} ${caption.played}, with arrows for the move played and the better move`}
        />
        <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true">
          <Arrow uci={evidence.playedUci} color={RUST} orientation={orientation} draw={shownPhase !== "hidden" && shownPhase !== "before"} reduced={reduced} />
          <Arrow uci={evidence.betterUci} color={TEAL} orientation={orientation} draw={shownPhase === "better"} reduced={reduced} />
        </svg>
      </div>
      <figcaption className="flex flex-col gap-1">
        <p className="font-mono text-[13px] leading-snug text-ink">
          <span className="text-graphite/70">{caption.move}</span> <span className={`${KIND_TEXT[caption.kind]} font-semibold`}>{caption.played}</span>{" "}
          <span className="text-graphite/70">{caption.kind}</span>
          {caption.better && (
            <>
              {" · better "}
              <span className="font-semibold text-best">{caption.better}</span>
            </>
          )}
        </p>
        <p className="font-mono text-xs text-graphite/70">{caption.cost}</p>
        {facts.length > 0 && <p className="text-xs leading-snug text-graphite">{facts.join(" · ")}</p>}
        <Link
          href={href}
          className="self-start rounded text-xs text-graphite/80 underline decoration-ink/20 underline-offset-4 transition-colors hover:text-ink hover:decoration-ink active:opacity-70"
          onFocus={() => onActive(true)}
          onBlur={() => onActive(false)}
        >
          Open in game review →
        </Link>
      </figcaption>
    </figure>
  );
}
