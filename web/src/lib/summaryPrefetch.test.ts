import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, type SummaryResponse } from "./api";
import { loadSummary, prefetchSummary, takePrefetched } from "./summaryPrefetch";

const answer = (tag: string) => ({ summary: { tag }, cached: true, extracting: false }) as unknown as SummaryResponse;

function fakeFetcher(results: (() => Promise<SummaryResponse>)[]) {
  const calls: string[] = [];
  const fetcher = (async (_p: string, u: string, q: string) => {
    calls.push(`${u}?${q}`);
    return results[calls.length - 1]!();
  }) as unknown as Parameters<typeof loadSummary>[4];
  return { fetcher, calls };
}

test("the prefetched answer is used once, by the first load; the next load fetches", async () => {
  const { fetcher, calls } = fakeFetcher([async () => answer("early"), async () => answer("fresh")]);
  prefetchSummary("lichess", "Once", "", fetcher);
  const first = await loadSummary("lichess", "once", "", new AbortController().signal, fetcher); // username case doesn't matter
  const second = await loadSummary("lichess", "Once", "", new AbortController().signal, fetcher);
  assert.equal((first.summary as unknown as { tag: string }).tag, "early");
  assert.equal((second.summary as unknown as { tag: string }).tag, "fresh");
  assert.equal(calls.length, 2);
});

test("a second prefetch for the same player and query doesn't start another request", () => {
  const { fetcher, calls } = fakeFetcher([async () => answer("a"), async () => answer("b")]);
  prefetchSummary("lichess", "Dup", "color=white", fetcher);
  prefetchSummary("lichess", "Dup", "color=white", fetcher); // e.g. the waking hook retrying
  assert.equal(calls.length, 1);
  assert.notEqual(takePrefetched("lichess", "Dup", "color=white"), null);
  assert.equal(takePrefetched("lichess", "Dup", "color=white"), null);
});

test("a failed prefetch (a player not imported yet: 404) is never shown; the load fetches instead", async () => {
  const { fetcher, calls } = fakeFetcher([async () => Promise.reject(new ApiError(404, "Player not found")), async () => answer("fresh")]);
  prefetchSummary("chesscom", "newcomer", "", fetcher);
  const got = await loadSummary("chesscom", "newcomer", "", new AbortController().signal, fetcher);
  assert.equal((got.summary as unknown as { tag: string }).tag, "fresh");
  assert.equal(calls.length, 2);
});

test("a prefetch for another filter isn't used", async () => {
  const { fetcher, calls } = fakeFetcher([async () => answer("white"), async () => answer("unfiltered")]);
  prefetchSummary("lichess", "Filters", "color=white", fetcher);
  const got = await loadSummary("lichess", "Filters", "", new AbortController().signal, fetcher);
  assert.equal((got.summary as unknown as { tag: string }).tag, "unfiltered");
  assert.deepEqual(calls, ["Filters?color=white", "Filters?"]);
});
