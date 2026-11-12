"use client";

import { useEffect, useState } from "react";
import type { CoachAnswer, Platform, PublicRun } from "@/lib/api";
import { askErrorView, fillTemplate, sentenceText } from "@/lib/ask";
import type { AskEntry } from "@/lib/askHistory";
import { isFinished } from "@/lib/runStream";
import { useReveal } from "@/lib/useReveal";
import { useRunStream } from "@/lib/useRunStream";
import { AgentTrace, traceSummary } from "./AgentTrace";
import { EvidenceBoard } from "./EvidenceBoard";
import { Figure } from "./Figure";
import { FingerprintLens } from "./FingerprintLens";

// One question of this visit and what became of it (Stage 6 chunk C):
// - sending: a one-line placeholder;
// - streaming: the live agent trace (the same scoresheet as the report), over the run's stream
//   with its secret token;
// - done: the answer. Its sentences are set in the serif like annotations in a chess book, along
//   an ink hairline (not a chat bubble), with every number a Figure written by code. Then the
//   evidence: the fingerprint lens and the same evidence boards as the report's patterns. The
//   trace folds into "How this answer was made";
// - failed: the friendly message, and Try again when trying again can help.
// The in-flight states reserve a fixed height, so the answer arriving moves as little below it
// as possible (no layout shift above it: answers are added at the bottom).

const BOARD_COLS: Record<number, string> = {
  1: "grid-cols-2 md:grid-cols-3",
  2: "grid-cols-2 md:grid-cols-3",
  3: "grid-cols-2 md:grid-cols-3",
};
const SENTENCE_STAGGER_MS = 140;
const FIGURE_AFTER_MS = 250; // a figure's rule starts drawing this long after its sentence

