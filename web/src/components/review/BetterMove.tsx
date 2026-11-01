"use client";

import { useRef } from "react";
import { HEX, LABEL, TEXT } from "./classes";

// Under the board on an inaccuracy/mistake/blunder: "Nxe5?? was a blunder. Better was Nf3",
// and a Show control that switches the board to the position BEFORE the move, with a teal
// arrow for the better move and a muted rust arrow for the move played.
//
// Why not draw the arrow on the position after the mistake: the piece that should have moved
// may have moved elsewhere (or been taken), so the arrow would start from the wrong square.
//
// Show works three ways:
// - quick click (or Enter/Space): toggles, and stays on until clicked again or the move changes
// - press and hold: shown only while held, released → back to the position after the move
// - hold B anywhere on the page (handled by GameReview)

const HOLD_MS = 250; // a press longer than this is a hold, not a click

export function BetterMove({
  san,
  glyph,
  cls,
  betterSan,
  peek,
  onPeek,
}: {
  san: string;
  glyph: string;
  cls: "inaccuracy" | "mistake" | "blunder";
  betterSan: string | null;
  peek: boolean;
  onPeek: (on: boolean) => void;
}) {
  const press = useRef<{ at: number; wasOn: boolean } | null>(null);

  const end = (cancelled: boolean) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (cancelled || performance.now() - p.at >= HOLD_MS) onPeek(false); // a hold: release ends it
    else onPeek(!p.wasOn); // a click: toggle
  };

  return (
    <div className="flex flex-col gap-1 font-mono text-sm">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>
          <span className={TEXT[cls]}>
            {san}
            {glyph}
          </span>{" "}
          was {LABEL[cls]}.
          {betterSan && (
            <>
              {" "}
              Better was <span style={{ color: HEX.best }}>{betterSan}</span>.
            </>
          )}
        </span>
        {betterSan && (
          <button
            type="button"
            aria-pressed={peek}
            title="Show the position before the move (or hold B)"
            className={`btn-quiet text-xs select-none touch-none ${peek ? "bg-ink text-bone" : ""}`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              // Capture: the release counts even if the pointer slides off the button. Throws for
              // a pointer the browser doesn't know (synthetic events); the hold still works.
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {}
              press.current = { at: performance.now(), wasOn: peek };
              onPeek(true);
            }}
            onPointerUp={() => end(false)}
            onPointerCancel={() => end(true)}
            // Keyboard activation (Enter/Space) fires click with detail 0; pointer clicks are
            // already handled by the pointer events above.
            onClick={(e) => {
              if (e.detail === 0) onPeek(!peek);
            }}
          >
            {peek ? "Showing" : "Show"}
          </button>
        )}
      </p>
      {peek && betterSan && (
        <p className="text-xs text-graphite/80" aria-live="polite">
          Before {san}: <span style={{ color: HEX.best }}>■ {betterSan}</span> was better than{" "}
          <span className="text-mistake/70">■ {san}</span>
        </p>
      )}
    </div>
  );
}
