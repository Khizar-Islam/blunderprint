"use client";

import { useReducedMotion } from "motion/react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Summary } from "@/lib/api";
import { fullDate } from "@/lib/format";
import { TEXT } from "../review/classes";
import {
  drawRows,
  errorKindAt,
  hitTest,
  layout,
  loupePly,
  moveName,
  stepError,
  tickAt,
  TICK_COLOR,
  truncation,
} from "./geometry";

// The signature visual: every analysed game as one thin row, one tick per ply, newest at the
// top. Drawn on ONE canvas: 200 games × ~80 plies is ~16,000 ticks, which as SVG or divs would
// be 16,000 DOM nodes to lay out and animate; the canvas draws them in a couple of
// milliseconds. Interaction is plain maths on the pointer position (blunderprint.ts hitTest).
//
// - Hover: a loupe under the row draws that game's FULL row (past the 120-ply cap too), larger,
//   with the date, result and the move under the pointer. Its ticks can be clicked as well, so
//   a late blunder past the cap is still one click away.
// - Click a tick: the game review at that move (?ply=N).
// - Touch: the first tap shows the loupe; a second tap on the same tick opens it.
// - Keyboard: ↑/↓ choose a game, ←/→ step between that game's errors (all of them, past the
//   cap too), Enter opens, Esc clears.

type Ribbon = Summary["ribbons"][number];
type Active = { row: number; ply: number | null; source: "pointer" | "key" | "tap" };

const REVEAL_MS = 700; // the first draw sweeps down the rows in this long
const FADE_MS = 300; // each row's fade-in (also for games that arrive later)
const LOUPE_H = 14;

const RESULT = { win: "Win", loss: "Loss", draw: "Draw" } as const;
const KIND_WORD = { inaccuracy: "inaccuracy", mistake: "mistake", blunder: "blunder" } as const;

