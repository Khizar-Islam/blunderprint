"use client";

import { useEffect, useState } from "react";
import { runStreamUrl, type PublicRun, type TraceStep } from "./api";
import { EMPTY_RUN, reduceRun, type RunEvent, type RunView } from "./runStream";
import type { StreamConnection } from "./useJobStream";

const RUN_EVENTS = ["snapshot", "status", "step", "done", "failed"] as const;

interface Kept {
  runId: string;
  view: RunView;
  connection: StreamConnection;
}

// Follows one coach run over SSE (the same EventSource pattern as useJobStream). EventSource
// reconnects on its own after a drop, and the server starts every connection with a fresh
// snapshot, so a reload or a network blip never loses or repeats a trace line. The state is
// kept with the runId it belongs to, so a new run never shows the previous run's trace.
export function useRunStream(runId: string | null) {
  const [kept, setKept] = useState<Kept | null>(null);

  useEffect(() => {
    if (!runId) return;
    const source = new EventSource(runStreamUrl(runId));
    const update = (fn: (k: Kept) => Kept) =>
      setKept((prev) => fn(prev?.runId === runId ? prev : { runId, view: EMPTY_RUN, connection: "connecting" }));

    source.onopen = () => update((k) => ({ ...k, connection: "open" }));
    source.onerror = () => update((k) => ({ ...k, connection: source.readyState === EventSource.CLOSED ? "lost" : "reconnecting" }));
    for (const type of RUN_EVENTS) {
      source.addEventListener(type, (raw) => {
        const msg = raw as MessageEvent<string>;
        const rev = Number(msg.lastEventId);
        const data = JSON.parse(msg.data) as PublicRun | { step: TraceStep };
        const event: RunEvent =
          type === "step" ? { type, rev, step: (data as { step: TraceStep }).step } : { type, rev, run: data as PublicRun };
        const run = type === "step" ? null : (data as PublicRun);
        // The server ends the stream after done/failed (or a finished snapshot). Close first so
        // the browser doesn't take the end of the response for a drop and reconnect.
        const finished = !!run && (run.status === "done" || run.status === "failed");
        if (finished) source.close();
        update((k) => ({ ...k, view: reduceRun(k.view, event), connection: finished ? "closed" : "open" }));
      });
    }
    return () => source.close();
  }, [runId]);

  const current = kept && kept.runId === runId ? kept : null;
  return { ...(current?.view ?? EMPTY_RUN), connection: current?.connection ?? (runId ? "connecting" : "closed") };
}
