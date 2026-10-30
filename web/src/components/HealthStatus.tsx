"use client";

import { useCallback, useEffect, useState } from "react";
import { API_URL, fetchHealth, type Health } from "@/lib/api";

// Render's free API sleeps after 15 minutes; the first request can take up to about a minute.
const WAKING_AFTER_MS = 3_000; // show the "waking" counter after this long
const GIVE_UP_AFTER_MS = 60_000; // then stop and offer Retry
const RETRY_EVERY_MS = 3_000; // a waking server can also fail fast (e.g. 502) before it is ready

type State =
  | { kind: "checking" }
  | { kind: "done"; health: Health }
  | { kind: "error"; message: string };

export function HealthStatus() {
  const [state, setState] = useState<State>({ kind: "checking" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!API_URL) return;

    const controller = new AbortController();
    const started = Date.now();
    let timedOut = false;
    const ticker = setInterval(() => setElapsedMs(Date.now() - started), 1_000);
    const giveUp = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GIVE_UP_AFTER_MS);

    // Once polling ends (answer, give-up or unmount), stop re-rendering every second
    // and make sure the give-up timer can't fire later.
    const stopTimers = () => {
      clearInterval(ticker);
      clearTimeout(giveUp);
    };

    async function poll() {
      while (!controller.signal.aborted) {
        try {
          const health = await fetchHealth(controller.signal);
          stopTimers();
          setState({ kind: "done", health });
          return;
        } catch {
          if (controller.signal.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, RETRY_EVERY_MS));
        }
      }
      stopTimers();
      // Aborted by the give-up timer (not by unmount): report it.
      if (timedOut) setState({ kind: "error", message: "Can't reach the API" });
    }
    void poll();

    return () => {
      controller.abort();
      stopTimers();
    };
  }, [attempt]);

  // Reset here (an event handler), not inside the effect, then bump `attempt` to re-run the effect.
  const retry = useCallback(() => {
    setState({ kind: "checking" });
    setElapsedMs(0);
    setAttempt((n) => n + 1);
  }, []);
  const seconds = Math.floor(elapsedMs / 1_000);

  // A build-time config mistake, not a network problem: no point retrying.
  if (!API_URL) {
    return (
      <p className="font-mono text-sm text-blunder" role="status">
        NEXT_PUBLIC_API_URL is not set
      </p>
    );
  }

  return (
    <div className="font-mono text-sm" role="status" aria-live="polite">
      {state.kind === "checking" && (
        <p className="text-graphite/70">
          {elapsedMs >= WAKING_AFTER_MS ? `Waking the server up… (${seconds}s)` : "Checking the API…"}
        </p>
      )}

      {state.kind === "done" && (
        <p>
          <span className="text-best">API ok</span>
          <span className="px-2 text-graphite/50">·</span>
          {state.health.db ? (
            <span className="text-best">DB ok</span>
          ) : (
            <span className="text-blunder">DB down</span>
          )}
          <span className="pl-3 text-graphite/50">v{state.health.version}</span>
        </p>
      )}

      {state.kind === "error" && (
        <p className="flex items-center gap-3">
          <span className="text-blunder">{state.message}</span>
          <button
            type="button"
            onClick={retry}
            className="rounded border border-ink/30 px-2 py-0.5 transition hover:border-ink hover:bg-ink hover:text-bone active:scale-95"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  );
}
