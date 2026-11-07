"use client";

import { useEffect, useState } from "react";
import type { MoveClass, TraceStep } from "@/lib/api";
import { dayDate } from "@/lib/format";
import { classifiedRibbon, progressRibbon } from "@/lib/ribbon";
import { useReveal } from "@/lib/useReveal";
import { TraceLine } from "../coach/AgentTrace";
import { ColorChip, ResultMark } from "../GamesList";
import type { DemoSnapshot } from "./demoData";

// The landing page's "How it works": three steps, each with a small live illustration built from
// the real pieces of the app, playing once when the row scrolls into view:
//   1. Import: four of the demo player's real games drop into a list (the games list's own result
//      mark and colour chip), the counter ticking up.
//   2. Engine: one real game's ribbon fills move by move, then takes its colours (lib/ribbon.ts,
//      the same gradients as the games list).
//   3. Coach: two lines of the agent trace type in (AgentTrace's own line).
// Decorative (aria-hidden, nothing to focus); the step text says it in words. Timers, not
// animation frames, step them, and every one is ~2 s, so they always finish. Reduced motion:
// the final state at once.

const STEPS = [
  { title: "Import", text: "Up to 200 of your recent Chess.com or Lichess games, streamed in live." },
  { title: "Engine in your browser", text: "Stockfish runs on your own computer and marks every inaccuracy, mistake and blunder." },
  { title: "A coach that checks its claims", text: "An AI agent investigates the data with tools; code verifies every number and position it cites." },
];

const LETTER: Record<string, MoveClass> = { b: "best", g: "good", i: "inaccuracy", m: "mistake", x: "blunder" };

// What two real steps of a run look like (the tool's name and what it does; no figures).
const TRACE: TraceStep[] = [
  { n: 1, kind: "tool", label: "get_weakness_candidates", detail: "groups worse than your own average", ms: 0 },
  { n: 2, kind: "verify", label: "verify", detail: "every number and position checked against your games", ms: 0 },
];

const ROWS = 4;
const ROW_GAP_MS = 220;
const FILL_MS = 1600;
const FILL_STEP_MS = 40;
const LINE_GAP_MS = 700;

export function HowItWorks({ demo }: { demo: DemoSnapshot }) {
  const { ref, shown, reduced } = useReveal<HTMLOListElement>(0.4);
  return (
    <ol ref={ref} className="grid max-w-5xl gap-x-10 gap-y-8 border-t border-ink/15 pt-6 sm:grid-cols-3">
      {STEPS.map((s, i) => (
        <li key={s.title} className="grid grid-cols-[1.5rem_1fr] content-start gap-x-2 gap-y-1">
          <span className="font-mono text-sm text-graphite tabular-nums">{i + 1}.</span>
          <span className="text-sm font-medium text-ink">{s.title}</span>
          <span className="col-start-2 text-sm text-graphite">{s.text}</span>
          <div className="col-start-2 mt-3 min-w-0" aria-hidden="true">
            {i === 0 && <ImportSketch demo={demo} play={shown} reduced={reduced} />}
            {i === 1 && <EngineSketch demo={demo} play={shown} reduced={reduced} />}
            {i === 2 && <CoachSketch play={shown} reduced={reduced} />}
          </div>
        </li>
      ))}
    </ol>
  );
}

// 1. Rows drop in, newest first, each a CSS animation (anim-rise) started by its own delay; the
// counter steps up with them (timers).
function ImportSketch({ demo, play, reduced }: { demo: DemoSnapshot; play: boolean; reduced: boolean }) {
  const games = demo.ribbons.slice(0, ROWS);
  const rows = games.length;
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!play || reduced) return;
    const timers = Array.from({ length: rows }, (_, k) => window.setTimeout(() => setCount(k + 1), k * ROW_GAP_MS + 150));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [play, reduced, rows]);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="font-mono text-xs text-graphite tabular-nums">{reduced ? games.length : count} games</p>
      <ol className="flex flex-col border-t border-ink/10">
        {games.map((g, k) => (
          <li
            key={g.gameId}
            className={`flex items-center gap-2 border-b border-ink/10 py-1.5 font-mono text-xs text-graphite ${play ? "anim-rise" : "reveal-wait"}`}
            style={{ animationDelay: `${k * ROW_GAP_MS}ms` }}
          >
            <ResultMark result={g.result} />
            <ColorChip color={g.color} />
            <span>{g.speed}</span>
            <span className="ml-auto text-graphite/70">{dayDate(g.playedAt)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// 2. One game's ribbon: the engine fills it move by move, then its colours appear.
function EngineSketch({ demo, play, reduced }: { demo: DemoSnapshot; play: boolean; reduced: boolean }) {
  const game = demo.ribbons.find((r) => r.gameId === demo.notes[0]?.evidence.gameId) ?? demo.ribbons[0]!;
  const classes = [...game.classes].map((c) => LETTER[c] ?? "good");
  const plies = classes.length;
  const [evaluated, setEvaluated] = useState(0);

  useEffect(() => {
    if (!play || reduced) return;
    const started = Date.now();
    const id = window.setInterval(() => {
      const n = Math.min(plies, Math.ceil(((Date.now() - started) / FILL_MS) * plies));
      setEvaluated(n);
      if (n >= plies) window.clearInterval(id);
    }, FILL_STEP_MS);
    return () => window.clearInterval(id);
  }, [play, reduced, plies]);

  const done = reduced || evaluated >= plies;
  const background = done ? classifiedRibbon(classes, game.color) : progressRibbon(evaluated, plies);
  return (
    <div className="flex flex-col gap-1.5 font-mono text-xs text-graphite">
      <p className="tabular-nums">{done ? `${Math.ceil(plies / 2)} moves analysed` : `move ${Math.ceil(evaluated / 2)} of ${Math.ceil(plies / 2)}`}</p>
      <div className="h-1.5 w-full rounded-full bg-ink/5 transition-[background-image]" style={{ backgroundImage: background }} />
      <p className="text-graphite/70">
        <span className="text-inaccuracy">■</span> inaccuracy <span className="text-mistake">■</span> mistake{" "}
        <span className="text-blunder">■</span> blunder
      </p>
    </div>
  );
}

// 3. Two trace lines type in, one after the other (AgentTrace's line; its typing lands by a timer).
function CoachSketch({ play, reduced }: { play: boolean; reduced: boolean }) {
  const [lines, setLines] = useState(0);
  useEffect(() => {
    if (!play || reduced) return;
    const timers = TRACE.map((_, k) => window.setTimeout(() => setLines(k + 1), k * LINE_GAP_MS));
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, [play, reduced]);
  const shown = reduced ? TRACE.length : lines;
  return (
    // Its height is held from the start, so the page doesn't move as the lines arrive.
    <ol className="flex min-h-[5.5rem] flex-col border-t border-ink/10 pt-1">
      {TRACE.slice(0, shown).map((step) => (
        <TraceLine key={step.n} step={step} animate={!reduced} />
      ))}
    </ol>
  );
}
