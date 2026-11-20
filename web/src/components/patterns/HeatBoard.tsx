"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Summary } from "@/lib/api";
import { fullDate } from "@/lib/format";
import { MiniBoard, PIECE_NAMES, pieceSrc } from "../MiniBoard";
import { TEXT } from "../review/classes";
import { moveName } from "./geometry";
import { baseline, cellOf, displayOrder, heatSquares, markOf, nameOf, squareLabel, weightOf, type HeatMode, type HeatSquare } from "./heat";
import { annotated, type MarkInfo } from "./link";

// Where the player's errors land, as a real board: stone squares, coordinates in the corners,
// and on each square a brick disc for what was lost there (heat.ts markOf: its area grows with
// the win-chance points lost above an ordinary square's, and the small ones fade toward nothing,
// so a handful of squares stand out). The view follows the colour filter: both / White / Black.
//
// It talks to the print (PatternsDashboard holds the link):
// - pointing at (or focusing, or tapping) a square tells the print, which lights that square's
//   errors and fades the rest; the readout below shows the square's costliest move as a position
//   with the move played (rust) and the better one (teal);
// - an error pointed at in the print outlines its square here and is named in the readout.
// A click (Enter, or a second tap) on a square opens its costliest move in the game review.
//
// 64 plain buttons: cheap at this size, and each has a real label for screen readers. The discs
// grow and fade by CSS transitions (width, opacity), so the final state needs no animation
// frames. The readout's space is held, so nothing below moves as the pointer does.

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const describe = (sq: { inaccuracy: number; mistake: number; blunder: number; total: number }) =>
  sq.total === 0
    ? "no errors"
    : [
        sq.blunder && plural(sq.blunder, "blunder"),
        sq.mistake && plural(sq.mistake, "mistake"),
        sq.inaccuracy && (sq.inaccuracy === 1 ? "1 inaccuracy" : `${sq.inaccuracy} inaccuracies`),
      ]
        .filter(Boolean)
        .join(", ");
const points = (n: number) => `${n.toFixed(1)} win-chance points`;

