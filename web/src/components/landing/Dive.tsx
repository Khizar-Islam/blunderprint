"use client";

// The landing page's one continuous dive (phases in diveTimeline.ts): the demo player's print, one game
// of it, one move of that game, the position, and the coach's checked sentence about that move.
// The page's scroll position is the only input; everything on the stage is placed from it with
// transforms and opacity (never top/left: a moved `top` would count as layout shift).
//
// All data is the committed snapshot (src/data/demo.json), so nothing here waits on the API.
// The hero words are the page's own (server-rendered) children: this component only fades them.
//
// No animation frames (a throttled tab): timers land the first screen's final print, and a
// scroll paints directly. Reduced motion: no pinned stage at all; the first screen's final
// print, then a second, still stage with the dive's final picture (globals: motion-reduce).

import Link from "next/link";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { arrowOf, boardXY, piecesOf, pieceSrc, type Side } from "@/components/MiniBoard";
import { errorKindAt, INK, isPlayersPly, moveName, RIDGE, TICK_COLOR } from "@/components/patterns/geometry";
import type { ErrorKind } from "@/lib/api";
import { ANNOTATION, statText } from "@/lib/coach";
import { demo } from "./demoData";
import { DIVE_COLS, divePhases, diveRows, errorsFoundUpTo, lerp, resultWords, seg, splitFigure, stageBox, utcDay, xlerp } from "./diveTimeline";
import { clockText, heroFrame, SCAN_END_MS } from "./heroTimeline";
import { PrintLink } from "./PrintLink";

const RUST = "#D9772B"; // hex, not CSS variables: SVG attributes and canvas fills
const TEAL = "#3E7C74";
const QUIET = "#5c5b55"; // graphite at 70% on bone: the strip's move numbers
// A move's name under the strip, in its classification's text colour (globals.css *-text tokens).
const KIND_TEXT: Record<ErrorKind, string> = { blunder: "#ad3026", mistake: "#944902", inaccuracy: INK };

const STALL_MS = 400; // no animation frame by then: the browser isn't giving any
const PLAY_MS = 11_000; // "Play the dive": the whole scroll, played by the page

// ---- The one move the dive follows (chosen by scripts/snapshot-demo.mjs) -------------------------
const note = demo.notes[demo.dive.note]!;
const ev = note.evidence;
const ROWS = diveRows(demo.ribbons);
const ROW = demo.ribbons.findIndex((r) => r.gameId === ev.gameId);
const GAME = demo.ribbons[ROW]!;
const PLY = ev.ply;
const SANS = demo.dive.sans;
const FOUND = errorsFoundUpTo(ROWS);
const TOTAL_ERRORS = FOUND[FOUND.length - 1]!;
const FINAL_COUNTER = `${ROWS.length} games · ${TOTAL_ERRORS.toLocaleString("en")} errors found`;

const SIDE: Side = ev.color ?? GAME.color;
const PIECES = piecesOf(ev.fen, SIDE);
const FROM = ev.playedUci ? boardXY(ev.playedUci.slice(0, 2), SIDE) : null;
const TO = ev.playedUci ? boardXY(ev.playedUci.slice(2, 4), SIDE) : null;
const RUST_ARROW = ev.playedUci ? arrowOf(ev.playedUci, SIDE) : null;
const TEAL_ARROW = ev.betterUci ? arrowOf(ev.betterUci, SIDE) : null;