export function Blunderprint({ ribbons, gameHref }: { ribbons: Ribbon[]; gameHref: (gameId: string, ply: number) => string }) {
  const router = useRouter();
  const reduced = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<Active | null>(null);
  const pointerType = useRef<string>("mouse");

  // ---- Size: follow the container's width ----------------------------------------------------
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const lengths = useMemo(() => ribbons.map((r) => r.classes.length), [ribbons]);
  const l = useMemo(() => layout(width, lengths, width < 500), [width, lengths]);

  // ---- Reveal: when each row starts to appear ------------------------------------------------
  // The first batch sweeps top to bottom; games that arrive in a later refetch fade in where
  // they land. Kept in a ref: it only steers the drawing, never React's output.
  const appearAt = useRef(new Map<string, number>());
  useEffect(() => {
    const now = performance.now();
    const first = appearAt.current.size === 0;
    ribbons.forEach((r, i) => {
      if (!appearAt.current.has(r.gameId)) appearAt.current.set(r.gameId, first ? now + (i / ribbons.length) * REVEAL_MS : now);
    });
  }, [ribbons]);

  // ---- Draw ------------------------------------------------------------------------------------
  useEffect(() => {
    const el = canvas.current;
    if (!el || l.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(l.width * dpr);
    el.height = Math.max(1, Math.round(l.height * dpr));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS pixels; sharp on high-DPI screens

    let frame = 0;
    const paint = () => {
      const now = performance.now();
      let pending = false;
      drawRows(ctx, l, ribbons, (row) => {
        if (reduced) return 1;
        const start = appearAt.current.get(ribbons[row]!.gameId) ?? 0;
        const a = Math.max(0, Math.min(1, (now - start) / FADE_MS));
        if (a < 1) pending = true;
        return a;
      });
      if (pending) frame = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(frame);
  }, [l, ribbons, reduced]);

  // The selection can outlive the data (filters changed): drop it if its row is gone.
  const current = active && active.row < ribbons.length ? active : null;
  const game = current ? ribbons[current.row]! : null;

  const open = useCallback((row: number, ply: number | null) => router.push(gameHref(ribbons[row]!.gameId, ply ?? 0)), [router, gameHref, ribbons]);

  // ---- Pointer -----------------------------------------------------------------------------------
  const pointAt = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return hitTest(l, lengths, e.clientX - rect.left, e.clientY - rect.top);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    pointerType.current = e.pointerType;
    if (e.pointerType !== "mouse") return;
    const hit = pointAt(e);
    setActive(hit ? { ...hit, source: "pointer" } : null);
  };
  const onClick = (e: React.MouseEvent) => {
    const hit = pointAt(e);
    if (!hit) return;
    if (pointerType.current === "mouse" || pointerType.current === "pen") {
      if (hit.ply) open(hit.row, hit.ply);
      return;
    }
    // Touch: the first tap shows the loupe, a second tap on the same tick opens the game.
    if (current?.source === "tap" && current.row === hit.row && current.ply === hit.ply && hit.ply) open(hit.row, hit.ply);
    else setActive({ ...hit, source: "tap" });
  };

  // ---- Keyboard ----------------------------------------------------------------------------------
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (ribbons.length === 0 || e.altKey || e.ctrlKey || e.metaKey) return;
    const row = current?.row ?? -1;
    const firstError = (r: number) => stepError(ribbons[r]!.classes, ribbons[r]!.color, null, 1);
    let next: Active | null | undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const r = Math.max(0, Math.min(ribbons.length - 1, row + (e.key === "ArrowDown" ? 1 : -1)));
      next = { row: r, ply: firstError(r), source: "key" };
    } else if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && current) {
      const g = ribbons[current.row]!;
      const ply = stepError(g.classes, g.color, current.ply, e.key === "ArrowRight" ? 1 : -1);
      next = ply === null ? current : { ...current, ply, source: "key" };
    } else if (e.key === "Enter" && current) {
      open(current.row, current.ply);
    } else if (e.key === "Escape") {
      next = null;
    } else {
      return;
    }
    e.preventDefault();
    if (next !== undefined) setActive(next);
  };

  // Keep the keyboard's row in view (the canvas can be taller than the screen).
  const highlight = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (current?.source === "key") highlight.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // ---- Render -------------------------------------------------------------------------------------
  const describeActive = () => {
    if (!game || !current) return "";
    const kind = current.ply ? errorKindAt(game.classes, current.ply, game.color) : null;
    const where = current.ply ? `, move ${moveName(current.ply)}${kind ? `, ${KIND_WORD[kind]}` : ""}` : "";
    return `${fullDate(game.playedAt)}, ${RESULT[game.result]} as ${game.color}${where}`;
  };
  const loupeTop = current ? (current.row + 1) * l.pitch + 6 : 0;
  const loupeAbove = current ? loupeTop + 70 > l.height && current.row * l.pitch > 80 : false;

  return (
    <div className="flex flex-col gap-2">
      <div ref={wrap} className="relative w-full" onPointerLeave={(e) => e.pointerType === "mouse" && current?.source === "pointer" && setActive(null)}>
        <canvas
          ref={canvas}
          tabIndex={0}
          role="img"
          aria-label={`Blunderprint: ${ribbons.length} analysed games, newest at the top, one tick per move. Use the arrow keys to explore and Enter to open a game.`}
          aria-describedby="blunderprint-status"
          className={`block cursor-crosshair touch-manipulation rounded-[1px] focus-visible:outline-offset-4`}
          style={{ width: l.width, height: l.height }}
          onPointerMove={onPointerMove}
          onPointerDown={(e) => (pointerType.current = e.pointerType)}
          onClick={onClick}
          onKeyDown={onKeyDown}
          onBlur={() => current?.source === "key" && setActive(null)}
        />
        {current && game && (
          <>
            {/* The hovered row and tick, outlined in ink. */}
            <div
              ref={highlight}
              className="pointer-events-none absolute -inset-x-1 border border-ink/70"
              style={{ top: current.row * l.pitch - 1, height: l.rowH + 2 }}
            />
            {current.ply !== null && current.ply <= l.columns && (
              <div
                className="pointer-events-none absolute border border-ink"
                style={{ top: current.row * l.pitch - 3, height: l.rowH + 6, left: (current.ply - 1) * l.tickW - 1, width: Math.max(3, l.tickW + 2) }}
              />
            )}
            <Loupe
              game={game}
              ply={current.ply}
              top={loupeAbove ? current.row * l.pitch - 6 : loupeTop}
              above={loupeAbove}
              touch={current.source === "tap"}
              href={(ply) => gameHref(game.gameId, ply)}
              onOpen={(ply) => open(current.row, ply)}
            />
          </>
        )}
      </div>
      <p id="blunderprint-status" className="sr-only" aria-live="polite">
        {describeActive()}
      </p>
    </div>
  );
}

