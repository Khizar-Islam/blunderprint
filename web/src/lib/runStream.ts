import type { PublicRun, TraceStep } from "./api";

// The coach run's live state, folded from the events of GET /api/runs/:id/stream. Pure, so the
// rules are tested (runStream.test.ts); useRunStream.ts wires it to EventSource.
//
// The server's contract (backend routes/runs.ts): every event carries the run's `rev`, a
// counter bumped on every visible change. `snapshot` (first on every connect, also after a
// reconnect), `status`, `done` and `failed` carry the whole public run; `step` carries one new
// trace line. Anything at or below the rev we already have is old news.

export type RunEvent =
  | { type: "snapshot" | "status" | "done" | "failed"; rev: number; run: PublicRun }
  | { type: "step"; rev: number; step: TraceStep };

export interface RunView {
  run: PublicRun | null;
  steps: TraceStep[];
  rev: number;
}

export const EMPTY_RUN: RunView = { run: null, steps: [], rev: -1 };

export function reduceRun(state: RunView, event: RunEvent): RunView {
  // A snapshot is the server's whole truth at connect time: take it as it is.
  if (event.type === "snapshot") return { run: event.run, steps: event.run.steps, rev: event.rev };
  if (event.rev <= state.rev) return state;
  if (event.type === "step") {
    // A step can't arrive twice with a new rev, but a line already shown is never repeated.
    if (state.steps.some((s) => s.n === event.step.n)) return { ...state, rev: event.rev };
    return {
      run: state.run ? { ...state.run, rev: event.rev } : state.run,
      steps: [...state.steps, event.step],
      rev: event.rev,
    };
  }
  // status / done / failed: the whole run. A restarted attempt (after a server restart) comes
  // with a fresh, empty trace, so the steps follow the run.
  return { run: event.run, steps: event.run.steps, rev: event.rev };
}

export const isFinished = (run: PublicRun | null) => run?.status === "done" || run?.status === "failed";
