import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError, type GameRow, type GamesPage } from "./api";
import { createGamesLoader, mergeGames, type GamesState, type LoadMode } from "./gamesLoader";

// The dashboard's games list: paging, merging by id, and one load at a time while an import's
// progress events arrive faster than the requests they cause.

// g(3) is newer than g(2): ids and dates grow together.
const g = (n: number, extra: Partial<GameRow> = {}): GameRow => ({
  id: `g${String(n).padStart(3, "0")}`,
  sourceId: `s${n}`,
  platform: "lichess",
  playedAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
  color: "white",
  result: "win",
  speed: "blitz",
  plies: 40,
  ...extra,
});
const ids = (games: GameRow[]) => games.map((x) => x.id);

// A server whose answers the test releases by hand, so loads can overlap.
function harness() {
  const requests: { cursor: string | null; resolve(page: GamesPage): void; reject(err: unknown): void }[] = [];
  const states: GamesState[] = [];
  const deliveries: { mode: LoadMode; ids: string[] }[] = [];
  let list: GameRow[] = [];
  const loader = createGamesLoader({
    fetchPage: (cursor) => new Promise<GamesPage>((resolve, reject) => requests.push({ cursor, resolve, reject })),
    onState: (s) => states.push(s),
    onGames: (fresh, mode) => {
      deliveries.push({ mode, ids: ids(fresh) });
      list = mergeGames(list, fresh, mode);
    },
  });
  const controller = new AbortController();
  // Lets the loader's awaits run.
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };
  return { loader, requests, states, deliveries, controller, settle, load: (mode: LoadMode) => loader.load(mode, controller.signal), list: () => list };
}

describe("mergeGames", () => {
  test("sync merges by id (the fresh row wins) and keeps newest first", () => {
    const prev = [g(3), g(2), g(1)];
    const analysed = g(2, { analysis: { status: "done", accuracy: 91 } });
    const merged = mergeGames(prev, [analysed, g(4)], "sync");
    assert.deepEqual(ids(merged), ["g004", "g003", "g002", "g001"]);
    assert.equal(merged[2]!.analysis?.accuracy, 91);
  });

  test("reload replaces the list: a game the server trimmed is gone", () => {
    assert.deepEqual(ids(mergeGames([g(3), g(2), g(1)], [g(4), g(3)], "reload")), ["g004", "g003"]);
  });

  test("the same playedAt: the id breaks the tie, like the API's sort", () => {
    const at = g(1).playedAt;
    assert.deepEqual(ids(mergeGames([], [g(1), g(7, { playedAt: at }), g(5, { playedAt: at })], "sync")), ["g007", "g005", "g001"]);
  });
});

