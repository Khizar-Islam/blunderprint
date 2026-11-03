// When the dashboard asks for the summary again (lib/useSummary.ts), as a pure function so the
// rule can be tested with a fake clock.
//
// Something new may be waiting when the engine stored a game, an import finished (`stale`), or
// the API said some games still lack features (`extracting`). Then refetch, but at most once
// every REFETCH_GAP_MS: with two engines a game lands every few seconds, and the numbers don't
// need to move that often. Nothing while a request is out or the tab is hidden (the
// visibilitychange event re-runs the check when it comes back).

export const REFETCH_GAP_MS = 10_000;

export interface RefetchState {
  stale: boolean;
  extracting: boolean;
  hidden: boolean;
  inFlight: boolean;
  lastFetchAt: number;
  now: number;
}

// Milliseconds to wait before refetching, or null for "no refetch needed".
export function refetchDelay(s: RefetchState, gapMs = REFETCH_GAP_MS): number | null {
  if (s.inFlight || s.hidden) return null;
  if (!s.stale && !s.extracting) return null;
  return Math.max(0, s.lastFetchAt + gapMs - s.now);
}
