"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import type { PublicRun, TraceKind, TraceStep } from "@/lib/api";
import type { StreamConnection } from "@/lib/useJobStream";

// The live agent trace, laid out like a chess scoresheet: numbered lines in mono, the step in
// the middle, its time in a right-hand "clock" column. Live lines type in; a finished run's
// trace ("How this report was made") appears whole.
// Every kind of step is shown as it happened, including retries and a switch to the fallback
// model: the trace is the coach's honest working, not a progress bar. (After a reload mid-run,
// the snapshot's lines type in together, in the same quarter second.)

const GLYPH: Record<TraceKind, string> = {
  model: "→",
  tool: "·",
  verify: "✓",
  repair: "↺",
  retry: "…",
  switch: "⇄",
};

const TYPE_MS = 260; // how long one line takes to type in

const seconds = (ms: number) => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function TypedText({ text, animate }: { text: string; animate: boolean }) {
  const [shown, setShown] = useState(animate ? 0 : text.length);
  useEffect(() => {
    if (!animate) return;
    const started = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const n = Math.min(text.length, Math.ceil(((now - started) / TYPE_MS) * text.length));
      setShown(n);
      if (n < text.length) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [animate, text]);
  // The full text is always in the DOM for screen readers; only the visible part changes.
  return (
    <>
      <span aria-hidden="true">{text.slice(0, shown)}</span>
      <span className="sr-only">{text}</span>
    </>
  );
}

function Line({ step, animate }: { step: TraceStep; animate: boolean }) {
  const isSwitch = step.kind === "switch";
  const muted = step.kind === "retry";
  return (
    <li
      className={`grid grid-cols-[2rem_1rem_1fr_auto] items-baseline gap-x-2 border-l-2 py-1 pr-1 pl-2 font-mono text-[13px] leading-snug ${
        isSwitch ? "border-inaccuracy bg-inaccuracy/10" : "border-transparent"
      } ${muted ? "text-graphite/55" : "text-ink"}`}
    >
      <span className="text-right text-graphite/50 tabular-nums">{step.n}.</span>
      <span className={isSwitch ? "text-inaccuracy" : step.kind === "verify" ? "text-best" : "text-graphite/60"} aria-hidden="true">
        {GLYPH[step.kind]}
      </span>
      <span className="min-w-0">
        <span className={`break-words ${step.kind === "tool" ? "text-graphite" : ""}`}>
          <TypedText text={step.label} animate={animate} />
        </span>{" "}
        <span className={`break-words ${isSwitch ? "text-ink" : "text-graphite/75"}`}>
          <TypedText text={`— ${step.detail}`} animate={animate} />
        </span>
      </span>
      <span className="text-right text-graphite/60 tabular-nums">{step.ms > 0 ? seconds(step.ms) : ""}</span>
    </li>
  );
}

function useElapsed(since: string | undefined, running: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return since ? Math.max(0, now - Date.parse(since)) : 0;
}

export function AgentTrace({
  steps,
  run,
  connection,
  live,
}: {
  steps: TraceStep[];
  run: PublicRun | null;
  connection: StreamConnection;
  // true while the run streams; false for a finished run's trace ("How this report was made").
  live: boolean;
}) {
  const reduced = useReducedMotion();
  const status = run?.status ?? "queued";
  const elapsed = useElapsed(run?.startedAt, live && status === "running");

  const listRef = useRef<HTMLOListElement>(null);
  useEffect(() => {
    // Keep the newest line in view while the trace grows (the list scrolls, not the page).
    const list = listRef.current;
    if (list && live) list.scrollTop = list.scrollHeight;
  }, [steps.length, live]);

  return (
    <section aria-label="The coach's working" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-ink/15 pb-1 font-mono text-xs tracking-wide text-graphite/70 uppercase">
        <span>
          {live
            ? connection === "reconnecting" || connection === "lost"
              ? "Reconnecting…"
              : status === "queued"
                ? "Waiting for another report to finish"
                : `Investigating · ${Math.floor(elapsed / 1000)} s`
            : "How this report was made"}
        </span>
        <span className="hidden sm:inline">step · time</span>
      </div>
      <ol
        ref={listRef}
        className={`flex flex-col ${live ? "max-h-[26rem] overflow-y-auto" : ""}`}
        aria-live={live ? "polite" : undefined}
        aria-relevant="additions"
      >
        {steps.map((step) => (
          <Line key={step.n} step={step} animate={live && !reduced} />
        ))}
        {live && status !== "done" && status !== "failed" && (
          <li className="py-1 pl-12 font-mono text-[13px] text-graphite/50" aria-hidden="true">
            <span className="inline-block animate-pulse motion-reduce:animate-none">▍</span>
          </li>
        )}
      </ol>
    </section>
  );
}

// The one line a finished run folds into: "Investigated in 47 s · 9 requests · 3 patterns".
export function traceSummary(run: PublicRun, patterns: number | null): string {
  const ms = run.startedAt && run.finishedAt ? Date.parse(run.finishedAt) - Date.parse(run.startedAt) : null;
  const failed = run.status === "failed";
  const parts = [ms != null ? `${failed ? "Stopped after" : "Investigated in"} ${Math.round(ms / 1000)} s` : failed ? "Stopped" : "Investigated"];
  if (run.usage) parts.push(`${run.usage.calls} request${run.usage.calls === 1 ? "" : "s"}`);
  if (patterns != null) parts.push(`${patterns} pattern${patterns === 1 ? "" : "s"} verified`);
  const verify = run.steps.filter((s) => s.kind === "verify").at(-1);
  if (verify && /dropped/.test(verify.detail)) parts.push(verify.detail.replace(/^kept \d+ of \d+, /, ""));
  return parts.join(" · ");
}