export function HeatBoard({
  squares,
  mode,
  mark,
  onCell,
  gameHref,
}: {
  squares: Summary["squares"];
  mode: HeatMode;
  mark: MarkInfo | null; // the error pointed at in the print
  onCell: (cell: number | null) => void;
  gameHref: (gameId: string, ply: number) => string;
}) {
  const router = useRouter();
  const cells = heatSquares(squares, mode);
  const weights = cells.map(weightOf);
  const max = Math.max(0, ...weights);
  const base = baseline(weights);
  const order = displayOrder(mode);
  const [focus, setFocus] = useState<number | null>(null);
  const pointerType = useRef("mouse");
  const tapped = useRef<number | null>(null); // touch: the square the last tap showed

  const choose = (cell: number | null) => {
    setFocus(cell);
    onCell(cell);
  };

  // The pieces are 12 small files, first needed when a square is pointed at. Fetched once the
  // board is on the page and the browser is idle, so the first position doesn't draw piece by piece.
  useEffect(() => {
    const load = () => PIECE_NAMES.forEach((name) => (new Image().src = pieceSrc(name)));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(load);
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(load, 1500);
    return () => window.clearTimeout(timer);
  }, []);

  const markCell = mark ? cellOf(mark.square, mark.color, mode) : null;
  const litCell = markCell ?? focus;
  const focused: HeatSquare | null = focus === null ? null : cells[focus]!;
  const worst = focused?.worst ?? null;
  // The print's error is this square's costliest move: then its position is known here too.
  const markWorst = mark && markCell !== null ? cells[markCell]!.worst : undefined;
  const markPosition = mark && markWorst && markWorst.gameId === mark.gameId && markWorst.ply === mark.ply ? markWorst : null;

  const open = (cell: number) => {
    const w = cells[cell]!.worst;
    if (w) router.push(gameHref(w.gameId, w.ply));
  };

  return (
    <figure className="flex w-full max-w-[22rem] flex-col gap-2 self-start lg:sticky lg:top-6">
      <figcaption className="flex flex-col gap-0.5">
        <span className="font-display text-xl text-ink">Where it goes wrong</span>
        <span className="text-sm text-graphite">
          {mode === "both"
            ? "The square each error landed on, from your side: Black's games are mirrored, so rank 1 is always your back rank."
            : `Your games as ${mode === "white" ? "White" : "Black"}: the square each error landed on, from your side.`}
        </span>
      </figcaption>

      <div
        className="grid aspect-square grid-cols-8 overflow-hidden rounded-sm"
        role="list"
        aria-label="Errors by square"
        onPointerLeave={(e) => e.pointerType === "mouse" && choose(null)}
      >
        {order.map((i, n) => {
          const cell = cells[i]!;
          const light = (Math.floor(n / 8) + n) % 2 === 0; // top-left is a light square, like a real board
          const m = markOf(weights[i]!, max, base);
          const label = `${squareLabel(i, mode)}: ${describe(cell)}${cell.cost ? `, ${points(cell.cost)} lost` : ""}`;
          return (
            <button
              key={i}
              type="button"
              role="listitem"
              aria-label={label}
              onPointerEnter={(e) => {
                pointerType.current = e.pointerType;
                if (e.pointerType === "mouse") choose(i);
              }}
              onPointerDown={(e) => (pointerType.current = e.pointerType)}
              onFocus={() => choose(i)}
              onBlur={() => {
                tapped.current = null;
                choose(null);
              }}
              onClick={() => {
                // Touch: the first tap shows the square, a second tap on it opens its move.
                if (pointerType.current === "touch" && tapped.current !== i) {
                  tapped.current = i;
                  return;
                }
                open(i);
              }}
              className={`focus-inset relative flex items-center justify-center transition-transform duration-100 active:scale-90 ${light ? "bg-square-light" : "bg-square-dark"} ${cell.worst ? "cursor-pointer" : "cursor-default"} ${litCell === i ? "z-10 outline-2 -outline-offset-2 outline-ink" : "hover:z-10 hover:outline-2 hover:-outline-offset-2 hover:outline-ink"}`}
            >
              <span
                className="absolute aspect-square rounded-full bg-blunder transition-[width,opacity] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${m.size * 100}%`, opacity: m.opacity }}
                aria-hidden="true"
              />
              {n % 8 === 0 && (
                <span className="absolute top-px left-0.5 font-mono text-xs leading-none text-ink" aria-hidden="true">
                  {nameOf(i)[1]}
                </span>
              )}
              {n >= 56 && (
                <span className="absolute right-0.5 bottom-px font-mono text-xs leading-none text-ink" aria-hidden="true">
                  {nameOf(i)[0]}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <p className="flex items-start gap-1.5 text-sm text-graphite">
        <span className="mt-[5px] inline-block h-2.5 w-2.5 shrink-0 rounded-full bg-blunder" aria-hidden="true" />
        The bigger the mark, the more win chances were lost on that square, compared with an ordinary one.
      </p>

      {/* The readout: a held slot (the position on the left, the words on the right). */}
      <div className="grid min-h-[9.5rem] grid-cols-[8.5rem_1fr] gap-3 border-t border-ink/15 pt-3" aria-live="polite">
        {mark ? (
          <>
            <MiniBoard
              fen={markPosition?.fen ?? null}
              side={mark.color}
              playedUci={markPosition?.playedUci}
              betterUci={markPosition?.betterUci}
              mark={markPosition ? null : mark.square}
              label={markPosition ? `The position before ${moveName(mark.ply)} ${mark.san}` : `${mark.square}: where ${mark.san} landed`}
            />
            <div className="flex min-w-0 flex-col gap-1 text-xs text-graphite">
              <span className={`font-mono text-base ${TEXT[mark.kind]}`}>{`${moveName(mark.ply)} ${annotated(mark.san, mark.kind)}`}</span>
              <span className="font-mono text-ink">{`lost ${points(mark.winDrop)}`}</span>
              <span className="font-mono">{`${fullDate(mark.playedAt)} · ${mark.speed} · as ${mark.color}`}</span>
              <span className="pt-1 text-graphite/80">Click the mark to open the game at this move.</span>
            </div>
          </>
        ) : focused && worst ? (
          <>
            <MiniBoard
              fen={worst.fen}
              side={focused.worstColor ?? "white"}
              playedUci={worst.playedUci}
              betterUci={worst.betterUci}
              label={`The position before ${moveName(worst.ply)} ${worst.san}`}
            />
            <div className="flex min-w-0 flex-col gap-1 text-xs text-graphite">
              <span className="font-mono">{`${squareLabel(focus!, mode)} · ${describe(focused)}`}</span>
              {focused.cost !== undefined && <span className="font-mono">{`${points(focused.cost)} lost here. The costliest:`}</span>}
              <span className={`font-mono text-base ${TEXT[worst.kind]}`}>{`${moveName(worst.ply)} ${annotated(worst.san, worst.kind)}`}</span>
              <span className="font-mono text-ink">{`lost ${points(worst.winDrop)}`}</span>
              <span className="pt-1 text-graphite/80">Click the square to open the game at this move.</span>
            </div>
          </>
        ) : (
          <>
            <MiniBoard fen={null} side="white" label="No position chosen" />
            <p className="self-center text-xs text-graphite">
              {focused
                ? `${squareLabel(focus!, mode)}: ${describe(focused)}.`
                : max === 0
                  ? "No errors yet."
                  : "Point at a square: its errors light up in the print, and its costliest move shows here. Point at a mark in the print: its square lights up."}
            </p>
          </>
        )}
      </div>
    </figure>
  );
}
