"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

// Render's free API sleeps after 15 minutes; the first request can take up to about a minute.
export const WAKING_AFTER_MS = 3_000; // show the "waking" counter after this long
const GIVE_UP_AFTER_MS = 60_000; // then stop and offer Retry
const RETRY_EVERY_MS = 3_000; // a waking server can also fail fast (e.g. 502) before it is ready

// Worth retrying while the server may still be waking: no answer at all, or a 502/503/504 from
// Render's proxy. A 4xx is a real answer, so it is returned straight away.
const isWakingError = (err: unknown) => err instanceof ApiError && (err.status === 0 || err.status >= 502);

export type WakingState<T> =
  | { kind: "loading" }
  | { kind: "done"; value: T }
  | { kind: "error"; error: ApiError };

// Runs `task` once on mount, retrying it while the API wakes up, and counts the seconds so the
// UI can say "Waking the server up… (12s)". `task` must be safe to repeat. The task is read
// from a ref, so pass a fresh closure every render; to run it for different inputs, remount
// the component (e.g. key it by those inputs).
export function useWakingRequest<T>(task: (signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<WakingState<T>>({ kind: "loading" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const taskRef = useRef(task);
  useEffect(() => {
    taskRef.current = task;
  });

  useEffect(() => {
    const controller = new AbortController();
    const started = Date.now();
    let timedOut = false;
    const ticker = setInterval(() => setElapsedMs(Date.now() - started), 1_000);
    const giveUp = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GIVE_UP_AFTER_MS);
    // Once the request settles (answer, give-up or unmount), stop re-rendering every second
    // and make sure the give-up timer can't fire later.
    const stopTimers = () => {
      clearInterval(ticker);
      clearTimeout(giveUp);
    };

    async function run() {
      while (!controller.signal.aborted) {
        try {
          const value = await taskRef.current(controller.signal);
          stopTimers();
          setState({ kind: "done", value });
          return;
        } catch (err) {
          if (controller.signal.aborted) break;
          if (!isWakingError(err)) {
            stopTimers();
            setState({ kind: "error", error: err instanceof ApiError ? err : new ApiError(0, "Something went wrong") });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
        }
      }
      stopTimers();
      // Aborted by the give-up timer (not by unmount): report it.
      if (timedOut) setState({ kind: "error", error: new ApiError(0, "Can't reach the API") });
    }
    void run();

    return () => {
      controller.abort();
      stopTimers();
    };
  }, [attempt]);

  // Reset here (an event handler), not inside the effect, then bump `attempt` to re-run it.
  const retry = useCallback(() => {
    setState({ kind: "loading" });
    setElapsedMs(0);
    setAttempt((n) => n + 1);
  }, []);

  return { state, elapsedMs, waking: state.kind === "loading" && elapsedMs >= WAKING_AFTER_MS, retry };
}