const MOVE = `${moveName(PLY)} ${ev.played}${ANNOTATION[ev.kind]}`; // "47. Nd4??"
const CLOCK = ev.facts.clockLeftSeconds == null ? null : clockText(ev.facts.clockLeftSeconds);
const STAT = statText(note.stat);
const [BEFORE, FIGURE, AFTER] = splitFigure(demo.dive.sentence, demo.dive.figure);
const PLATFORM = demo.platform === "lichess" ? "Lichess" : "Chess.com";
const BASE = `/p/${demo.platform}/${encodeURIComponent(demo.username)}`;

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a: string, b: string, t: number) {
  const A = hex(a);
  const B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i]!, t))).join(",")})`;
}

const REDUCED = "(prefers-reduced-motion: reduce)";

// One stage. `at` undefined: pinned, driven by how far its parent (the tall track) has been
// scrolled. A number: a still picture of the dive at that point (reduced motion).
// The stage's moving parts are found by their `data-el` name and styled directly: a scroll
// must not re-render React.
function Stage({ at, className }: { at?: number; className: string }) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const repaint = useRef<() => void>(() => {});

  // The 12 piece drawings are fetched once the browser is idle, never in the first screen's way.
  const [pieces, setPieces] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setPieces(true), 1500);
    return () => window.clearTimeout(id);
  }, []);
  useEffect(() => repaint.current(), [pieces]);

  useEffect(() => {
    const cv = canvas.current!;
    const st = stage.current!;
    const ctx = cv.getContext("2d")!;
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-geist-mono") || "monospace";
    const t0 = performance.now();
    let W = 0;
    let H = 0;
    let dpr = 0;
    let box = stageBox(1, 1, false, ROWS.length);
    let capH = 0;
    let frame = 0;
    let sawFrame = false;
    let noFrames = false;
    // Reduced motion is read when it is needed, not kept in React state: the pinned stage then
    // stands still at the first screen's final picture (the CSS un-pins it, motion-reduce:).
    const reduced = window.matchMedia(REDUCED);
    const stillAt = () => at ?? (reduced.matches ? 0 : null);

    const track = st.parentElement!;
    // The hero words (the page's own, outside the stage): only the pinned stage fades them.
    const heroEl = at === undefined ? (st.closest("[data-dive]")?.querySelector<HTMLElement>("[data-dive-hero]") ?? null) : null;
    const found: Record<string, HTMLElement | null> = {};
    // Looked up once; a part that isn't there yet (the pieces arrive later) is looked up again.
    const part = (name: string) => (found[name] ??= st.querySelector<HTMLElement>(`[data-el="${name}"]`));
    const style = (name: string, s: Partial<CSSStyleDeclaration>) => {
      const node = part(name);
      if (node) Object.assign(node.style, s);
    };
    // Placed by a transform; hidden from the pointer, the keyboard and screen readers while unseen.
    const put = (name: string, x: number, y: number, opacity = 1, extra = "") =>
      style(name, {
        transform: `translate3d(${x.toFixed(2)}px, ${y.toFixed(2)}px, 0)${extra}`,
        opacity: opacity.toFixed(3),
        visibility: opacity <= 0.001 ? "hidden" : "visible",
      });
    const show = (name: string, opacity: number) => style(name, { opacity: opacity.toFixed(3), visibility: opacity <= 0.001 ? "hidden" : "visible" });

    const size = () => {
      const w = st.clientWidth;
      const h = st.clientHeight;
      if (!w || !h) return false; // not shown (the still stage without reduced motion)
      const d = window.devicePixelRatio || 1;
      if (w !== W || h !== H || d !== dpr) {
        W = w;
        H = h;
        dpr = d;
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const wide = window.matchMedia("(min-width: 1280px)").matches;
      box = stageBox(W, H, wide, ROWS.length);
      const words = part("words");
      const cap = part("boardCap");
      if (wide) {
        style("words", { width: `${W - (box.bx + box.board + 64)}px` });
      } else {
        // Phones: the caption and the words sit under the board, so the board shrinks to what they leave.
        style("words", { width: `${W}px` });
        style("boardCap", { width: `${W}px` });
        const room = H - box.by - 12 - (cap?.offsetHeight ?? 44) - 16 - (words?.offsetHeight ?? 380) - 8;
        box = stageBox(W, H, false, ROWS.length, room);
      }
      if (wide) style("boardCap", { width: `${box.board}px` });
      // The print's caption is as wide as the print (beside the words, that is the right part of the stage).
      style("cue", { width: `${W - box.hx}px` });
      style("board", { width: `${box.board}px`, height: `${box.board}px` });
      capH = cap?.offsetHeight ?? 44;
      return true;
    };

    const progress = (still: number | null) => {
      if (still !== null) return still;
      const r = track.getBoundingClientRect();
      return Math.max(0, Math.min(1, -r.top / Math.max(1, r.height - window.innerHeight)));
    };

    const render = () => {
      frame = 0;
      if (!W) return;
      const still = stillAt();
      const p = progress(still);
      // The first screen develops with time; once it has been scrolled it is simply final.
      const devT = still !== null || noFrames || p > 0.02 ? Infinity : performance.now() - t0;
      const ph = divePhases(p);
      const { a, b, c } = ph;
      const { wide, hx, hy, pitch0, rowH0, board: S, bx, by } = box;

      // ---- Geometry ----------------------------------------------------------------------------
      const hw = W - hx;
      const cw0 = hw / DIVE_COLS; // a move's width on the first screen
      const cw1 = W / DIVE_COLS; // … once the print has taken the whole stage
      const cw2 = wide ? 76 : 54; // … once one move is a square
      const stripH = wide ? 30 : 22;
      const cw = b > 0 ? xlerp(cw1, cw2, b) : xlerp(cw0, cw1, a);
      const xT0 = hx + (PLY - 0.5) * cw0; // the move's centre on the first screen
      const xT1 = (PLY - 0.5) * cw1;
      const xT = b > 0 ? lerp(xT1, W / 2, b) : lerp(xT0, xT1, a);
      const X = xT - (PLY - 0.5) * cw; // where ply 1 starts
      const yStrip = Math.round(H * (wide ? 0.4 : 0.34));
      const yT = lerp(hy + ROW * pitch0, yStrip, a);
      const rowHT = b > 0 ? lerp(stripH, cw2 - 8, b) : xlerp(rowH0, stripH, a);
      const pitch = xlerp(pitch0, wide ? 58 : 40, a);
      const otherH = lerp(rowH0, 3, a);
      const otherA = (1 - 0.72 * a) * (1 - seg(p, 0.31, 0.4));

      // ---- Canvas ------------------------------------------------------------------------------
      // The canvas is kept on whole device pixels. The words above the stage can end on a
      // fraction of a pixel, and a canvas of 1 px rows drawn half a pixel off is resampled by
      // the browser: on a 1x screen the print came out dark and colourless.
      const at0 = st.getBoundingClientRect();
      const snap = (v: number) => -((((v * dpr) % 1) + 1) % 1) / dpr;
      cv.style.transform = `translate(${snap(at0.left).toFixed(3)}px, ${snap(at0.top).toFixed(3)}px)`;
      ctx.clearRect(0, 0, W, H);
      const f = heroFrame(devT, ROWS.length, { columns: DIVE_COLS, tickW: cw0 });
      const upTo = f.colouredUpTo;

      // The other 199 games: a quiet line each, a mark per error.
      if (otherA > 0.01) {
        for (let r = 0; r < ROWS.length; r++) {
          if (r === ROW) continue;
          const y = yT + (r - ROW) * pitch + (r > ROW ? rowHT - otherH : 0);
          if (y < -4 || y > H + 4) continue;
          const row = ROWS[r]!;
          const alpha = f.rowAlpha(r) * otherA;
          if (alpha <= 0) continue;
          ctx.globalAlpha = alpha;
          ctx.fillStyle = RIDGE;
          ctx.fillRect(X, y, Math.min(row.len, DIVE_COLS) * cw, otherH);
          for (const er of row.errs) {
            if (er.ply > DIVE_COLS || er.ply > upTo) continue;
            ctx.fillStyle = TICK_COLOR[er.kind];
            ctx.fillRect(X + (er.ply - 1) * cw, y, Math.max(2.5, cw * 2), otherH);
          }
        }
      }

      // The one game: a quiet line that opens into single moves.
      const stripA = f.rowAlpha(ROW) * (1 - seg(p, 0.575, 0.62));
      const row = ROWS[ROW]!;
      if (stripA > 0.01) {
        const gap = Math.min(cw * 0.16, 8) * a;
        const last = a > 0 ? row.len : Math.min(row.len, DIVE_COLS);
        ctx.globalAlpha = stripA;
        // Errors are drawn in a second pass, over their neighbours.
        for (let pass = 0; pass < 2; pass++) {
          for (let ply = 1; ply <= last; ply++) {
            const x = X + (ply - 1) * cw;
            if (x > W || x + cw * 2 < 0) continue;
            const kind = ply <= upTo ? errorKindAt(row.classes, ply, row.color) : null;
            if ((pass === 1) !== !!kind) continue;
            if (ply === PLY && c > 0) continue; // on its way to the board (the DOM square below)
            ctx.fillStyle = kind ? TICK_COLOR[kind] : mix(RIDGE, isPlayersPly(ply, row.color) ? TICK_COLOR.own : TICK_COLOR.opponent, a);
            const w = kind ? Math.max(2.5 * (1 - a), cw * lerp(2, 1, a) - gap) : cw - gap;
            ctx.fillRect(x + gap / 2, yT, Math.max(0.5, w), rowHT);
          }
        }
        // The moves' names, once a move is wide enough to carry one.
        const la = seg(cw, 34, 56) * (1 - seg(p, 0.57, 0.62));
        if (la > 0.01) {
          ctx.textAlign = "center";
          for (let ply = 1; ply <= row.len; ply++) {
            const x = X + (ply - 0.5) * cw;
            if (x < -40 || x > W + 40) continue;
            const kind = errorKindAt(row.classes, ply, row.color);
            const target = ply === PLY;
            ctx.globalAlpha = la * stripA * (target ? 1 : 0.75);
            ctx.font = `${target ? 600 : 400} ${wide ? 14 : 12}px ${mono}`;
            ctx.fillStyle = target ? KIND_TEXT[ev.kind] : INK;
            ctx.fillText(`${SANS[ply - 1] ?? ""}${kind ? ANNOTATION[kind] : ""}`, x, yT + rowHT + 22);
            if (ply % 2 === 1) {
              ctx.font = `400 11px ${mono}`;
              ctx.fillStyle = QUIET;
              ctx.fillText(`${Math.ceil(ply / 2)}`, x, yT - 10);
            }
          }
        }
        // Move numbers along the strip, before the sideways zoom.
        const ax = a * (1 - seg(p, 0.33, 0.4));
        if (ax > 0.01) {
          ctx.globalAlpha = ax * 0.9;
          ctx.font = `400 11px ${mono}`;
          ctx.fillStyle = QUIET;
          ctx.textAlign = "center";
          for (let m = 10; m <= Math.ceil(row.len / 2); m += 10) ctx.fillText(`${m}`, X + (m * 2 - 1.5) * cw, yT + rowHT + 18);
        }
      }

      // The ring that keeps the eye on the move, from the first screen to the square.
      const ringOn = (devT >= SCAN_END_MS + 300 ? 1 : 0) * (1 - seg(p, 0.42, 0.5));
      if (ringOn > 0.01) {
        ctx.globalAlpha = ringOn;
        ctx.strokeStyle = INK;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(xT, yT + rowHT / 2, Math.max(7, rowHT * 0.5 + 6 + a * 4), 0, Math.PI * 2);
        ctx.stroke();
      }

      // The engine's pass over the first screen.
      if (a === 0 && f.scanX !== null) {
        ctx.globalAlpha = 1;
        ctx.fillStyle = INK;
        ctx.fillRect(hx + Math.min(hw - 1, f.scanX), hy - 6, 1, ROWS.length * pitch0 + 12);
      }
      ctx.globalAlpha = 1;
      // While the print is whole and developed, the canvas says where it is ("x,y,width,height"):
      // "Open this Blunderprint" carries a copy of it onto the dashboard (lib/printCarry.ts).
      if (at === undefined && a === 0 && devT >= SCAN_END_MS) cv.dataset.print = `${hx},${hy},${hw},${ROWS.length * pitch0}`;
      else delete cv.dataset.print;

      // ---- The first screen's words and labels ---------------------------------------------------
      if (heroEl) {
        // Side by side, the words fade as the print takes the stage; stacked, they just scroll away.
        const o = wide && still === null ? 1 - seg(p, 0, 0.06) : 1;
        heroEl.style.opacity = o.toFixed(3);
        heroEl.style.visibility = o <= 0.001 ? "hidden" : "visible";
      }
      const counter = part("counter");
      if (counter) {
        const found = upTo === Infinity ? TOTAL_ERRORS : FOUND[Math.min(DIVE_COLS, upTo)]!;
        const text = `${f.games} games · ${found.toLocaleString("en")} errors found`;
        if (counter.textContent !== text) counter.textContent = text;
      }
      put("counterBox", hx, hy - 34, 1 - seg(p, 0.02, 0.1));
      const noteOn = devT >= SCAN_END_MS + 600 ? 1 - seg(p, 0.03, 0.12) : 0;
      put("note", Math.max(0, Math.min(W - 262, xT0 + 14)), hy + ROW * pitch0 + 16, noteOn);
      const cueOn = (devT >= SCAN_END_MS + 900 ? 1 : 0) * (1 - seg(p, 0, 0.04));
      // Right under the print, in the print's own column. It used to sit at the bottom of the
      // whole stage: on a short laptop screen that put it across the words, between the demo's
      // label and its links.
      put("cue", hx, hy + ROWS.length * pitch0 + 12, cueOn);

      // ---- A, B: the game, and what the eye is on ----------------------------------------------
      put("gameCap", 0, yT - (wide ? lerp(34, 44, b) : lerp(44, 66, b)), a * (1 - seg(p, 0.58, 0.64)));
      put("steps", 0, yT + rowHT + (wide ? 56 : 44));
      show("stepA", seg(p, 0.14, 0.24) * (1 - seg(p, 0.33, 0.38)));
      show("stepB", seg(p, 0.42, 0.52) * (1 - seg(p, 0.57, 0.62)));

      // ---- C: the move's square grows into the board (brick first, then the position under it) ----
      const g2 = Math.min(cw * 0.16, 8);
      // Phones: once its story is told, the board shrinks (and stays centred) to leave the words room.
      const side = wide ? S : lerp(S, box.small, ph.shrink);
      const boardX = wide ? bx : (W - side) / 2;
      const k = lerp((cw - g2) / S, 1, c) * (side / S);
      style("board", {
        transform: `translate3d(${lerp(xT - cw / 2 + g2 / 2, boardX, c).toFixed(2)}px, ${lerp(yT, by, c).toFixed(2)}px, 0) scale(${k.toFixed(4)})`,
        visibility: c > 0 ? "visible" : "hidden",
      });
      style("brick", { opacity: (1 - seg(c, 0.35, 0.95)).toFixed(3) });

      // ---- D: the move played, back, the better move -------------------------------------------
      if (FROM && TO) {
        const u = S / 8;
        style("mover", { transform: `translate3d(${((TO.x - FROM.x) * u * ph.slide).toFixed(2)}px, ${((TO.y - FROM.y) * u * ph.slide).toFixed(2)}px, 0)` });
      }
      style("rustLine", { strokeDashoffset: (1 - ph.played).toFixed(3) });
      style("rustHead", { opacity: seg(ph.played, 0.8, 1).toFixed(3) });
      style("tealLine", { strokeDashoffset: (1 - ph.better).toFixed(3) });
      style("tealHead", { opacity: seg(ph.better, 0.8, 1).toFixed(3) });
      put("boardCap", wide ? bx : 0, by + side + 12, seg(c, 0.9, 1));
      style("cost", { opacity: seg(ph.played, 0.5, 1).toFixed(3) });
      style("betterCap", { opacity: ph.better.toFixed(3) });

      // ---- E: the coach's words -------------------------------------------------------------------
      const rise = (1 - ph.words) * 14;
      if (wide) put("words", bx + S + 64, by - 4 + rise, ph.words);
      else put("words", 0, by + box.small + 12 + capH + 16 + rise, ph.words);
      style("words", { pointerEvents: ph.words > 0.6 ? "auto" : "none" });
      style("fig", { backgroundSize: `${(ph.check * 100).toFixed(1)}% 2px` });
      style("checked", { opacity: seg(ph.check, 0.6, 1).toFixed(3) });
      show("ctas", ph.ctas);

      if (devT !== Infinity && devT < SCAN_END_MS + 1200) frame = requestAnimationFrame(fromFrame);
    };
    const fromFrame = () => {
      sawFrame = true;
      render();
    };
    // A scroll paints on the next frame; with no frames, right away.
    const ask = () => {
      if (noFrames) render();
      else if (!frame) frame = requestAnimationFrame(fromFrame);
    };
    const onResize = () => {
      if (size()) render();
    };
    repaint.current = () => {
      if (W) render();
    };

    if (size()) render();
    window.addEventListener("resize", onResize);
    if (at === undefined) window.addEventListener("scroll", ask, { passive: true });
    reduced.addEventListener("change", onResize);
    const timers = [
      // No frame yet: this browser isn't giving any. The final first screen, now.
      window.setTimeout(() => {
        if (sawFrame || stillAt() !== null) return;
        noFrames = true;
        render();
      }, STALL_MS),
      // The print's final state and its note land whether or not the last frame ran.
      window.setTimeout(render, SCAN_END_MS + 1300),
    ];
    // The words' height is only right once the web fonts are in.
    void document.fonts?.ready.then(onResize);
    return () => {
      cancelAnimationFrame(frame);
      timers.forEach((id) => window.clearTimeout(id));
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", ask);
      reduced.removeEventListener("change", onResize);
      repaint.current = () => {};
    };
  }, [at]);

  // The same dive, played by the page: one click, about 11 s. Any scroll, key or touch of the
  // visitor's own takes over at once.
  const play = () => {
    const t = stage.current?.parentElement;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const from = window.scrollY;
    const to = from + r.top + r.height - window.innerHeight;
    const start = performance.now();
    let on = true;
    const events = ["wheel", "touchstart", "keydown", "pointerdown"] as const;
    const stop = () => {
      on = false;
      events.forEach((e) => window.removeEventListener(e, stop));
    };
    const step = () => {
      if (!on) return;
      const k = Math.min(1, (performance.now() - start) / PLAY_MS);
      window.scrollTo(0, lerp(from, to, k));
      if (k < 1) requestAnimationFrame(step);
      else stop();
    };
    window.setTimeout(() => events.forEach((e) => window.addEventListener(e, stop, { passive: true })), 0);
    step();
  };

  const layer = "absolute top-0 left-0";
  return (
    <div ref={stage} className={`overflow-hidden ${className}`}>
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" aria-hidden="true" />

      {/* The first screen's labels. */}
      <p data-el="counterBox" className={`${layer} font-mono text-xs whitespace-nowrap text-graphite tabular-nums`}>
        <span data-el="counter" data-dive-counter={FINAL_COUNTER}>
          0 games · 0 errors found
        </span>
        <span className="hidden sm:inline"> · {PLATFORM}</span> · {demo.username}
      </p>
      <div
        data-el="note"
        className={`${layer} flex w-[262px] flex-col gap-0.5 border-l border-ink bg-bone/95 py-1 pl-3 transition-opacity duration-500 motion-reduce:transition-none`}
        style={{ opacity: 0, visibility: "hidden" }}
      >
        <span className="font-mono text-xs text-graphite tabular-nums">
          <span className="text-blunder-text">{MOVE}</span>
          {CLOCK && ` · ${CLOCK} left`} · −{Math.round(ev.winPctLost)} points
        </span>
        <span className="text-sm text-ink">One of {TOTAL_ERRORS.toLocaleString("en")} marks. Scroll to follow it.</span>
      </div>
      <div
        data-el="cue"
        className={`${layer} flex w-full items-center justify-between gap-4 font-mono text-xs text-graphite transition-opacity duration-500 motion-reduce:transition-none`}
        style={{ opacity: 0, visibility: "hidden" }}
      >
        <span>One row per game · one mark per error · newest at the top</span>
        {at === undefined && (
          <button type="button" className="btn-quiet shrink-0 motion-reduce:hidden" onClick={play}>
            Play the dive
          </button>
        )}
      </div>

      {/* A, B: the game, and what the eye is on. */}
      <p data-el="gameCap" className={`${layer} w-full bg-bone py-1 font-mono text-xs text-graphite`} style={{ opacity: 0, visibility: "hidden" }}>
        Game {ROW + 1} of {ROWS.length} · {utcDay(GAME.playedAt)} · {GAME.speed} · {resultWords(GAME.result, GAME.color)} · {Math.ceil(GAME.classes.length / 2)} moves
      </p>
      <div data-el="steps" className={`${layer} w-full text-center font-display text-2xl text-ink`}>
        {/* Each caption has its own clean band of bone: the other games' rows run behind it. */}
        <p data-el="stepA" className="absolute inset-x-0 top-0 bg-bone px-2 py-3 text-balance" style={{ opacity: 0, visibility: "hidden" }}>
          Every row is one game. This is one of them.
        </p>
        <p data-el="stepB" className="absolute inset-x-0 top-0 bg-bone px-2 py-3 text-balance" style={{ opacity: 0, visibility: "hidden" }}>
          Every mark is one move. {CLOCK ? `This one, with ${CLOCK} on the clock.` : "This is one of them."}
        </p>
      </div>

      {/* C, D: the position before the move. */}
      <div
        data-el="board"
        className={`${layer} origin-top-left overflow-hidden rounded-sm`}
        style={{ visibility: "hidden" }}
        role="img"
        aria-label={`The position before ${MOVE}${ev.betterMove ? `; better was ${ev.betterMove}` : ""}`}
      >
        <div className="grid h-full w-full grid-cols-8 grid-rows-8">
          {Array.from({ length: 64 }, (_, i) => (
            <div key={i} className={(Math.floor(i / 8) + i) % 2 === 0 ? "bg-square-light" : "bg-square-dark"} />
          ))}
        </div>
        {pieces &&
          PIECES.map((pc) => {
            const mover = !!FROM && pc.x === FROM.x && pc.y === FROM.y;
            return (
              // Plain <img>: 12 tiny cached files (public/pieces/), as on the dashboard's small boards.
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={`${pc.x}${pc.y}`}
                data-el={mover ? "mover" : undefined}
                src={pieceSrc(pc.name)}
                alt=""
                draggable={false}
                className="absolute h-[12.5%] w-[12.5%] select-none"
                style={{ left: `${pc.x * 12.5}%`, top: `${pc.y * 12.5}%`, zIndex: mover ? 2 : 1 }}
              />
            );
          })}
        <div data-el="brick" className="absolute inset-0 z-[4] bg-blunder" />
        <svg viewBox="0 0 8 8" className="pointer-events-none absolute inset-0 z-[3] h-full w-full" aria-hidden="true">
          <g opacity={0.88}>
            {RUST_ARROW && (
              <>
                <line data-el="rustLine" x1={RUST_ARROW.A.x} y1={RUST_ARROW.A.y} x2={RUST_ARROW.base.x} y2={RUST_ARROW.base.y} stroke={RUST} strokeWidth={0.17} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1} />
                <polygon data-el="rustHead" points={RUST_ARROW.head} fill={RUST} opacity={0} />
              </>
            )}
            {TEAL_ARROW && (
              <>
                <line data-el="tealLine" x1={TEAL_ARROW.A.x} y1={TEAL_ARROW.A.y} x2={TEAL_ARROW.base.x} y2={TEAL_ARROW.base.y} stroke={TEAL} strokeWidth={0.17} strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={1} />
                <polygon data-el="tealHead" points={TEAL_ARROW.head} fill={TEAL} opacity={0} />
              </>
            )}
          </g>
        </svg>
      </div>
      <div
        data-el="boardCap"
        className={`${layer} flex flex-wrap items-baseline justify-between gap-x-4 font-mono text-sm text-graphite`}
        style={{ opacity: 0, visibility: "hidden" }}
      >
        <span>
          <span className="text-blunder-text">{MOVE}</span> <span data-el="cost">lost {ev.winPctLost} win-chance points</span>
        </span>
        {ev.betterMove && (
          <span data-el="betterCap">
            Better was <span className="text-best-text">{ev.betterMove}</span>
          </span>
        )}
      </div>

      {/* E: the coach's checked words about it. */}
      <div data-el="words" className={`${layer} flex flex-col gap-2.5 sm:gap-4`} style={{ opacity: 0, visibility: "hidden" }}>
        <p className="hidden font-mono text-xs text-graphite sm:block">
          From {note.stat.games} of the {demo.analysedGames} games, the coach found:
        </p>
        <h2 className="font-display text-2xl leading-tight text-balance text-ink sm:text-4xl">{note.title}</h2>
        <p className="font-mono text-ink tabular-nums">
          <span className="text-4xl sm:text-6xl">{STAT.value(note.stat.value)}</span> <span className="text-graphite">vs your {STAT.baseline}</span>
        </p>
        <p className="max-w-[34rem] font-display text-lg leading-relaxed text-ink sm:text-xl">
          {BEFORE}
          {FIGURE && (
            // The rule is drawn by the scroll (background-size), like an answer's figure (globals: figure-rule).
            <span
              data-el="fig"
              className="box-decoration-clone bg-no-repeat pb-px font-mono text-[0.92em]"
              style={{ backgroundImage: "linear-gradient(var(--color-best), var(--color-best))", backgroundPosition: "0 100%", backgroundSize: "0% 2px" }}
            >
              {FIGURE}
            </span>
          )}
          {AFTER}
        </p>
        <p data-el="checked" className="font-mono text-xs text-best-text" style={{ opacity: 0 }}>
          {FIGURE
            ? `✓ ${ev.winPctLost} is this move's own figure. Code checked it, and every other number in the report, against the games.`
            : "✓ Code checked every number in the report against the games."}
        </p>
        <div data-el="ctas" className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1" style={{ opacity: 0, visibility: "hidden" }}>
          <Link href={`${BASE}/coach`} className="btn-solid">
            Read the whole report
          </Link>
          <PrintLink
            platform={demo.platform}
            username={demo.username}
            className="inline-flex min-h-11 items-center rounded px-1 font-medium text-ink underline decoration-ink/30 underline-offset-4 transition-colors hover:decoration-ink active:scale-[0.97]"
          >
            Open this Blunderprint
          </PrintLink>
        </div>
      </div>
    </div>
  );
}

