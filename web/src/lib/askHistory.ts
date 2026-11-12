import type { CoachAnswer, PublicRun } from "./api";

// The questions asked in this visit and their answers, oldest first (Stage 6 chunk C). Pure, so
// the rules are tested (askHistory.test.ts); components/coach/AskCoach.tsx runs it with
// useReducer. In memory only: a reload starts with an empty list.
//
// One question at a time: while one is being sent or answered, another is ignored (the page
// also disables the controls). A run's secret token lives in its entry, in memory, and nowhere
// else.

export type EntryStatus = "sending" | "streaming" | "done" | "failed";

export interface AskError {
  code?: string;
  message: string;
  retryAfterMs?: number;
}

export interface AskEntry {
  id: number; // local, for React keys
  question: string;
  status: EntryStatus;
  runId?: string;
  token?: string;
  answer?: CoachAnswer;
  // The run that wrote the answer, for "How this answer was made": the streamed run, or the one
  // sent with a cached answer. null when it has expired.
  trace?: PublicRun | null;
  cached?: boolean;
  error?: AskError;
}

export interface AskHistory {
  entries: AskEntry[];
  nextId: number;
}

export const EMPTY_HISTORY: AskHistory = { entries: [], nextId: 1 };

export type AskEvent =
  | { type: "submit"; question: string }
  | { type: "accepted"; id: number; runId: string; token: string }
  | { type: "cached"; id: number; answer: CoachAnswer; trace: PublicRun | null }
  | { type: "refused"; id: number; error: AskError }
  | { type: "finished"; id: number; run: PublicRun }
  | { type: "lost"; id: number }
  | { type: "retry"; id: number };

export const isBusy = (h: AskHistory) => h.entries.some((e) => e.status === "sending" || e.status === "streaming");

// The entry a submit just created (its id), so the caller can send it.
export const lastEntry = (h: AskHistory): AskEntry | undefined => h.entries.at(-1);

function update(h: AskHistory, id: number, fn: (e: AskEntry) => AskEntry | null): AskHistory {
  let changed = false;
  const entries = h.entries.map((e) => {
    if (e.id !== id) return e;
    const next = fn(e);
    if (!next) return e;
    changed = true;
    return next;
  });
  return changed ? { ...h, entries } : h;
}

const LOST: AskError = { code: "stream_lost", message: "Lost the connection to the coach before it answered." };

export function reduceAsk(h: AskHistory, event: AskEvent): AskHistory {
  switch (event.type) {
    case "submit":
      if (isBusy(h)) return h;
      return { entries: [...h.entries, { id: h.nextId, question: event.question, status: "sending" }], nextId: h.nextId + 1 };
    case "accepted":
      return update(h, event.id, (e) => (e.status === "sending" ? { ...e, status: "streaming", runId: event.runId, token: event.token, error: undefined } : null));
    case "cached":
      return update(h, event.id, (e) =>
        e.status === "sending" ? { ...e, status: "done", answer: event.answer, trace: event.trace, cached: true, error: undefined } : null,
      );
    case "refused":
      return update(h, event.id, (e) => (e.status === "sending" ? { ...e, status: "failed", error: event.error } : null));
    case "finished":
      return update(h, event.id, (e) => {
        if (e.status !== "streaming" || e.runId !== event.run.id) return null;
        if (event.run.status === "done" && event.run.answer) {
          // The token isn't needed any more: drop it.
          return { ...e, status: "done", answer: event.run.answer, trace: event.run, token: undefined };
        }
        if (event.run.status === "failed" || event.run.status === "done") {
          const error = event.run.error ?? { code: "internal", message: "Something went wrong on our side." };
          return { ...e, status: "failed", error, trace: event.run, token: undefined };
        }
        return null;
      });
    case "lost":
      return update(h, event.id, (e) => (e.status === "streaming" ? { ...e, status: "failed", error: LOST, token: undefined } : null));
    case "retry":
      // Asked again from its card: the same question, sent again (a run still going is rejoined
      // by the API with a new token). Only when nothing else is on its way.
      if (isBusy(h)) return h;
      return update(h, event.id, (e) =>
        e.status === "failed" ? { id: e.id, question: e.question, status: "sending" } : null,
      );
  }
}
