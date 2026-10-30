import { test } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, recordingFetch, statusResponse } from "../../scripts/fakeFetch.js";
import { chessComGame, chessComPgn } from "../../scripts/fixtures.js";
import { createChessComImporter, normalizeChessComGame, type ChessComGame } from "./chesscom.js";
import { countPlies, type ImportBatch, type NormalizedGame } from "./normalize.js";
import { createPoliteClient } from "./politeFetch.js";

test("normalizes a game from the player's side", () => {
  const game = normalizeChessComGame(chessComGame({ endTime: new Date("2026-10-15T12:00:00Z") }), "alice")!;
  assert.equal(game.color, "white");
  assert.equal(game.result, "win");
  assert.equal(game.termination, "checkmated");
  assert.equal(game.speed, "blitz");
  assert.equal(game.plies, 7);
  assert.deepEqual(game.clocks, [179.9, 178.1, 177, 175, 170, 160, 165]);
  assert.match(game.sourceId, /^live\/\d+$/);
  assert.equal(game.playedAt.toISOString(), "2026-10-15T12:00:00.000Z");
  assert.deepEqual(game.opening, { eco: "C20", name: "Kings Pawn Opening Wayward Queen Attack" });
  assert.equal(game.opponentName, "bob");
  assert.equal(game.evals, undefined);

  const asBlack = normalizeChessComGame(chessComGame(), "BOB".toLowerCase())!;
  assert.equal(asBlack.color, "black");
  assert.equal(asBlack.result, "loss");
  assert.equal(asBlack.playerRating, 1480);
});

