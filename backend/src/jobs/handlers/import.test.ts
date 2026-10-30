import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Game } from "../../db/models/game.js";
import type { JobDoc } from "../../db/models/job.js";
import { Player } from "../../db/models/player.js";
import { clearDb, startTestDb } from "../../../scripts/testDb.js";
import { chessComGame, lichessGame, LICHESS_ANALYSIS } from "../../../scripts/fixtures.js";
import { normalizeChessComGame } from "../../importers/chesscom.js";
import { normalizeLichessGame } from "../../importers/lichess.js";
import type { ImportGamesInput, Importer, NormalizedGame } from "../../importers/normalize.js";
import { FatalError } from "../errors.js";
import type { Progress } from "../queue.js";
import { createImportHandler, importJobKey } from "./import.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

// n Chess.com games for "alice", one day apart, newest first.
function games(n: number, username = "Alice"): NormalizedGame[] {
  return Array.from({ length: n }, (_, i) =>
    normalizeChessComGame(
      chessComGame({
        url: `https://www.chess.com/game/live/${500 + i}`,
        endTime: new Date(Date.parse("2026-10-20T10:00:00Z") - i * 86_400_000),
        white: { username, rating: 1500, result: "win" },
      }),
      username.toLowerCase(),
    )!,
  );
}

// An importer that hands over fixed games in one batch, and remembers what it was asked.
function fakeImporter(list: NormalizedGame[], options: { exists?: boolean; month?: { key: string; etag: string } } = {}) {
  const inputs: ImportGamesInput[] = [];
  const importer: Importer = {
    async fetchProfile(username) {
      return options.exists === false ? null : { username, ratings: { blitz: 1500 }, country: "PK" };
    },
    async importGames(input) {
      inputs.push(input);
      await input.onBatch({ games: list, checkpoint: { collected: list.length }, month: options.month });
      return { newestGameAt: list[0]?.playedAt };
    },
  };
  return { importer, inputs };
}

function fakeJob(platform: "chesscom" | "lichess", username: string, checkpoint?: unknown): JobDoc {
  return { key: importJobKey(platform, username), payload: { platform, username }, checkpoint } as unknown as JobDoc;
}

async function run(importer: Importer, job: JobDoc, maxGames = 200) {
  const progress: Progress[] = [];
  const handler = createImportHandler({ importers: { chesscom: importer, lichess: importer }, maxGames });
  await handler.run({ job, signal: new AbortController().signal, reportProgress: async (p) => void progress.push(p) });
  return progress;
}

test("a player that doesn't exist fails fatally and stores nothing", async () => {
  const { importer } = fakeImporter([], { exists: false });
  await assert.rejects(run(importer, fakeJob("chesscom", "nobody")), (err: unknown) => {
    assert.ok(err instanceof FatalError);
    assert.equal(err.code, "user_not_found");
    assert.match(err.message, /No player called "nobody" on Chess\.com/);
    return true;
  });
  assert.equal(await Player.countDocuments(), 0);
});

test("imports the games, marks the player ready and reports progress", async () => {
  const { importer } = fakeImporter(games(4), { month: { key: "2026/10", etag: 'W/"x"' } });
  const progress = await run(importer, fakeJob("chesscom", "ALICE"));

  const player = await Player.findOne({ platform: "chesscom", usernameLower: "alice" }).lean();
  assert.equal(player!.importState, "ready");
  assert.equal(player!.gamesCount, 4);
  assert.equal(player!.analysedCount, 0);
  assert.equal(player!.profile?.country, "PK");
  // .lean() returns a Map field as a plain object.
  assert.deepEqual(player!.importMeta?.monthEtags, { "2026/10": 'W/"x"' });
  assert.equal(player!.importMeta?.newestGameAt?.toISOString(), "2026-10-20T10:00:00.000Z");
  assert.ok(player!.lastImportedAt);
  assert.deepEqual(progress.at(-1), { done: 4, total: 4, message: "Imported 4 games" });

  const stored = await Game.find({ playerId: player!._id }).sort({ playedAt: -1 }).lean();
  assert.equal(stored.length, 4);
  assert.equal(stored[0]!.analysis?.status, "pending");
  assert.equal(stored[0]!.color, "white");
});

test("importing the same games twice doesn't duplicate them or wipe finished analysis", async () => {
  const list = games(3);
  await run(fakeImporter(list).importer, fakeJob("chesscom", "alice"));
  // Pretend our engine analysed one game in the meantime.
  await Game.updateOne({ sourceId: list[0]!.sourceId }, { $set: { "analysis.status": "done", "analysis.evals": [{ cp: 12 }] } });

  await run(fakeImporter(list).importer, fakeJob("chesscom", "alice"));
  assert.equal(await Game.countDocuments(), 3);
  const analysed = await Game.findOne({ sourceId: list[0]!.sourceId }).lean();
  assert.equal(analysed!.analysis?.status, "done");
  assert.deepEqual(analysed!.analysis?.evals?.map((e) => e.cp), [12]);
  assert.equal((await Player.findOne().lean())!.analysedCount, 1);
});

test("Lichess games that come with evals are stored as imported", async () => {
  const game = normalizeLichessGame(lichessGame({ analysis: LICHESS_ANALYSIS }), "alice")!;
  await run(fakeImporter([game]).importer, fakeJob("lichess", "alice"));
  const stored = await Game.findOne().lean();
  assert.equal(stored!.platform, "lichess");
  assert.equal(stored!.analysis?.status, "imported");
  assert.equal(stored!.analysis?.evals?.length, 7);
  assert.equal((await Player.findOne().lean())!.analysedCount, 1);
});

test("keeps only the newest maxGames games", async () => {
  await run(fakeImporter(games(5)).importer, fakeJob("chesscom", "alice"), 3);
  const kept = await Game.find().sort({ playedAt: -1 }).lean();
  assert.equal(kept.length, 3);
  assert.equal(kept[0]!.playedAt.toISOString(), "2026-10-20T10:00:00.000Z");
  assert.equal((await Player.findOne().lean())!.gamesCount, 3);
});

test("a game between two imported players is stored once for each of them", async () => {
  const forAlice = games(1, "Alice");
  const forBob = forAlice.map((g) => ({ ...g, color: "black" as const, result: "loss" as const }));
  await run(fakeImporter(forAlice).importer, fakeJob("chesscom", "alice"));
  await run(fakeImporter(forBob).importer, fakeJob("chesscom", "bob"));
  const stored = await Game.find({ sourceId: forAlice[0]!.sourceId }).lean();
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map((g) => g.result).sort(), ["loss", "win"]);
});

test("a resumed job passes its checkpoint and what earlier imports knew to the importer", async () => {
  const { importer, inputs } = fakeImporter(games(2), { month: { key: "2026/10", etag: 'W/"v1"' } });
  await run(importer, fakeJob("chesscom", "alice"));
  await run(importer, fakeJob("chesscom", "alice", { monthsDone: ["2026/10"], collected: 2 }));
  assert.deepEqual(inputs[1]!.checkpoint, { monthsDone: ["2026/10"], collected: 2 });
  assert.deepEqual(inputs[1]!.known.monthEtags, { "2026/10": 'W/"v1"' });
  assert.equal(inputs[1]!.known.newestGameAt?.toISOString(), "2026-10-20T10:00:00.000Z");
});

test("onFailed leaves the player marked failed instead of stuck importing", async () => {
  await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice", importState: "importing" });
  const handler = createImportHandler({ importers: {} as never, maxGames: 200 });
  await handler.onFailed!(fakeJob("lichess", "Alice"));
  assert.equal((await Player.findOne().lean())!.importState, "failed");
});
