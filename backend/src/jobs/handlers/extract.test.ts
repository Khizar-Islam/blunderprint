import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { clearDb, startTestDb } from "../../../scripts/testDb.js";
import { FEATURES_VERSION } from "../../chess/features.js";
import { Game, type AnalysisStatus, type Classification } from "../../db/models/game.js";
import type { JobDoc } from "../../db/models/job.js";
import { Player } from "../../db/models/player.js";
import { SUMMARY_VERSION, type Summary } from "../../stats/summary.js";
import type { Progress } from "../queue.js";
import { createExtractHandler, extractJobKey, makeYielder } from "./extract.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

// Scholar's mate, alice is Black: 3...Nf6?? is her one blunder.
const PGN = "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0";
const EVALS = [{ cp: 30 }, { cp: 25 }, { cp: 10 }, { cp: 20 }, { cp: 15 }, { mate: 1 }, { mate: 0 }];
const CLASSES: Classification[] = ["good", "good", "good", "good", "good", "blunder", "good"];

let made = 0;
async function makeGame(playerId: Types.ObjectId, status: AnalysisStatus, extra: Record<string, unknown> = {}) {
  const g = await Game.create({
    playerId,
    platform: "lichess",
    sourceId: `g${made++}`,
    playedAt: new Date("2026-10-20T00:00:00Z"),
    color: "black",
    result: "loss",
    speed: "blitz",
    pgn: PGN,
    plies: 7,
    analysis: status === "pending" ? { status } : { status, evals: EVALS, classifications: CLASSES },
    ...extra,
  });
  return g._id;
}

const player = () => Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });

const fakeJob = (playerId: Types.ObjectId) =>
  ({ _id: "job1", key: extractJobKey(playerId), payload: { playerId: String(playerId) } }) as unknown as JobDoc;

async function run(
  playerId: Types.ObjectId,
  {
    batchSize = 20,
    onProgress = async (_p: Progress) => {},
    signal = new AbortController().signal,
    makeYield,
  }: {
    batchSize?: number;
    onProgress?: (p: Progress) => Promise<void>;
    signal?: AbortSignal;
    makeYield?: (signal: AbortSignal) => () => Promise<void>;
  } = {},
) {
  const progress: Progress[] = [];
  await createExtractHandler({ batchSize, makeYield }).run({
    job: fakeJob(playerId),
    signal,
    reportProgress: async (p) => {
      progress.push(p);
      await onProgress(p);
    },
  });
  return progress;
}

test("extracts analysed games (ours and Lichess-imported), leaves the others alone", async () => {
  const p = await player();
  const done = await makeGame(p._id, "done");
  const imported = await makeGame(p._id, "imported");
  const pending = await makeGame(p._id, "pending");
  const unanalysable = await makeGame(p._id, "unanalysable", { "analysis.error": { code: "illegal_pgn" } });

  const progress = await run(p._id);
  for (const id of [done, imported]) {
    const g = await Game.findById(id).lean();
    assert.equal(g!.features?.version, FEATURES_VERSION);
    assert.deepEqual(
      g!.features?.mistakes?.map((m) => [m.ply, m.kind, m.san, m.square, m.phase]),
      [[6, "blunder", "Nf6", "f6", "opening"]],
    );
    assert.deepEqual(g!.features?.moveCounts, { opening: 3, middlegame: 0, endgame: 0 });
  }
  for (const id of [pending, unanalysable]) assert.equal((await Game.findById(id).lean())!.features, undefined);
  assert.deepEqual(progress.at(-1), { done: 2, total: 2, message: "Extracted 2 games" });
});

test("rebuilds the player's cached summary at the end of the run", async () => {
  const p = await player();
  await makeGame(p._id, "done");
  await makeGame(p._id, "imported");
  await makeGame(p._id, "pending");
  await run(p._id);
  const stored = await Player.findById(p._id).lean();
  assert.equal(stored!.summaryVersion, SUMMARY_VERSION);
  const summary = stored!.summary as Summary;
  assert.equal(summary.totals.games, 3);
  assert.equal(summary.totals.analysed, 2);
  assert.equal(summary.totals.mistakes.blunder, 2); // 3...Nf6?? in each analysed game
});

test("running again changes nothing; a FEATURES_VERSION change re-extracts", async () => {
  const p = await player();
  const id = await makeGame(p._id, "done");
  await run(p._id);
  const first = await Game.findById(id).lean();

  const again = await run(p._id);
  assert.deepEqual(again.at(-1), { done: 0, total: 0, message: "Extracted 0 games" });
  assert.equal((await Game.findById(id).lean())!.updatedAt.getTime(), first!.updatedAt.getTime());

  // Pretend the game was extracted by an older version of the rules.
  await Game.updateOne({ _id: id }, { $set: { "features.version": FEATURES_VERSION - 1 } });
  const third = await run(p._id);
  assert.equal(third.at(-1)!.done, 1);
  assert.equal((await Game.findById(id).lean())!.features?.version, FEATURES_VERSION);
});

