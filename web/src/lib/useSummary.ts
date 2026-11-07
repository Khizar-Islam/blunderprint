"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Platform, SummaryResponse } from "./api";
import { refetchDelay } from "./refetch";
import { loadSummary } from "./summaryPrefetch";

// The patterns summary for one player and one filter (`query`, from lib/filters.ts apiQuery).
//
// - The first request takes the dashboard's prefetched answer when there is one (it started in
//   parallel with the player lookup; lib/summaryPrefetch.ts), else it fetches.
// - A new query fetches at once and aborts the previous request. The last answer stays on screen
//   meanwhile (`loading` is true and the section dims it), so the charts animate from the old
//   numbers to the new ones instead of flashing empty.
// - `pulse` is a counter the dashboard bumps when something may have changed (the engine stored
//   a game, an import finished). Each answer remembers the pulse it was asked at, so the data is
//   stale while the pulse has moved on since. The refetch rule (lib/refetch.ts) then decides
//   when to ask again: at most every 10 s, and also while the API says it is still extracting.
//
// State only changes once a request settles (after the await), never at the start: setting state
// synchronously in an effect would render twice for nothing.

export const subscribeVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
export const isHidden = () => document.hidden;
export const neverHidden = () => false;

interface Answer {
  response: SummaryResponse;
  query: string;
  pulse: number; // the pulse when this request started
}

export interface SummaryView {
  data: SummaryResponse | null;
  loading: boolean; // a new filter's answer is on its way (the shown data is the old filter's)
  error: string | null;
  retry: () => void;
}

export function useSummary(platform: Platform, username: string, query: string, enabled: boolean, pulse: number): SummaryView {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState<{ message: string; at: number } | null>(null);
  const hidden = useSyncExternalStore(subscribeVisibility, isHidden, neverHidden);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const lastFetchAt = useRef(0);
  // Read inside `run` without making it a dependency: a new pulse must not refetch at once
  // (that would skip the 10 s gap); the refetch rule schedules it.
  const pulseRef = useRef(pulse);
  useEffect(() => {
    pulseRef.current = pulse;
  });

  const run = useCallback(async () => {
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    lastFetchAt.current = Date.now();
    inFlight.current = true;
    const askedAt = pulseRef.current;
    try {
      const response = await loadSummary(platform, username, query, c.signal);
      // A prefetched answer doesn't listen to the signal: drop it if this request was replaced.
      if (c.signal.aborted) return;
      setAnswer({ response, query, pulse: askedAt });
      setError(null);
    } catch (err) {
      if (c.signal.aborted) return;
      setError({ message: err instanceof Error ? err.message : "Couldn't load the patterns", at: Date.now() });
    } finally {
      if (controller.current === c) inFlight.current = false;
    }
  }, [platform, username, query]);

  // First load, and every change of filter: at once.
  useEffect(() => {
    if (!enabled) return;
    void run();
    return () => controller.current?.abort();
  }, [enabled, run]);

  // Later refreshes, on the refetch rule. Re-checked whenever an answer (or error) arrives, the
  // pulse moves, or the tab is shown again.
  const stale = answer !== null && answer.pulse !== pulse;
  const extracting = answer?.response.extracting ?? false;
  useEffect(() => {
    if (!enabled || answer === null || answer.query !== query) return;
    const delay = refetchDelay({
      stale,
      extracting,
      hidden,
      inFlight: inFlight.current,
      lastFetchAt: lastFetchAt.current,
      now: Date.now(),
    });
    if (delay === null) return;
    const timer = setTimeout(() => void run(), delay);
    return () => clearTimeout(timer);
  }, [enabled, answer, query, stale, extracting, hidden, error, run]);

  return {
    data: answer?.response ?? null,
    loading: answer !== null && answer.query !== query && error === null,
    error: error?.message ?? null,
    retry: () => void run(),
  };
}