export function AnswerCard({
  entry,
  platform,
  username,
  onFinished,
  onLost,
  onRetry,
  retryDisabled,
}: {
  entry: AskEntry;
  platform: Platform;
  username: string;
  onFinished: (run: PublicRun) => void;
  onLost: () => void;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  return (
    <article
      className="flex flex-col gap-5 border-t border-ink/20 pt-5"
      aria-label={`Question: ${entry.question}`}
      data-answer={entry.status === "done" ? entry.answer?.outcome : undefined}
    >
      <p className="flex items-baseline gap-3 text-base text-ink">
        <span className="font-mono text-xs tracking-wide text-graphite/60 uppercase" aria-hidden="true">
          Q.
        </span>
        <span className="font-medium">{entry.question}</span>
      </p>

      {entry.status === "sending" && (
        <p className="min-h-[14rem] font-mono text-xs text-graphite/70" role="status">
          Sending your question…
        </p>
      )}
      {entry.status === "streaming" && entry.runId && (
        <StreamingAnswer runId={entry.runId} token={entry.token ?? null} onFinished={onFinished} onLost={onLost} />
      )}
      {entry.status === "done" && entry.answer && (
        <AnswerBody entryId={entry.id} answer={entry.answer} trace={entry.trace ?? null} cached={!!entry.cached} platform={platform} username={username} />
      )}
      {entry.status === "failed" && entry.error && (
        <FailedAnswer error={entry.error} trace={entry.trace ?? null} onRetry={onRetry} retryDisabled={retryDisabled} />
      )}
    </article>
  );
}

function StreamingAnswer({
  runId,
  token,
  onFinished,
  onLost,
}: {
  runId: string;
  token: string | null;
  onFinished: (run: PublicRun) => void;
  onLost: () => void;
}) {
  const stream = useRunStream(runId, token);
  const run = stream.run;
  const finished = isFinished(run);
  useEffect(() => {
    if (run && finished) onFinished(run);
  }, [run, finished, onFinished]);
  // The browser gave up (the API answered 404: the token or the run is gone) before an end.
  useEffect(() => {
    if (stream.connection === "lost" && !finished) onLost();
  }, [stream.connection, finished, onLost]);
  return (
    <div className="min-h-[14rem]">
      <AgentTrace steps={stream.steps} run={run} connection={stream.connection} live subject="answer" />
    </div>
  );
}

function AnswerBody({
  entryId,
  answer,
  trace,
  cached,
  platform,
  username,
}: {
  entryId: number;
  answer: CoachAnswer;
  trace: PublicRun | null;
  cached: boolean;
  platform: Platform;
  username: string;
}) {
  const { ref, shown, delayMs } = useReveal<HTMLDivElement>(0.1, true);
  const [lit, setLit] = useState<number | null>(null);
  const hrefOf = (e: { gameId: string; ply: number }) => `/p/${platform}/${encodeURIComponent(username)}/game/${encodeURIComponent(e.gameId)}?ply=${e.ply}`;
  const switched = answer.answeredBy && answer.answeredBy !== answer.model;

  return (
    <div ref={ref} className="flex flex-col gap-6">
      {answer.outcome === "cannot_answer" ? (
        <p
          className={`max-w-prose border-l border-ink/40 pl-5 font-display text-xl leading-relaxed text-graphite ${shown ? "anim-rise" : "reveal-wait"}`}
          style={{ animationDelay: `${delayMs}ms` }}
        >
          {answer.message}
        </p>
      ) : (
        <div className="flex max-w-prose flex-col gap-3 border-l border-ink/40 pl-5">
          {answer.sentences.map((sentence, i) => {
            const parts = fillTemplate(sentence, answer.slots);
            const at = delayMs + i * SENTENCE_STAGGER_MS;
            return (
              <p
                key={i}
                className={`font-display text-xl leading-relaxed text-ink [--bp-rise:8px] ${shown ? "anim-rise" : "reveal-wait"}`}
                style={{ animationDelay: `${at}ms` }}
                data-sentence={sentenceText(parts)}
              >
                {parts.map((p, j) =>
                  p.type === "text" ? (
                    <span key={j}>{p.text}</span>
                  ) : (
                    <Figure key={j} text={p.text} kind={p.kind} animate={shown} delayMs={at + FIGURE_AFTER_MS} />
                  ),
                )}
              </p>
            );
          })}
        </div>
      )}

      {answer.evidence.length > 0 && (
        <>
          <FingerprintLens evidence={answer.evidence} hrefOf={hrefOf} active={lit} onActive={setLit} />
          <div className={`grid gap-x-4 gap-y-6 ${BOARD_COLS[answer.evidence.length] ?? BOARD_COLS[3]}`}>
            {answer.evidence.map((e, i) => (
              <EvidenceBoard
                key={`${e.gameId}:${e.ply}`}
                boardId={`ask-${entryId}-${i}`}
                evidence={e}
                index={i}
                href={hrefOf(e)}
                active={lit === i}
                onActive={(on) => setLit(on ? i : null)}
              />
            ))}
          </div>
        </>
      )}

      <div className="flex flex-col gap-1">
        <p className="font-mono text-xs text-graphite/70">
          Based on {answer.analysedGames} analysed games · every number and position checked against your games
          {cached ? " · answered earlier" : ""}
        </p>
        {switched && (
          <p className="text-xs text-graphite/70">
            Written by <span className="font-mono">{answer.answeredBy}</span>: the main model ({answer.model}) was overloaded.
          </p>
        )}
      </div>
      <HowAnswered trace={trace} />
    </div>
  );
}

// "How this answer was made": the run's trace, folded into one line, opened on a click. It came
// with the answer (the stream, or the cached POST), so opening it needs no request.
function HowAnswered({ trace }: { trace: PublicRun | null }) {
  const [open, setOpen] = useState(false);
  if (!trace) return <p className="font-mono text-xs text-graphite/60">This answer&apos;s trace has expired (traces are kept for 14 days).</p>;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start rounded font-mono text-xs text-graphite/80 transition-colors hover:text-ink active:opacity-70"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} How this answer was made · {traceSummary(trace, null)}
      </button>
      {open && <AgentTrace steps={trace.steps} run={trace} connection="closed" live={false} subject="answer" />}
    </div>
  );
}

function FailedAnswer({
  error,
  trace,
  onRetry,
  retryDisabled,
}: {
  error: { code?: string; message: string; retryAfterMs?: number };
  trace: PublicRun | null;
  onRetry: () => void;
  retryDisabled: boolean;
}) {
  const view = askErrorView(error);
  const [since] = useState(() => Date.now());
  const [now, setNow] = useState(since);
  const waitLeftMs = view.action === "retry-later" ? Math.max(0, since + (view.waitMs ?? 0) - now) : 0;
  useEffect(() => {
    if (view.action !== "retry-later") return;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= since + (view.waitMs ?? 0)) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [view.action, view.waitMs, since]);

  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-ink/30 py-1 pl-4" role="status">
      <p className="font-display text-xl text-ink">{view.title}</p>
      <p className="max-w-prose text-sm text-graphite">{view.message}</p>
      {view.action !== "none" && (
        <button type="button" className="btn-quiet mt-1 text-sm" onClick={onRetry} disabled={retryDisabled || waitLeftMs > 0}>
          {waitLeftMs > 0 ? `Try again in ${Math.ceil(waitLeftMs / 1000)} s` : "Try again"}
        </button>
      )}
      {trace && trace.steps.length > 0 && <HowAnswered trace={trace} />}
    </div>
  );
}
