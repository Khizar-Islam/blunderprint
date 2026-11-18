import { ApiError, type GameRow, type GamesPage } from "./api";

// The dashboard's games loading (components/PlayerDashboard.tsx), without React, so the paging,
// the merging and the "one load at a time" rule can be tested in Node.

export type LoadMode = "sync" | "reload";
export type GamesState = "idle" | "loading" | "error";

// Sorted like the API (playedAt desc, then id desc), so merging pages never reorders rows.
export const byNewest = (a: GameRow, b: GameRow) => b.playedAt.localeCompare(a.playedAt) || b.id.localeCompare(a.id);

// reload: the fresh rows replace the list. sync: they are merged into it by id (a fresh row wins).
export function mergeGames(prev: GameRow[], fresh: GameRow[], mode: LoadMode): GameRow[] {
  const merged = new Map<string, GameRow>();
  if (mode === "sync") for (const g of prev) merged.set(g.id, g);
  for (const g of fresh) merged.set(g.id, g);
  return [...merged.values()].sort(byNewest);
}

export interface GamesLoaderDeps {
  fetchPage(cursor: string | null, signal: AbortSignal): Promise<GamesPage>;
  onState(state: GamesState): void;
  onGames(fresh: GameRow[], mode: LoadMode): void;
}

// The loader remembers the cursor of the last page it fetched (null = the first page). While an
// import runs, each progress event syncs from that cursor and follows nextCursor to the end.
// A page holds 200 games (GAMES_PAGE_SIZE), so a player's whole list is normally one page with
// no nextCursor, and a sync re-reads the whole list from the top (up to ~19 KB on the wire).
// That's acceptable: there is one progress event per stored batch, roughly 1-2.5 s apart on
// Render, and load() runs one at a time and folds extra events into one follow-up. A player
// with more than 200 games still follows nextCursor. Rows are merged by id.
export function createGamesLoader({ fetchPage, onState, onGames }: GamesLoaderDeps) {
  let pageCursor: string | null = null;
  let busy = false;
  let again: "none" | LoadMode = "none";

  // `signal` cancels the load (the dashboard aborts it on unmount); a follow-up load uses the
  // same one, and never starts once it is aborted.
  async function load(mode: LoadMode, signal: AbortSignal): Promise<void> {
    // One load at a time; a request that arrives meanwhile runs once the current one ends
    // (a reload wins over a sync, as it covers it).
    if (busy) {
      if (again !== "reload") again = mode;
      return;
    }
    busy = true;
    onState("loading");
    try {
      // reload: from the top, replacing the list. Used when an import finishes, as the server
      // has then also trimmed the player to the newest games.
      let cursor = mode === "reload" ? null : pageCursor;
      const fresh = new Map<string, GameRow>();
      for (;;) {
        const page = await fetchPage(cursor, signal);
        for (const g of page.games) fresh.set(g.id, g);
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }
      pageCursor = cursor;
      onGames([...fresh.values()], mode);
      onState("idle");
    } catch (err) {
      if (signal.aborted) return;
      // 404 here means the player doesn't exist yet (first import still queued): no games yet.
      onState(err instanceof ApiError && err.status === 404 ? "idle" : "error");
    } finally {
      busy = false;
      const next = again;
      again = "none";
      if (next !== "none" && !signal.aborted) void load(next, signal);
    }
  }

  return { load };
}
