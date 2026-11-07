"use client";

import { useReducedMotion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { PLATFORM_NAMES } from "@/lib/api";
import { ANNOTATION, statText } from "@/lib/coach";
import { dayDate, fullDate } from "@/lib/format";
import { drawRows, hitTest, moveName } from "../patterns/geometry";
import { TEXT } from "../review/classes";
import type { DemoNote, DemoSnapshot } from "./demoData";
import { clockText, heroDurationMs, heroFrame, heroLayout, noteStartMs, placeNotes, SCAN_END_MS, tickCentre } from "./heroTimeline";

// The landing hero, "the print develops" (heroTimeline.ts has the phases): the demo player's
// 200 games arrive as faint rows, an engine pass colours them, then the coach marks three real
// evidence moves from their report with margin notes, like annotations in a chess book.
//
// - One canvas, drawn by the same drawRows as the dashboard's Blunderprint.
// - Driven by elapsed time; the loop only runs while the canvas changes (until the engine pass
//   ends), never offscreen. Timers land the final canvas and every note even if no animation
//   frame runs (a throttled tab), the same idea as AnimatedNumber's countTo. And if no frame has
//   run at all STALL_MS after the start while the hero is in view, nobody is seeing it play: it
//   jumps straight to the final state instead of waiting out the 5.7 s timeline.
// - The notes, rings and leaders are DOM/SVG with CSS transitions, so their final state is
//   their normal style. Reduced motion: the final print and all three notes at once.
// - Notes beside the print (wide screens), once finished: they take turns being highlighted;
//   hovering a note or the print pauses that. Hover the print to read a game, click to open it.
//   Too narrow for that (phones, ~1024 px windows): the notes are a numbered list under the
//   print; tapping one highlights its move, and nothing loops.

const GAP = 28; // print → margin notes
const NOTE_W = 248;
const NOTE_MIN_GAP = 108; // the tallest note plus breathing room
const THIN_BELOW = 480; // a box narrower than this: phone rows (1 + 0.5 px)
const MIN_PRINT_W = 400; // a print narrower than this beside the notes: notes go under it instead
const LAND_MARGIN_MS = 150;
const STALL_MS = 800;
const CYCLE_MS = 3500;
const INK = "#1b1d1a";

type Hover = { row: number; ply: number | null };

export function HeroPrint({ demo }: { demo: DemoSnapshot }) {
  const router = useRouter();
  const reduced = !!useReducedMotion();
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const counter = useRef<HTMLSpanElement>(null);
  const [boxW, setBoxW] = useState(0);
  const [run, setRun] = useState(0); // bumped by Replay
  const [notesShown, setNotesShown] = useState(0);
  const [finished, setFinished] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const paused = useRef(false); // the pointer is on a note or the print
  const inView = useRef(true);

  const { ribbons, notes } = demo;
  const notesOn = reduced ? notes.length : notesShown;
  const done = reduced || finished;

  // ---- Size --------------------------------------------------------------------------------------
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setBoxW(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // Two separate switches: thin rows on phones; notes under the print (a numbered list) whenever
  // the print would get too narrow beside them (phones, and e.g. a 1024 px window, where the
  // hero column is ~600 px).
  const thin = boxW > 0 && boxW < THIN_BELOW;
  const stacked = boxW > 0 && boxW - GAP - NOTE_W < MIN_PRINT_W;
  const printW = stacked ? boxW : Math.max(0, boxW - GAP - NOTE_W);
  const lengths = useMemo(() => ribbons.map((r) => r.classes.length), [ribbons]);
  const l = useMemo(() => heroLayout(printW, lengths, thin), [printW, lengths, thin]);
  const noteRows = useMemo(() => notes.map((n) => ribbons.findIndex((r) => r.gameId === n.evidence.gameId)), [notes, ribbons]);
  const rings = noteRows.map((row, k) => tickCentre(l, row, notes[k]!.evidence.ply));
  const tops = placeNotes(
    rings.map((r) => r.y - 10),
    l.height,
    NOTE_MIN_GAP,
  );

  // ---- The animation -------------------------------------------------------------------------------
  const started = useRef<{ run: number; at: number } | null>(null);
  useEffect(() => {
    const el = canvas.current;
    if (!el || l.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(l.width * dpr);
    el.height = Math.max(1, Math.round(l.height * dpr));
    const ctx = el.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // CSS pixels, sharp on high-DPI screens

    const paint = (t: number) => {
      const f = heroFrame(t, ribbons.length, l, notes.length);
      drawRows(ctx, l, ribbons, f.rowAlpha, f.colouredUpTo);
      if (f.scanX !== null) {
        ctx.fillStyle = INK;
        ctx.fillRect(Math.min(l.width - 1, f.scanX), 0, 1, l.height);
      }
      if (counter.current) counter.current.textContent = String(f.games);
    };
    if (reduced) {
      paint(Infinity);
      return;
    }

    // A resize mid-animation redraws at the same point in time instead of starting over.
    if (!started.current || started.current.run !== run) started.current = { run, at: performance.now() };
    const at = started.current.at;
    const elapsed = performance.now() - at;

    let frame = 0;
    let sawFrame = false;
    const loop = (fromFrame: boolean) => {
      if (fromFrame) sawFrame = true;
      const t = performance.now() - at;
      paint(t);
      frame = t < SCAN_END_MS && inView.current ? requestAnimationFrame(() => loop(true)) : 0;
    };
    loop(false);

    const finishNow = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      timers.forEach((id) => window.clearTimeout(id));
      paint(Infinity);
      setNotesShown(notes.length);
      setFinished(true);
    };

    const timers: number[] = [
      // The canvas's final state, frames or not.
      window.setTimeout(() => {
        cancelAnimationFrame(frame);
        frame = 0;
        paint(Infinity);
      }, Math.max(0, SCAN_END_MS + LAND_MARGIN_MS - elapsed)),
      ...notes.map((_, k) => window.setTimeout(() => setNotesShown((c) => Math.max(c, k + 1)), Math.max(0, noteStartMs(k) - elapsed))),
      window.setTimeout(() => setFinished(true), Math.max(0, heroDurationMs(notes.length) - elapsed)),
    ];
    // No animation frames (a throttled or background tab, a browser that has them switched off).
    if (elapsed < STALL_MS) {
      timers.push(
        window.setTimeout(() => {
          if (!sawFrame && inView.current) finishNow();
        }, STALL_MS - elapsed),
      );
    }

    // Offscreen: no frames. Back in view: carry on from the current time.
    const io = new IntersectionObserver(([entry]) => {
      inView.current = entry!.isIntersecting;
      if (inView.current && !frame && performance.now() - at < SCAN_END_MS) frame = requestAnimationFrame(() => loop(true));
    });
    io.observe(el);

    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((id) => window.clearTimeout(id));
      io.disconnect();
    };
  }, [l, ribbons, notes, reduced, run]);

  // ---- Idle: the notes take turns (desktop only, never offscreen or in a hidden tab) -------------------
  useEffect(() => {
    if (!done || stacked || reduced) return;
    const id = window.setInterval(() => {
      if (paused.current || !inView.current || document.hidden) return;
      setActive((a) => ((a ?? -1) + 1) % notes.length);
    }, CYCLE_MS);
    return () => window.clearInterval(id);
  }, [done, stacked, reduced, notes.length]);

  const replay = () => {
    setNotesShown(0);
    setFinished(false);
    setActive(null);
    setRun((r) => r + 1);
  };

  const gameHref = (gameId: string, ply: number) =>
    `/p/${demo.platform}/${encodeURIComponent(demo.username)}/game/${encodeURIComponent(gameId)}${ply > 0 ? `?ply=${ply}` : ""}`;

  // ---- The print under the mouse (desktop) ----------------------------------------------------------
  const hitAt = (e: React.PointerEvent | React.MouseEvent) => {
    const rect = canvas.current!.getBoundingClientRect();
    return hitTest(l, lengths, e.clientX - rect.left, e.clientY - rect.top);
  };
  const hovered = hover ? ribbons[hover.row] : null;
  const activeRow = hover ? hover.row : active !== null && active < notesOn ? noteRows[active]! : null;

  const caption = hovered
    ? `${fullDate(hovered.playedAt)} · ${hovered.result} · ${hovered.speed} · as ${hovered.color}${hover?.ply ? ` · move ${moveName(hover.ply)}` : ""}`
    : "Hover the print to read a game; click to open it.";

  return (
    <figure className="flex min-w-0 flex-col gap-3">
      <p className="font-mono text-xs text-graphite tabular-nums">
        <span ref={counter} aria-hidden="true">
          0
        </span>
        <span className="sr-only">{ribbons.length}</span> games · {PLATFORM_NAMES[demo.platform]} · {demo.username}
      </p>

      <div ref={box} className="relative w-full" style={{ height: stacked ? undefined : l.height || 600 }}>
        <canvas
          ref={canvas}
          role="img"
          aria-label={`A Blunderprint: ${ribbons.length} games of the Lichess account ${demo.username}, one row per game, one tick per move, coloured where the player went wrong. The coach's three notes are listed beside it.`}
          className={`block ${thin ? "" : "cursor-pointer"}`}
          style={{ width: l.width, height: l.height }}
          onPointerMove={(e) => {
            if (e.pointerType !== "mouse" || thin) return;
            paused.current = true;
            const hit = hitAt(e);
            setHover(hit);
          }}
          onPointerLeave={() => {
            paused.current = false;
            setHover(null);
          }}
          onClick={(e) => {
            if (thin) return;
            const hit = hitAt(e);
            if (hit) router.push(gameHref(ribbons[hit.row]!.gameId, hit.ply ?? 0));
          }}
        />

        {/* The hovered or highlighted game's row, outlined in ink. */}
        {activeRow !== null && l.width > 0 && (
          <div
            className="pointer-events-none absolute border border-ink/60"
            style={{ left: -3, width: l.width + 6, top: activeRow * l.pitch - 2, height: l.rowH + 4 }}
          />
        )}

        {/* Rings on the evidence moves and the hairline leaders to the notes. */}
        {l.width > 0 && (
          <svg className="pointer-events-none absolute top-0 left-0 overflow-visible" width={boxW} height={l.height} aria-hidden="true">
            {rings.map((c, k) => {
              const on = k < notesOn;
              const lit = active === k;
              const r = thin ? 4 : 5.5;
              const top = tops[k]! + 9;
              const leader = `M ${c.x + r} ${c.y} L ${l.width + 8} ${c.y} L ${l.width + GAP - 6} ${top}`;
              return (
                <g key={k} className="text-ink">
                  <circle
                    cx={c.x}
                    cy={c.y}
                    r={r}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={lit ? 2 : 1.25}
                    pathLength={1}
                    strokeDasharray="1"
                    strokeDashoffset={on ? 0 : 1}
                    opacity={on ? 1 : 0}
                    className="hero-in transition-[stroke-dashoffset,stroke-width] duration-300 ease-out"
                  />
                  {stacked ? (
                    <text
                      x={c.x + r + 2}
                      y={c.y - r}
                      className={`hero-in fill-current font-mono text-[10px] transition-opacity duration-300 ${on ? "opacity-100" : "opacity-0"}`}
                    >
                      {k + 1}
                    </text>
                  ) : (
                    <path
                      d={leader}
                      fill="none"
                      stroke="currentColor"
                      strokeOpacity={lit ? 0.9 : 0.45}
                      strokeWidth={1}
                      pathLength={1}
                      strokeDasharray="1"
                      strokeDashoffset={on ? 0 : 1}
                      opacity={on ? 1 : 0}
                      className="hero-in transition-[stroke-dashoffset] delay-150 duration-500 ease-out"
                    />
                  )}
                </g>
              );
            })}
          </svg>
        )}

        {/* Desktop: the margin notes, level with their moves. */}
        {!stacked && l.width > 0 && (
          <ol className="absolute top-0" style={{ left: l.width + GAP, width: NOTE_W }}>
            {notes.map((n, k) => (
              <li key={k} className="absolute inset-x-0" style={{ top: tops[k] }}>
                <Note
                  note={n}
                  on={k < notesOn}
                  lit={active === k}
                  href={gameHref(n.evidence.gameId, n.evidence.ply)}
                  onEnter={() => {
                    paused.current = true;
                    setActive(k);
                  }}
                  onLeave={() => (paused.current = false)}
                />
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="flex min-h-5 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono text-xs text-graphite">
        {!thin && <span className="tabular-nums">{caption}</span>}
        {!reduced && (
          <button type="button" className="btn-quiet disabled:opacity-40" onClick={replay} disabled={!done}>
            Replay
          </button>
        )}
      </div>

      {/* Phones: the notes as a numbered list under the print. */}
      {stacked && (
        <ol className="flex flex-col gap-3 sm:grid sm:grid-cols-3 sm:gap-5">
          {notes.map((n, k) => (
            <li key={k} className="grid grid-cols-[1.25rem_1fr] gap-2">
              <span className="pt-2.5 font-mono text-xs text-graphite">{k + 1}</span>
              <Note note={n} on={k < notesOn} lit={active === k} href={gameHref(n.evidence.gameId, n.evidence.ply)} onEnter={() => setActive(k)} onLeave={() => {}} />
            </li>
          ))}
        </ol>
      )}

      <figcaption className="flex flex-col gap-1 text-xs text-graphite">
        <span className="font-mono">
          {PLATFORM_NAMES[demo.platform]} · {demo.username} · {demo.analysedGames} public games, analysed in the browser · as of {dayDate(demo.lastImportedAt)}
        </span>
        <span className="text-graphite/70">Not affiliated with the player: these are the account&apos;s public games.</span>
      </figcaption>
    </figure>
  );
}

// One margin note: the move, its clock and cost; the pattern and its number (both from code).
function Note({
  note,
  on,
  lit,
  href,
  onEnter,
  onLeave,
}: {
  note: DemoNote;
  on: boolean;
  lit: boolean;
  href: string;
  onEnter: () => void;
  onLeave: () => void;
}) {
  const e = note.evidence;
  const t = statText(note.stat);
  const move = `${e.moveNumber}${e.color === "black" ? "…" : "."} ${e.played}${ANNOTATION[e.kind]}`;
  const facts = [e.facts.clockLeftSeconds != null ? `${clockText(e.facts.clockLeftSeconds)} left` : null, `−${Math.round(e.winPctLost)} pts`].filter(Boolean);

  return (
    <div
      className={`hero-in flex flex-col gap-1 border-l py-0.5 pl-3 transition-[opacity,translate,border-color] duration-500 ease-out ${
        on ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0"
      } ${lit ? "border-ink" : "border-ink/15"}`}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={onEnter}
    >
      <span className="font-mono text-xs text-graphite tabular-nums">
        <span className={TEXT[e.kind]}>{move}</span> · {facts.join(" · ")}
      </span>
      <span className={`text-sm leading-snug transition-colors ${lit ? "text-ink" : "text-graphite"}`}>{note.title}</span>
      <span className="font-mono text-sm text-ink tabular-nums">
        {t.value(note.stat.value)} <span className="text-graphite">vs your {t.baseline}</span>
      </span>
      <Link href={href} className="self-start py-1 font-mono text-xs text-graphite underline decoration-ink/25 underline-offset-2 transition-colors hover:text-ink hover:decoration-ink active:opacity-70" tabIndex={on ? 0 : -1}>
        Open the game →
      </Link>
    </div>
  );
}
