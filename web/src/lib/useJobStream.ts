"use client";

import { useEffect, useRef, useState } from "react";
import { jobStreamUrl, type PublicJob } from "./api";

// The events GET /api/jobs/:id/stream sends. Each one's data is the whole public job.
export const JOB_EVENTS = ["snapshot", "progress", "retrying", "done", "failed"] as const;
export type JobEventType = (typeof JOB_EVENTS)[number];

// "reconnecting": the connection dropped and the browser is retrying on its own (the server
// asks for 3 s between tries and re-sends a snapshot on every connect, so nothing is missed).
// "lost": the browser gave up, e.g. the job no longer exists (the stream answered 404).
export type StreamConnection = "connecting" | "open" | "reconnecting" | "closed" | "lost";

// Follows one job over Server-Sent Events. EventSource is the browser's built-in SSE client:
// it keeps one HTTP response open and turns each "event: …\ndata: …" block into a DOM event.
// onEvent is called for every event (read from a ref, so it can be a fresh closure).
export function useJobStream(jobId: string | null, onEvent?: (type: JobEventType, job: PublicJob) => void) {
  // Kept with the jobId it belongs to, so a new jobId never shows the previous job's state.
  const [state, setState] = useState<{ jobId: string; job: PublicJob | null; connection: StreamConnection } | null>(null);
  const onEventRef = useRef(onEvent);
  useEffect(() => {
    onEventRef.current = onEvent;
  });

  useEffect(() => {
    if (!jobId) return;
    const source = new EventSource(jobStreamUrl(jobId));
    const update = (patch: Partial<{ job: PublicJob; connection: StreamConnection }>) =>
      setState((prev) => ({
        jobId,
        job: prev?.jobId === jobId ? prev.job : null,
        connection: prev?.jobId === jobId ? prev.connection : "connecting",
        ...patch,
      }));

    source.onopen = () => update({ connection: "open" });
    // The server ends the response after "done"/"failed". We close first, so the browser
    // doesn't treat the end of the response as a dropped connection and reconnect.
    source.onerror = () => update({ connection: source.readyState === EventSource.CLOSED ? "lost" : "reconnecting" });
    for (const type of JOB_EVENTS) {
      source.addEventListener(type, (event) => {
        const job = JSON.parse((event as MessageEvent<string>).data) as PublicJob;
        const finished = type === "done" || type === "failed";
        if (finished) source.close();
        update({ job, connection: finished ? "closed" : "open" });
        onEventRef.current?.(type, job);
      });
    }
    return () => source.close();
  }, [jobId]);

  const current = state && state.jobId === jobId ? state : null;
  return { job: current?.job ?? null, connection: current?.connection ?? (jobId ? "connecting" : "closed") };
}