// `children`: the hero words (the page's own, server-rendered: the headline is the LCP element).
export function Dive({ children }: { children: ReactNode }) {
  return (
    <div className="relative" data-dive>
      {/* Stacked: the words first, in the normal flow. From 1280 px: over the stage's left third. */}
      <div data-dive-hero className="relative z-10 xl:absolute xl:top-0 xl:left-0 xl:w-[34%]">
        {children}
      </div>
      <div className="relative h-[560svh] motion-reduce:h-auto">
        <Stage className="sticky top-0 h-svh motion-reduce:relative motion-reduce:h-[23rem] xl:motion-reduce:h-[49rem]" />
        {/* What the dive shows, for a screen reader (the stage's own words come and go with the scroll). */}
        <p className="sr-only">
          An example from the demo: in game {ROW + 1} of {ROWS.length}, {MOVE} was a {ev.kind}
          {CLOCK ? ` with ${CLOCK} on the clock` : ""}. It lost {ev.winPctLost} win-chance points
          {ev.betterMove ? `; better was ${ev.betterMove}` : ""}. The coach&apos;s finding: {note.title}.
        </p>
      </div>
      {/* Reduced motion only: the dive's final picture, still. */}
      <Stage at={1} className="relative hidden h-svh min-h-[40rem] motion-reduce:block" />
    </div>
  );
}