describe("the games loader", () => {
  test("a whole list in one page: one request from the top, then idle", async () => {
    const h = harness();
    const done = h.load("reload");
    assert.deepEqual(h.states, ["loading"]);
    h.requests[0]!.resolve({ games: [g(2), g(1)], nextCursor: null });
    await done;
    assert.deepEqual(h.requests.map((r) => r.cursor), [null]);
    assert.deepEqual(h.states, ["loading", "idle"]);
    assert.deepEqual(ids(h.list()), ["g002", "g001"]);
  });

  test("more than one page (a 201st game): nextCursor is followed to the end, delivered once", async () => {
    const h = harness();
    const done = h.load("reload");
    h.requests[0]!.resolve({ games: [g(3), g(2)], nextCursor: "c1" });
    await h.settle();
    h.requests[1]!.resolve({ games: [g(1)], nextCursor: null });
    await done;
    assert.deepEqual(h.requests.map((r) => r.cursor), [null, "c1"]);
    assert.deepEqual(h.deliveries, [{ mode: "reload", ids: ["g003", "g002", "g001"] }]);
  });

  test("a sync starts at the last page fetched, not at the top; a reload starts at the top again", async () => {
    const h = harness();
    let done = h.load("reload");
    h.requests[0]!.resolve({ games: [g(9), g(8)], nextCursor: "c1" });
    await h.settle();
    h.requests[1]!.resolve({ games: [g(7)], nextCursor: null });
    await done;

    // The import stored older games: the last page is read again and now has more.
    done = h.load("sync");
    h.requests[2]!.resolve({ games: [g(7), g(6)], nextCursor: null });
    await done;
    assert.equal(h.requests[2]!.cursor, "c1");
    assert.deepEqual(ids(h.list()), ["g009", "g008", "g007", "g006"]);

    done = h.load("reload");
    h.requests[3]!.resolve({ games: [g(9)], nextCursor: null });
    await done;
    assert.equal(h.requests[3]!.cursor, null);
    assert.deepEqual(ids(h.list()), ["g009"]);
  });

  test("three progress events during one load cause ONE follow-up load, not three", async () => {
    const h = harness();
    const first = h.load("sync");
    void h.load("sync");
    void h.load("sync");
    void h.load("sync");
    assert.equal(h.requests.length, 1, "one request at a time");
    h.requests[0]!.resolve({ games: [g(1)], nextCursor: null });
    await first;
    await h.settle();
    assert.equal(h.requests.length, 2, "the follow-up");
    h.requests[1]!.resolve({ games: [g(2), g(1)], nextCursor: null });
    await h.settle();
    assert.equal(h.requests.length, 2, "and nothing after it");
    assert.deepEqual(ids(h.list()), ["g002", "g001"]);
    assert.deepEqual(h.states, ["loading", "idle", "loading", "idle"]);
  });

  test("a reload asked for during a load wins over a sync, whichever came first", async () => {
    for (const order of [["sync", "reload"], ["reload", "sync"]] as LoadMode[][]) {
      const h = harness();
      const first = h.load("sync");
      for (const mode of order) void h.load(mode);
      h.requests[0]!.resolve({ games: [g(5), g(4)], nextCursor: null });
      await first;
      await h.settle();
      h.requests[1]!.resolve({ games: [g(5)], nextCursor: null });
      await h.settle();
      assert.deepEqual(h.deliveries.map((d) => d.mode), ["sync", "reload"], order.join(" then "));
      assert.deepEqual(ids(h.list()), ["g005"]);
    }
  });

  test("a 404 means the player doesn't exist yet (first import still queued): no error shown, list kept", async () => {
    const h = harness();
    const done = h.load("reload");
    h.requests[0]!.reject(new ApiError(404, "Player not found"));
    await done;
    assert.deepEqual(h.states, ["loading", "idle"]);
    assert.deepEqual(h.deliveries, []);
  });

  test("any other failure shows the error state, and the next load still runs", async () => {
    const h = harness();
    let done = h.load("reload");
    h.requests[0]!.reject(new ApiError(0, "Can't reach the API"));
    await done;
    assert.deepEqual(h.states, ["loading", "error"]);

    done = h.load("reload");
    h.requests[1]!.resolve({ games: [g(1)], nextCursor: null });
    await done;
    assert.deepEqual(h.states, ["loading", "error", "loading", "idle"]);
  });

  test("a failed page leaves the cursor where it was: the next sync repeats the same page", async () => {
    const h = harness();
    let done = h.load("reload");
    h.requests[0]!.resolve({ games: [g(3)], nextCursor: "c1" });
    await h.settle();
    h.requests[1]!.resolve({ games: [g(2)], nextCursor: null });
    await done;
    done = h.load("sync");
    h.requests[2]!.reject(new ApiError(502, "Bad gateway"));
    await done;
    done = h.load("sync");
    h.requests[3]!.resolve({ games: [g(2), g(1)], nextCursor: null });
    await done;
    assert.deepEqual(h.requests.map((r) => r.cursor), [null, "c1", "c1", "c1"]);
  });

  test("the page was left mid-load: no state change, no rows delivered, no follow-up", async () => {
    const h = harness();
    const done = h.load("reload");
    void h.load("sync");
    h.controller.abort();
    h.requests[0]!.reject(new DOMException("aborted", "AbortError"));
    await done;
    await h.settle();
    assert.deepEqual(h.states, ["loading"]);
    assert.deepEqual(h.deliveries, []);
    assert.equal(h.requests.length, 1);
  });
});
