"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { fetchCoachInfo, type CoachInfo, type Platform } from "./api";
import { refetchDelay } from "./refetch";
import { isHidden, neverHidden, subscribeVisibility } from "./useSummary";

// The dashboard's view of the coach (GET /report): eligibility, the latest report, an active
// run, the AI state. Refetched on the same pulse as the patterns (the engine stored a game, an
// import finished), at most every 10 s, never while the tab is hidden (lib/refetch.ts). While a
// run is going it keeps checking, so the button turns into "See your coach report" by itself.
export function useCoachInfo(platform: Platform, username: string, enabled: boolean, pulse: number) {
  const [answer, setAnswer] = useState<{ info: CoachInfo; pulse: number } | null>(null);
  const [failed, setFailed] = useState(0);
  const hidden = useSyncExternalStore(subscribeVisibility, isHidden, neverHidden);
  const controller = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const lastFetchAt = useRef(0);
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
      const info = await fetchCoachInfo(platform, username, c.signal);
      setAnswer({ info, pulse: askedAt });
    } catch {
      // The button is optional: on an error it keeps its last state and tries again later.
      if (!c.signal.aborted) setFailed((n) => n + 1);
    } finally {
      if (controller.current === c) inFlight.current = false;
    }
  }, [platform, username]);

  useEffect(() => {
    if (!enabled) return;
    void run();
    return () => controller.current?.abort();
  }, [enabled, run]);

  const stale = answer === null ? failed > 0 : answer.pulse !== pulse || failed > 0;
  const running = answer?.info.activeRun != null;
  useEffect(() => {
    if (!enabled || (answer === null && failed === 0)) return;
    const delay = refetchDelay({ stale, extracting: running, hidden, inFlight: inFlight.current, lastFetchAt: lastFetchAt.current, now: Date.now() });
    if (delay === null) return;
    const timer = setTimeout(() => {
      setFailed(0);
      void run();
    }, delay);
    return () => clearTimeout(timer);
  }, [enabled, answer, failed, stale, running, hidden, run]);

  return answer?.info ?? null;
}
