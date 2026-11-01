"use client";

import { useEffect, useRef } from "react";
import type { MoveClass } from "@/lib/api";
import type { Ply } from "@/lib/timeline";
import { GLYPH, TEXT } from "./classes";

// The moves in two columns (White, Black), numbered. Each move is a button that jumps the board
// there. Only the imported player's ?!/?/?? carry colour; the opponent's are muted, like the
// ribbon in the games list.
export function MoveList({
  plies,
  classes,
  player,
  current,
  onSelect,
}: {
  plies: Ply[];
  classes?: MoveClass[];
  player: "white" | "black";
  current: number; // 0 = start position, k = after ply k
  onSelect: (ply: number) => void;
}) {
  const box = useRef<HTMLOListElement>(null);
  const active = useRef<HTMLButtonElement>(null);

  // Keep the current move visible inside the list's own scroll box. Done by hand rather than
  // scrollIntoView, which would also scroll the page while you step through with the keys.
  useEffect(() => {
    const c = box.current;
    const el = active.current;
    if (!c || !el) return;
    // The list is position: relative, so it is the button's offsetParent: offsetTop is already
    // measured from the top of the list's content.
    const top = el.offsetTop;
    if (top < c.scrollTop) c.scrollTop = top - 8;
    else if (top + el.offsetHeight > c.scrollTop + c.clientHeight) c.scrollTop = top + el.offsetHeight - c.clientHeight + 8;
  }, [current]);

  const rows: [Ply & { n: number }, (Ply & { n: number }) | undefined][] = [];
  for (let i = 0; i < plies.length; i += 2) {
    rows.push([
      { ...plies[i]!, n: i + 1 },
      plies[i + 1] ? { ...plies[i + 1]!, n: i + 2 } : undefined,
    ]);
  }

  const cell = (p: (Ply & { n: number }) | undefined) => {
    if (!p) return <span />;
    const cls = classes?.[p.n - 1];
    const glyph = cls ? GLYPH[cls] : undefined;
    const isCurrent = p.n === current;
    const mine = p.color === player;
    return (
      <button
        type="button"
        ref={isCurrent ? active : undefined}
        onClick={() => onSelect(p.n)}
        aria-current={isCurrent ? "step" : undefined}
        className={`rounded-sm px-1.5 py-0.5 text-left transition-colors active:scale-[0.97] ${
          isCurrent ? "bg-ink text-bone" : "hover:bg-square-light/60"
        }`}
      >
        {p.san}
        {glyph && (
          <span className={`ml-0.5 ${isCurrent ? "" : mine ? (TEXT[cls!] ?? "") : "text-graphite/50"}`}>{glyph}</span>
        )}
      </button>
    );
  };

  return (
    <ol
      ref={box}
      className="relative grid max-h-80 grid-cols-[2.5rem_1fr_1fr] content-start gap-y-0.5 overflow-y-auto font-mono text-sm lg:max-h-[min(36rem,70vh)]"
      aria-label="Moves"
    >
      {rows.map(([w, b]) => (
        <li key={w.n} className="contents">
          <span className="py-0.5 pr-2 text-right text-graphite/50 tabular-nums">{(w.n + 1) / 2}.</span>
          {cell(w)}
          {cell(b)}
        </li>
      ))}
    </ol>
  );
}
