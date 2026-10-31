import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkedResponse, jsonResponse, recordingFetch, statusResponse } from "../../scripts/fakeFetch.js";
import { LICHESS_ANALYSIS, lichessGame } from "../../scripts/fixtures.js";
import { createLichessImporter, normalizeLichessGame, type LichessGame } from "./lichess.js";
import type { ImportBatch } from "./normalize.js";
import { createPoliteClient } from "./politeFetch.js";

test("normalizes a game, converting clocks from centiseconds and keeping Lichess evals", () => {
  const game = normalizeLichessGame(lichessGame({ id: "abcd1234", analysis: LICHESS_ANALYSIS }), "alice")!;
  assert.equal(game.sourceId, "abcd1234");
  assert.equal(game.color, "white");
  assert.equal(game.result, "win");
  assert.equal(game.termination, "mate");
  assert.equal(game.timeControl, "180+0");
  assert.equal(game.plies, 7);
  assert.deepEqual(game.clocks, [180.03, 180.03, 178, 177, 175, 170, 174]);
  assert.deepEqual(game.evals, [{ cp: 30 }, { cp: 30 }, { cp: 10 }, { cp: 20 }, { cp: 10 }, { mate: 1 }, { mate: 0 }]);
  assert.deepEqual(game.opening, { eco: "C20", name: "King's Pawn Game: Wayward Queen Attack", ply: 3 });
  assert.equal(game.playedAt.toISOString(), "2026-10-15T12:05:00.000Z");

  const asBlack = normalizeLichessGame(lichessGame(), "bob")!;
  assert.equal(asBlack.color, "black");
  assert.equal(asBlack.result, "loss");
  assert.equal(asBlack.opponentName, "alice");
});

test("no winner is a draw; correspondence is daily; AI opponents get a name", () => {
  const game = normalizeLichessGame(
    lichessGame({
      winner: undefined,
      status: "draw",
      speed: "correspondence",
      clock: undefined,
      daysPerTurn: 3,
      players: { white: { user: { name: "alice", id: "alice" }, rating: 1600 }, black: { aiLevel: 5 } },
    }),
    "alice",
  )!;
  assert.equal(game.result, "draw");
  assert.equal(game.speed, "daily");
  assert.equal(game.timeControl, "1/259200");
  assert.equal(game.opponentName, "Stockfish level 5");
});

test("only trusts evals when there's one for every ply", () => {
  assert.equal(normalizeLichessGame(lichessGame({ analysis: LICHESS_ANALYSIS.slice(1) }), "alice")!.evals, undefined);
  const gap = [...LICHESS_ANALYSIS.slice(0, 6), {}];
  assert.equal(normalizeLichessGame(lichessGame({ analysis: gap }), "alice")!.evals, undefined);
});

test("skips variants, games from a position, aborted games and other players' games", () => {
  const skipped: LichessGame[] = [
    lichessGame({ variant: "chess960" }),
    lichessGame({ initialFen: "8/8/8/8/8/8/8/K6k w - - 0 1" }),
    lichessGame({ status: "aborted" }),
    lichessGame({ status: "noStart" }),
    lichessGame({ pgn: undefined }),
  ];
  for (const game of skipped) assert.equal(normalizeLichessGame(game, "alice"), null);
  assert.equal(normalizeLichessGame(lichessGame(), "carol"), null);
});

function importer(fetch: ReturnType<typeof recordingFetch>["fetch"]) {
  return createLichessImporter(createPoliteClient({ name: "Lichess", userAgent: "t", rateLimitWaitsMs: [1], fetch }));
}

async function runImport(
  fetch: ReturnType<typeof recordingFetch>["fetch"],
  options: { maxGames?: number; known?: { newestGameAt?: Date; monthEtags: Record<string, string> }; checkpoint?: unknown } = {},
) {
  const batches: ImportBatch<unknown>[] = [];
  const result = await importer(fetch).importGames({
    username: "Alice",
    maxGames: options.maxGames ?? 200,
    signal: new AbortController().signal,
    known: options.known ?? { monthEtags: {} },
    checkpoint: options.checkpoint,
    onBatch: async (batch) => void batches.push(batch),
  });
  return { batches, result };
}

// n games, newest first like the real export, one minute apart, every 10th a variant.
function exportOf(n: number): string {
  const start = Date.parse("2026-10-20T00:00:00Z");
  return Array.from({ length: n }, (_, i) =>
    JSON.stringify(lichessGame({ createdAt: start - i * 60_000, variant: i % 10 === 9 ? "atomic" : "standard" })),
  ).join("\n");
}

test("asks for the right export and sends NDJSON, clocks, evals and openings", async () => {
  const { fetch, calls } = recordingFetch(() => chunkedResponse([exportOf(3)]));
  await runImport(fetch, { maxGames: 150 });
  const url = new URL(calls[0]!.url);
  assert.equal(url.pathname, "/api/games/user/alice");
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    max: "150",
    sort: "dateDesc",
    perfType: "bullet,blitz,rapid,classical,correspondence",
    clocks: "true",
    evals: "true",
    opening: "true",
    pgnInJson: "true",
  });
  assert.equal(calls[0]!.headers.Accept, "application/x-ndjson");
});