test("draw codes become a draw", () => {
  for (const code of ["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]) {
    const game = chessComGame({
      white: { username: "Alice", rating: 1500, result: code },
      black: { username: "bob", rating: 1480, result: code },
    });
    assert.equal(normalizeChessComGame(game, "alice")!.result, "draw", code);
  }
});

test("skips variants, custom start positions, aborted games and other players' games", () => {
  const skipped: ChessComGame[] = [
    chessComGame({ rules: "chess960" }),
    chessComGame({ initial_setup: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1" }),
    chessComGame({ pgn: chessComPgn("Alice", "bob", ['[SetUp "1"]', '[FEN "8/8/8/8/8/8/8/K6k w - - 0 1"]']) }),
    chessComGame({ pgn: '[White "Alice"]\n[Black "bob"]\n\n1. e4 {[%clk 0:02:59]} *' }), // 1 ply: aborted
    chessComGame({ pgn: '[White "Alice"]\n[Black "bob"]\n\n1. e4 e5 2. Ke3?? Qh4 *' }), // doesn't replay
    chessComGame({ pgn: undefined }),
  ];
  for (const game of skipped) assert.equal(normalizeChessComGame(game, "alice"), null);
  assert.equal(normalizeChessComGame(chessComGame(), "carol"), null);
});

test("works out the speed from the time control when time_class is missing", () => {
  const speedOf = (time_control: string) => normalizeChessComGame(chessComGame({ time_class: undefined, time_control }), "alice")!.speed;
  assert.equal(speedOf("60+1"), "bullet"); // 60 + 40 = 100 s
  assert.equal(speedOf("180+2"), "blitz"); // 260 s
  assert.equal(speedOf("600"), "rapid");
  assert.equal(speedOf("1800"), "classical");
  assert.equal(speedOf("1/259200"), "daily");
});

// A fake Chess.com with three monthly archives of three games each.
function fakeChessCom(etags: Record<string, string> = {}) {
  const month = (key: string, day: number) =>
    [0, 1, 2].map((i) => chessComGame({ endTime: new Date(`${key.replace("/", "-")}-${String(day + i).padStart(2, "0")}T10:00:00Z`) }));
  const months: Record<string, ChessComGame[]> = {
    "2026/08": month("2026/08", 10),
    "2026/09": month("2026/09", 10),
    "2026/10": month("2026/10", 10),
  };
  const base = "https://api.chess.com/pub/player/alice";
  return recordingFetch((url) => {
    if (url === base) return jsonResponse({ username: "Alice", avatar: "https://img/a.png", country: "https://api.chess.com/pub/country/PK" });
    if (url === `${base}/stats`) return jsonResponse({ chess_blitz: { last: { rating: 1500 } }, chess_rapid: { last: { rating: 1600 } } });
    if (url === `${base}/games/archives`) return jsonResponse({ archives: Object.keys(months).map((k) => `${base}/games/${k}`) });
    const key = url.slice(-7);
    if (months[key]) return jsonResponse({ games: months[key] }, { headers: { etag: etags[key] ?? `W/"${key}"` } });
    return statusResponse(404);
  });
}

async function runImport(
  fetch: ReturnType<typeof recordingFetch>["fetch"],
  options: { maxGames: number; known?: { newestGameAt?: Date; monthEtags: Record<string, string> }; checkpoint?: unknown },
) {
  const importer = createChessComImporter(createPoliteClient({ name: "Chess.com", userAgent: "t", rateLimitWaitsMs: [1], fetch }));
  const batches: ImportBatch<unknown>[] = [];
  const result = await importer.importGames({
    username: "Alice",
    maxGames: options.maxGames,
    signal: new AbortController().signal,
    known: options.known ?? { monthEtags: {} },
    checkpoint: options.checkpoint,
    onBatch: async (batch) => void batches.push(batch),
  });
  return { batches, result };
}

test("fetchProfile reads ratings and country, and returns null for a missing user", async () => {
  const { fetch } = fakeChessCom();
  const importer = createChessComImporter(createPoliteClient({ name: "Chess.com", userAgent: "t", rateLimitWaitsMs: [1], fetch }));
  const profile = await importer.fetchProfile("ALICE", new AbortController().signal);
  assert.deepEqual(profile, {
    username: "Alice",
    ratings: { blitz: 1500, rapid: 1600, bullet: undefined },
    avatarUrl: "https://img/a.png",
    country: "PK",
  });
  assert.equal(await importer.fetchProfile("nobody", new AbortController().signal), null);
});

test("walks the archives newest month first and stops at maxGames", async () => {
  const { fetch, calls } = fakeChessCom();
  const { batches, result } = await runImport(fetch, { maxGames: 5 });

  assert.deepEqual(
    calls.map((c) => c.url.slice(-14)),
    ["games/archives", "/games/2026/10", "/games/2026/09"],
  );
  assert.deepEqual(batches.map((b) => b.games.length), [3, 2]);
  // Newest first inside each month too.
  const dates = batches.flatMap((b) => b.games.map((g) => g.playedAt.getTime()));
  assert.deepEqual(dates, [...dates].sort((a, b) => b - a));
  assert.deepEqual(batches[1]!.checkpoint, { monthsDone: ["2026/10", "2026/09"], collected: 5, newestGameAt: dates[0] });
  assert.deepEqual(batches[0]!.month, { key: "2026/10", etag: 'W/"2026/10"' });
  assert.equal(result.newestGameAt?.getTime(), dates[0]);
});

test("a re-import sends ETags, skips unchanged months and stops at the newest stored month", async () => {
  const { fetch: base } = fakeChessCom();
  const { fetch, calls } = recordingFetch(async (url, n) => {
    const sent = calls[n]!.headers["If-None-Match"];
    if (url.endsWith("/2026/10") && sent === 'W/"2026/10"') return statusResponse(304, { etag: sent });
    return base(url, {});
  });
  const { batches } = await runImport(fetch, {
    maxGames: 200,
    known: { newestGameAt: new Date("2026-09-12T10:00:00Z"), monthEtags: { "2026/10": 'W/"2026/10"' } },
  });
  assert.equal(calls.find((c) => c.url.endsWith("/2026/10"))!.headers["If-None-Match"], 'W/"2026/10"');
  assert.deepEqual(batches.map((b) => [b.month!.key, b.games.length]), [["2026/10", 0], ["2026/09", 3]]);
  assert.ok(!calls.some((c) => c.url.endsWith("/2026/08")), "older months are not fetched again");
});

// One archive month holding these games.
function oneMonth(games: ChessComGame[]) {
  const base = "https://api.chess.com/pub/player/alice";
  return recordingFetch((url) =>
    url.endsWith("/games/archives") ? jsonResponse({ archives: [`${base}/games/2026/10`] }) : jsonResponse({ games }),
  );
}

// A spy ply counter: counts calls and lets a test see them as they happen.
function spyCounter(onCall?: (calls: number) => void) {
  const spy = {
    calls: 0,
    count: (pgn: string) => {
      spy.calls++;
      onCall?.(spy.calls);
      return countPlies(pgn);
    },
  };
  return spy;
}

async function importMonth(games: ChessComGame[], maxGames: number, counter: ReturnType<typeof spyCounter>) {
  const { fetch } = oneMonth(games);
  const client = createPoliteClient({ name: "Chess.com", userAgent: "t", rateLimitWaitsMs: [1], fetch });
  const stored: NormalizedGame[] = [];
  await createChessComImporter(client, { plyCounter: counter.count }).importGames({
    username: "Alice",
    maxGames,
    signal: new AbortController().signal,
    known: { monthEtags: {} },
    onBatch: async (batch) => void stored.push(...batch.games),
  });
  return stored;
}

// n games in one month, one minute apart, shuffled: nothing guarantees the API's order.
// The shuffle is seeded, so every run sees the same order and a failure can be reproduced.
function busyMonth(n: number, seed = 42): ChessComGame[] {
  const start = Date.parse("2026-10-31T00:00:00Z");
  const games = Array.from({ length: n }, (_, i) => chessComGame({ endTime: new Date(start - i * 60_000) }));
  // mulberry32: a tiny seeded random number generator, then a Fisher–Yates shuffle.
  let state = seed;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = games.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [games[i], games[j]] = [games[j], games[i]];
  }
  return games;
}

test("a busy month replays only the games still needed, newest first", async () => {
  const counter = spyCounter();
  const stored = await importMonth(busyMonth(1_000), 5, counter);
  assert.equal(stored.length, 5);
  assert.ok(counter.calls <= 15, `ply counter called ${counter.calls} times`);
  assert.deepEqual(
    stored.map((g) => g.playedAt.getTime()),
    [0, 1, 2, 3, 4].map((i) => Date.parse("2026-10-31T00:00:00Z") - i * 60_000),
  );
});

test("games that fail the replay are replaced by the next ones from the same month", async () => {
  const games = busyMonth(50);
  const newestFirst = [...games].sort((a, b) => b.end_time - a.end_time);
  // The 3 newest games don't replay.
  for (const g of newestFirst.slice(0, 3)) g.pgn = '[White "Alice"]\n[Black "bob"]\n\n1. e4 e5 2. Ke3?? Qh4 *';
  const counter = spyCounter();
  const stored = await importMonth(games, 5, counter);
  assert.equal(stored.length, 5);
  assert.equal(counter.calls, 8);
  assert.deepEqual(stored.map((g) => g.sourceId), newestFirst.slice(3, 8).map((g) => g.url.match(/\/game\/(.+)$/)![1]));
});

test("cheap checks skip variants and other players' games without replaying them", async () => {
  const games = [
    ...Array.from({ length: 20 }, () => chessComGame({ rules: "chess960" })),
    ...Array.from({ length: 20 }, () =>
      chessComGame({ white: { username: "carol", result: "win" }, black: { username: "dave", result: "resigned" } }),
    ),
    chessComGame(),
  ];
  const counter = spyCounter();
  const stored = await importMonth(games, 200, counter);
  assert.equal(stored.length, 1);
  assert.equal(counter.calls, 1);
});

test("processing a month yields to the event loop every 10 games", async () => {
  // Schedule a setImmediate during the first replay: it can only run once the loop yields.
  let callsWhenItRan: number | undefined;
  const counter = spyCounter((calls) => {
    if (calls === 1) setImmediate(() => (callsWhenItRan = counter.calls));
  });
  const stored = await importMonth(busyMonth(30), 30, counter);
  assert.equal(stored.length, 30);
  assert.equal(callsWhenItRan, 10);
});

test("resuming from a checkpoint skips the months already done", async () => {
  const { fetch, calls } = fakeChessCom();
  const { batches } = await runImport(fetch, { maxGames: 200, checkpoint: { monthsDone: ["2026/10"], collected: 3 } });
  assert.ok(!calls.some((c) => c.url.endsWith("/2026/10")));
  assert.deepEqual(batches.map((b) => b.month!.key), ["2026/09", "2026/08"]);
  assert.equal((batches.at(-1)!.checkpoint as { collected: number }).collected, 9);
});