// One game's full row, larger, with what's under the pointer. Absolutely placed under (or over)
// the hovered row; pointer events here don't reach the canvas, so moving onto the loupe keeps it.
function Loupe({
  game,
  ply,
  top,
  above,
  touch,
  href,
  onOpen,
}: {
  game: Ribbon;
  ply: number | null;
  top: number;
  above: boolean;
  touch: boolean;
  href: (ply: number) => string;
  onOpen: (ply: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hoverPly, setHoverPly] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const shownPly = hoverPly ?? ply;
  const plies = game.classes.length;
  const cut = truncation(game.classes, game.color);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el || width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(width * dpr);
    el.height = Math.round(LOUPE_H * dpr);
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, LOUPE_H);
    const w = width / plies;
    for (let p = 1; p <= plies; p++) {
      ctx.fillStyle = TICK_COLOR[tickAt(game.classes, p, game.color)];
      // A hairline gap between ticks at this size, so single moves can be told apart.
      ctx.fillRect((p - 1) * w, 0, Math.max(1, w - (w > 3 ? 1 : 0)), LOUPE_H);
    }
    if (shownPly) {
      ctx.strokeStyle = "#1b1d1a";
      ctx.lineWidth = 1.5;
      ctx.strokeRect((shownPly - 1) * w + 0.75, 0.75, Math.max(2, w - 1.5), LOUPE_H - 1.5);
    }
  }, [game, plies, width, shownPly]);

  const plyAt = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return loupePly(rect.width, plies, e.clientX - rect.left);
  };
  const kind = shownPly ? errorKindAt(game.classes, shownPly, game.color) : null;

  return (
    <div
      className="absolute inset-x-0 z-20 flex flex-col gap-1.5 border border-ink/20 bg-bone px-3 py-2 shadow-[0_2px_0_rgba(27,29,26,0.08)]"
      style={above ? { bottom: `calc(100% - ${top}px)` } : { top }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 font-mono text-xs text-graphite">
        <span>
          {fullDate(game.playedAt)} · {RESULT[game.result]} · {game.speed} · as {game.color}
        </span>
        <span className={kind ? TEXT[kind] : ""}>
          {shownPly ? `move ${moveName(shownPly)}${kind ? ` · ${KIND_WORD[kind]}` : ""}` : `${Math.ceil(plies / 2)} moves`}
          {cut.cut && !shownPly && " · longer than the chart shows"}
        </span>
      </div>
      <div ref={box} className="w-full">
        <canvas
          ref={canvas}
          className="block cursor-pointer"
          style={{ width, height: LOUPE_H }}
          aria-hidden="true"
          onPointerMove={(e) => setHoverPly(plyAt(e))}
          onPointerLeave={() => setHoverPly(null)}
          onClick={(e) => {
            const p = plyAt(e);
            if (p) onOpen(p);
          }}
        />
      </div>
      {touch && shownPly && (
        <a href={href(shownPly)} className="btn-quiet self-start text-xs" onClick={(e) => (e.preventDefault(), onOpen(shownPly))}>
          Open at move {moveName(shownPly)} →
        </a>
      )}
    </div>
  );
}
