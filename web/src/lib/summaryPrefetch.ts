import { fetchSummary, type Platform, type SummaryResponse } from "./api";

// The dashboard's summary, started early: in parallel with the player lookup and the import
// check, instead of after them.
//
// Why: the patterns section only mounts once the start request has settled (GET player, then
// POST import), and only then did it ask for the summary: three requests in a row before the
// dashboard's main numbers could draw (Lighthouse: LCP 4.3 s on the demo dashboard, 2 s of it
// waiting on that chain). Now PlayerDashboard calls prefetchSummary() as the start request
// begins, and useSummary's first request takes that promise instead of starting its own.
//
// - Nothing about the import check is skipped: a re-import still bumps the dashboard's pulse
//   when it finishes, and the summary refreshes then (as before). For a frozen demo player the
//   import check can't change anything, so the early answer is simply the final one.
// - A failed prefetch is never shown: a 404 (a player not imported yet) or a network error just
//   means useSummary makes its own request, as it always did.
// - One entry per player + query, used once, and dropped after PREFETCH_TTL_MS, so an old
//   answer is never served later (e.g. after leaving and coming back to the dashboard).

export const PREFETCH_TTL_MS = 30_000;

type Fetcher = typeof fetchSummary;

const entries = new Map<string, Promise<SummaryResponse>>();

export const prefetchKey = (platform: Platform, username: string, query: string) => `${platform}:${username.toLowerCase()}:${query}`;

// Starts the request unless one for the same player and query is already waiting.
export function prefetchSummary(platform: Platform, username: string, query: string, fetcher: Fetcher = fetchSummary): void {
  const key = prefetchKey(platform, username, query);
  if (entries.has(key)) return;
  // Its own signal: the start request may be retried while Render wakes up; this one carries on.
  const promise = fetcher(platform, username, query, new AbortController().signal);
  promise.catch(() => {}); // handled by whoever takes it; never an unhandled rejection
  entries.set(key, promise);
  const timer: unknown = setTimeout(() => {
    if (entries.get(key) === promise) entries.delete(key);
  }, PREFETCH_TTL_MS);
  (timer as { unref?: () => void }).unref?.(); // Node (tests): don't keep the process alive for it
}

// The prefetched answer for this player and query, once (null if there is none).
export function takePrefetched(platform: Platform, username: string, query: string): Promise<SummaryResponse> | null {
  const key = prefetchKey(platform, username, query);
  const promise = entries.get(key) ?? null;
  entries.delete(key);
  return promise;
}

// useSummary's request: the prefetched answer if there is one, else (or if it failed) a fresh one.
export function loadSummary(
  platform: Platform,
  username: string,
  query: string,
  signal: AbortSignal,
  fetcher: Fetcher = fetchSummary,
): Promise<SummaryResponse> {
  const early = takePrefetched(platform, username, query);
  const fresh = () => fetcher(platform, username, query, signal);
  return early ? early.catch(fresh) : fresh();
}
