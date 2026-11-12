"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ApiError, askQuestion, type CoachInfo, type Platform, type PublicRun } from "@/lib/api";
import { boxEnabled, canSend, chipEnabled, cleanQuestion, counter, questionKeyText } from "@/lib/ask";
import { EMPTY_HISTORY, isBusy, reduceAsk } from "@/lib/askHistory";
import { AnswerCard } from "./AnswerCard";

// "Ask the coach" (Stage 6 chunk C), under the report on the coach page, for any player with
// enough analysed games. A question box (300 characters, counted after the same cleaning as the
// API), three suggested questions, and this visit's questions with their answers, oldest first.
//
// - POST /ask answers 200 with a cached answer (shown at once, with its trace) or 202 with a run
//   id and a secret token; the run is then followed live over its stream (AnswerCard). The token
//   stays in this component's memory: never in the address bar, storage or logs.
// - One question at a time. A new question's card is added at the BOTTOM and scrolled into view,
//   so nothing above it moves when its answer arrives (no layout shift).
// - The chips are the same three questions for everyone; a chip whose answer is cached (always
//   so for the demo player: npm run demo:answers) works even while the AI is off.

export function AskCoach({ platform, username, info }: { platform: Platform; username: string; info: CoachInfo }) {
  const [history, dispatch] = useReducer(reduceAsk, EMPTY_HISTORY);
  const [text, setText] = useState("");
  // Questions answered in this visit: their chips are answered now too.
  const [answeredHere, setAnsweredHere] = useState<ReadonlySet<string>>(() => new Set());
  const busy = isBusy(history);
  const aiEnabled = info.ai.enabled;
  const reduced = !!useReducedMotion();
  const listRef = useRef<HTMLOListElement>(null);
  const count = counter(text);

  const suggestions = (info.ask?.suggestions ?? []).map((s) => ({
    ...s,
    answered: s.answered || answeredHere.has(questionKeyText(s.question)),
  }));

  async function send(id: number, question: string) {
    try {
      const result = await askQuestion(platform, username, question);
      if (result.kind === "run") dispatch({ type: "accepted", id, runId: result.runId, token: result.token });
      else {
        dispatch({ type: "cached", id, answer: result.answer, trace: result.trace });
        markAnswered(question);
      }
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, "Something went wrong on our side.");
      dispatch({ type: "refused", id, error: { code: e.code, message: e.message, retryAfterMs: e.retryAfterMs } });
    }
  }

  function markAnswered(question: string) {
    const key = questionKeyText(question);
    setAnsweredHere((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  }

  function ask(raw: string) {
    const question = cleanQuestion(raw);
    if (busy || !canSend(question)) return;
    const id = history.nextId; // the id the submit below gives the new entry
    dispatch({ type: "submit", question });
    void send(id, question);
  }

  function retry(id: number) {
    const entry = history.entries.find((e) => e.id === id);
    if (!entry || busy) return;
    dispatch({ type: "retry", id });
    void send(id, entry.question);
  }

  function finished(id: number, run: PublicRun) {
    dispatch({ type: "finished", id, run });
    if (run.status === "done" && run.answer) markAnswered(run.answer.question);
  }

  // A new card: bring it into view (a scroll, not a layout shift).
  const entries = history.entries.length;
  useEffect(() => {
    if (entries === 0) return;
    listRef.current?.lastElementChild?.scrollIntoView({ block: "nearest", behavior: reduced ? "auto" : "smooth" });
  }, [entries, reduced]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!boxEnabled({ aiEnabled, busy }) || !canSend(text)) return;
    ask(text);
    setText("");
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    // Enter sends, Shift+Enter is a new line; not while an input method is composing.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section aria-labelledby="ask-heading" className="flex flex-col gap-6 border-t-2 border-ink pt-5">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-wide text-graphite/60 uppercase">Ask the coach</p>
        <h2 id="ask-heading" className="font-display text-2xl leading-tight text-ink sm:text-3xl">
          A question about your own games
        </h2>
        <p className="max-w-prose text-sm leading-relaxed text-graphite">
          The coach investigates your analysed games with the same tools as the report. Code writes every number in the answer and
          checks every position it cites.
        </p>
      </header>

      <form onSubmit={submit} className="flex flex-col gap-2">
        <label htmlFor="ask-question" className="font-mono text-xs tracking-wide text-graphite/70 uppercase">
          Your question
        </label>
        <textarea
          id="ask-question"
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={!aiEnabled}
          aria-describedby="ask-counter ask-privacy"
          aria-invalid={count.over || undefined}
          placeholder={aiEnabled ? "e.g. Which piece do I lose most often?" : "New questions are paused right now."}
          className="w-full max-w-2xl resize-y rounded border border-ink/30 bg-transparent px-3 py-2 text-base text-ink transition-colors placeholder:text-graphite/50 hover:border-ink/60 focus-visible:border-ink disabled:opacity-60"
        />
        <div className="flex max-w-2xl flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <p id="ask-counter" className={`font-mono text-xs tabular-nums ${count.over ? "text-blunder" : "text-graphite/60"}`}>
            {/* Screen-reader text first: an aria-hidden + sr-only pair is how AnimatedNumber is
                marked, and ui-motion.mjs checks those pairs as counting numbers. */}
            <span className="sr-only">Up to 300 characters.</span>
            <span aria-hidden="true">{count.text}</span>
          </p>
          {/* Announced only near the limit, so typing isn't read out character by character. */}
          <p className="sr-only" aria-live="polite">
            {count.announce ?? ""}
          </p>
          <button type="submit" className="btn-solid min-h-11 px-4 py-1.5 text-sm sm:min-h-0" disabled={!boxEnabled({ aiEnabled, busy }) || !canSend(text)}>
            {busy ? "Answering…" : "Ask"}
          </button>
        </div>
      </form>

      {suggestions.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-xs tracking-wide text-graphite/60 uppercase" id="ask-suggested">
            Or try one of these
          </p>
          <div role="group" aria-labelledby="ask-suggested" className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s.question}
                type="button"
                data-chip={s.answered ? "answered" : "new"}
                className="btn-quiet flex min-h-11 items-center gap-2 py-1 text-left text-sm sm:min-h-0 sm:items-baseline"
                disabled={!chipEnabled(s, { aiEnabled, busy })}
                onClick={() => ask(s.question)}
              >
                <span>{s.question}</span>
                {s.answered && (
                  <span className="font-mono text-[11px] text-best" title="Answered already: no wait">
                    <span className="sr-only">(answer ready)</span>
                    <span aria-hidden="true">✓</span>
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {!aiEnabled && (
        <p className="text-sm text-graphite/80" role="status">
          The coach is switched off right now. Questions marked ✓ were answered before and still open.
        </p>
      )}

      <p id="ask-privacy" className="max-w-prose text-xs leading-relaxed text-graphite/60">
        Questions are sent to Google&apos;s Gemini on its free tier, where Google may use them to improve its models, so don&apos;t include
        personal details. Visitors are counted by a hashed address, never a stored IP.
      </p>

      {history.entries.length > 0 && (
        <ol ref={listRef} aria-label="Your questions" className="flex flex-col gap-12">
          {history.entries.map((entry) => (
            <li key={entry.id}>
              <AnswerCard
                entry={entry}
                platform={platform}
                username={username}
                onFinished={(run) => finished(entry.id, run)}
                onLost={() => dispatch({ type: "lost", id: entry.id })}
                onRetry={() => retry(entry.id)}
                retryDisabled={busy}
              />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