test("drains: a game analysed while the job runs is picked up before it finishes", async () => {
  const p = await player();
  await makeGame(p._id, "done");
  const late = await makeGame(p._id, "pending");
  let flipped = false;
  await run(p._id, {
    batchSize: 1,
    onProgress: async () => {
      if (flipped) return;
      flipped = true; // a browser result arrives after the first batch
      await Game.updateOne({ _id: late }, { $set: { "analysis.status": "done", "analysis.evals": EVALS, "analysis.classifications": CLASSES } });
    },
  });
  assert.equal((await Game.findById(late).lean())!.features?.version, FEATURES_VERSION);
});

test("a PGN that doesn't replay is stored as an error, once, and the job still finishes", async () => {
  const p = await player();
  const bad = await makeGame(p._id, "done", { pgn: "1. e4 e5 2. Ke3 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0" });
  const good = await makeGame(p._id, "done");
  const progress = await run(p._id, { batchSize: 1 });
  assert.deepEqual((await Game.findById(bad).lean())!.features, { version: FEATURES_VERSION, error: "replay_failed" });
  assert.equal((await Game.findById(good).lean())!.features?.mistakes?.length, 1);
  assert.equal(progress.at(-1)!.done, 2);
  // Not tried again: an error of the current version counts as extracted.
  assert.equal((await run(p._id)).at(-1)!.done, 0);
});

test("only this player's games", async () => {
  const alice = await player();
  const bob = await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" });
  const bobs = await makeGame(bob._id, "done");
  await run(alice._id);
  assert.equal((await Game.findById(bobs).lean())!.features, undefined);
});

test("an aborted job (lease lost, shutdown) stops instead of finishing", async () => {
  const p = await player();
  await makeGame(p._id, "done");
  const controller = new AbortController();
  controller.abort(new Error("shutting down"));
  await assert.rejects(run(p._id, { signal: controller.signal }), /shutting down/);
});

test("an abort in the middle of a replay stores nothing as failed, and a rerun extracts everything", async () => {
  const p = await player();
  const ids = await Promise.all([1, 2, 3, 4].map(() => makeGame(p._id, "done"))); // 7 plies each
  const controller = new AbortController();
  // The real yielder, set to yield on every ply, with the job aborted (shutdown, lost lease)
  // on the 10th ply overall: the 3rd ply of the second game, in the middle of its replay.
  let plies = 0;
  const abortMidReplay = (signal: AbortSignal) => {
    const inner = makeYielder(signal, 0);
    return async () => {
      if (++plies === 10) controller.abort(new Error("shutting down"));
      await inner();
    };
  };
  await assert.rejects(run(p._id, { signal: controller.signal, makeYield: abortMidReplay }), /shutting down/);

  const after = await Game.find({ _id: { $in: ids } }).lean();
  assert.equal(after.filter((g) => g.features?.error).length, 0, "no game stored as replay_failed");
  // The first game finished before the abort; the one being replayed and the rest were left alone.
  assert.equal(after.filter((g) => g.features).length, 1);

  const progress = await run(p._id); // a fresh run, as after a restart
  assert.equal(progress.at(-1)!.done, 3);
  for (const g of await Game.find({ _id: { $in: ids } }).lean()) {
    assert.equal(g.features?.version, FEATURES_VERSION);
    assert.equal(g.features?.error, undefined);
    assert.equal(g.features?.mistakes?.length, 1);
  }
});

test("makeYielder gives the event loop a turn only after everyMs, and throws once aborted", async () => {
  let t = 0;
  const controller = new AbortController();
  const maybeYield = makeYielder(controller.signal, 50, () => t);
  // Other work waiting in the event loop (an /api/health request, say): does it get to run?
  const otherWorkRan = async () => {
    let ran = false;
    setImmediate(() => (ran = true));
    await maybeYield();
    return ran;
  };
  t = 49;
  assert.equal(await otherWorkRan(), false, "49 ms: keeps going without a turn");
  t = 50;
  assert.equal(await otherWorkRan(), true, "50 ms: gives the event loop a turn");
  t = 60;
  assert.equal(await otherWorkRan(), false, "the 50 ms count restarts after a turn");
  t = 110;
  controller.abort(new Error("lease lost"));
  await assert.rejects(maybeYield(), /lease lost/);
});
