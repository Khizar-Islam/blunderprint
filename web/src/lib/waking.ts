import { ApiError } from "./api";

// The retry rules behind useWakingRequest, without React, so they can be tested in Node.

export const RETRY_EVERY_MS = 3_000; // a waking server can also fail fast (e.g. 502) before it is ready

// Worth retrying while the server may still be waking: no answer at all, or a 502/503/504 from
// Render's proxy. A 4xx is a real answer, so it is returned straight away, and so is a 5xx that
// carries one of our codes (e.g. 503 storage_full or busy, Stage 6): our API answered it.
export const isWakingError = (err: unknown) =>
  err instanceof ApiError && (err.status === 0 || (err.status >= 502 && err.code === undefined));

export type WakingState<T> =
  | { kind: "loading" }
  | { kind: "done"; value: T }
  | { kind: "error"; error: ApiError };

// How a run ended. "aborted": the signal was aborted (give-up timer or unmount) before an answer.
export type WakingOutcome<T> =
  | { kind: "done"; value: T }
  | { kind: "error"; error: ApiError }
  | { kind: "aborted" };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs `task` until it answers: again every `retryEveryMs` while the error looks like a server
// that is still waking, at once back with any real answer (a value or a non-waking error).
// It never gives up by itself: the caller aborts the signal.
export async function runWaking<T>(
  task: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  { retryEveryMs = RETRY_EVERY_MS, sleep = wait }: { retryEveryMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<WakingOutcome<T>> {
  while (!signal.aborted) {
    try {
      return { kind: "done", value: await task(signal) };
    } catch (err) {
      if (signal.aborted) break;
      if (!isWakingError(err)) {
        return { kind: "error", error: err instanceof ApiError ? err : new ApiError(0, "Something went wrong") };
      }
      await sleep(retryEveryMs);
    }
  }
  return { kind: "aborted" };
}

// The state to show for an outcome; null = show nothing new (the component went away).
// An abort by the give-up timer (not by unmount) is reported.
export function wakingStateOf<T>(outcome: WakingOutcome<T>, timedOut: boolean): WakingState<T> | null {
  if (outcome.kind !== "aborted") return outcome;
  return timedOut ? { kind: "error", error: new ApiError(0, "Can't reach the API") } : null;
}