test("streams games in batches of 50, skipping variants, with a resume checkpoint", async () => {
  // Split the stream at awkward places, like a real network.
  const body = exportOf(120);
  const { fetch } = recordingFetch(() => chunkedResponse([body.slice(0, 1000), body.slice(1000, 50_000), body.slice(50_000)]));
  const { batches, result } = await runImport(fetch);

  assert.deepEqual(batches.map((b) => b.games.length), [50, 50, 8]); // 12 of 120 are variants
  const last = batches.at(-1)!.checkpoint as { collected: number; oldestCreatedAt: number; newestCreatedAt: number };
  assert.equal(last.collected, 108);
  assert.equal(last.oldestCreatedAt, Date.parse("2026-10-20T00:00:00Z") - 119 * 60_000);
  assert.equal(result.newestGameAt?.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("slow batch writes don't stall the stream, and batches are still stored in order", async () => {
  // Regression: awaiting each DB write inside the stream tripped the idle timeout on a slow
  // upload. Here every write takes longer than the whole idle timeout.
  const body = exportOf(110);
  const { fetch } = recordingFetch((_url, _n, signal) =>
    chunkedResponse([body.slice(0, 30_000), body.slice(30_000, 60_000), body.slice(60_000)], signal),
  );
  // No retries, so a stall would surface as an error instead of a silent second attempt.
  const client = createPoliteClient({ name: "Lichess", userAgent: "t", rateLimitWaitsMs: [1], errorWaitsMs: [], timeoutMs: 50, fetch });
  const stored: number[] = [];
  await createLichessImporter(client).importGames({
    username: "Alice",
    maxGames: 200,
    signal: new AbortController().signal,
    known: { monthEtags: {} },
    onBatch: async (batch) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      stored.push((batch.checkpoint as { collected: number }).collected);
    },
  });
  assert.deepEqual(stored, [50, 99]);
});

test("a failed batch write fails the import and stops further writes", async () => {
  const { fetch } = recordingFetch(() => chunkedResponse([exportOf(160)]));
  let writes = 0;
  await assert.rejects(
    createLichessImporter(createPoliteClient({ name: "Lichess", userAgent: "t", rateLimitWaitsMs: [1], fetch })).importGames({
      username: "Alice",
      maxGames: 200,
      signal: new AbortController().signal,
      known: { monthEtags: {} },
      onBatch: async () => {
        writes++;
        throw new Error("db down");
      },
    }),
    /db down/,
  );
  assert.equal(writes, 1);
});

test("after an abort, queued batch writes are dropped instead of drained", async () => {
  // Regression: on Ctrl+C the importer waited for a backlog of slow Atlas writes (5–17 s each)
  // and the shutdown's 10 s force-exit killed the process before the job was released.
  const { fetch } = recordingFetch(() => chunkedResponse([exportOf(160)])); // 144 standard games: 3 batches
  const controller = new AbortController();
  const stored: number[] = [];
  const run = createLichessImporter(createPoliteClient({ name: "Lichess", userAgent: "t", rateLimitWaitsMs: [1], fetch })).importGames({
    username: "Alice",
    maxGames: 200,
    signal: controller.signal,
    known: { monthEtags: {} },
    onBatch: async (batch) => {
      controller.abort(new Error("shutting down")); // the abort lands while this first write runs
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored.push((batch.checkpoint as { collected: number }).collected);
    },
  });
  await run.catch(() => {});
  // Only the write already in flight finished. Its checkpoint (50) is where a resume starts,
  // so the two dropped batches are fetched again rather than lost.
  assert.deepEqual(stored, [50]);
});

test("re-imports use since; resumes use until and ask only for the games still missing", async () => {
  const { fetch, calls } = recordingFetch(() => chunkedResponse([""]));
  await runImport(fetch, {
    maxGames: 200,
    known: { newestGameAt: new Date(1_790_000_000_000), monthEtags: {} },
    checkpoint: { collected: 50, oldestCreatedAt: 1_789_000_000_000 },
  });
  const params = new URL(calls[0]!.url).searchParams;
  assert.equal(params.get("since"), "1790000000000");
  assert.equal(params.get("until"), "1788999999999");
  assert.equal(params.get("max"), "150");
});

test("fetchProfile reads ratings, and a missing or closed account is null", async () => {
  const { fetch } = recordingFetch((url) => {
    if (url.endsWith("/user/alice")) return jsonResponse({ username: "Alice", perfs: { blitz: { rating: 1700 } }, profile: { flag: "PK" } });
    if (url.endsWith("/user/closed")) return jsonResponse({ username: "closed", disabled: true });
    return statusResponse(404);
  });
  const signal = new AbortController().signal;
  assert.deepEqual(await importer(fetch).fetchProfile("Alice", signal), {
    username: "Alice",
    ratings: { blitz: 1700, rapid: undefined, bullet: undefined },
    country: "PK",
  });
  assert.equal(await importer(fetch).fetchProfile("closed", signal), null);
  assert.equal(await importer(fetch).fetchProfile("nobody", signal), null);
});
