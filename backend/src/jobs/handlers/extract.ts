import { Types } from "mongoose";
import { extractFeatures, FEATURES_VERSION, type FeatureInput } from "../../chess/features.js";
import { Game, type AnalysisStatus, type Classification } from "../../db/models/game.js";
import { logger } from "../../lib/logger.js";
import { rebuildCachedSummary } from "../../stats/summary.js";
import { FatalError } from "../errors.js";
import type { Queue } from "../queue.js";
import type { JobHandler } from "../worker.js";

// The extract job (CLAUDE.md 8.3): turns a player's analysed games into features.
//
// One job per player, keyed "extract:<playerId>". The queue's unique key allows only one
// queued-or-running job per key, so every "there may be new work" signal (a stored engine
// result, an import that brought Lichess-analysed games, the summary route's backstop) can
// simply enqueue: if a job is already waiting, it's reused instead of duplicated.
//
// The handler DRAINS: it extracts every analysed game whose features are missing or from an
// older FEATURES_VERSION, then looks again, until none are left. A result stored while the
// job runs is picked up by that next look.
//
// Why a job and not inline in POST /analysis/results: replaying a game with chess.js costs
// ~15 ms on my laptop and an estimated ~250 ms on Render's CPU (CLAUDE.md 17), and one
// Lichess import can bring 200 already-analysed games at once. A job spreads that out and
// yields to the event loop, so /api/health and SSE stay responsive.

export interface ExtractPayload {
  playerId: string;
}

export const extractJobKey = (playerId: Types.ObjectId | string) => `extract:${String(playerId)}`;

export function enqueueExtract(queue: Pick<Queue, "enqueue">, playerId: Types.ObjectId | string) {
  return queue.enqueue({ type: "extract", key: extractJobKey(playerId), payload: { playerId: String(playerId) } });
}

// "Analysed, but no features of the current version yet." Served by the
// { playerId, analysis.status } index; the version check filters at most 200 games per player.
export const needsExtraction = (playerId: Types.ObjectId | string) => ({
  playerId: new Types.ObjectId(String(playerId)),
  "analysis.status": { $in: ["done", "imported"] as AnalysisStatus[] },
  "features.version": { $ne: FEATURES_VERSION },
});

export const PROJECTION = {
  pgn: 1,
  plies: 1,
  color: 1,
  timeControl: 1,
  clocks: 1,
  "analysis.status": 1,
  "analysis.evals": 1,
  "analysis.classifications": 1,
  "analysis.best": 1,
} as const;

// A game as PROJECTION loads it.
export interface ExtractableGame {
  _id: Types.ObjectId;
  pgn: string;
  plies: number;
  color: FeatureInput["color"];
  timeControl?: string | null;
  clocks?: number[] | null;
  analysis?: {
    status?: AnalysisStatus | null;
    evals?: FeatureInput["evals"] | null;
    classifications?: Classification[] | null;
    best?: (string | null)[] | null;
  } | null;
}

// What the job and the backfill script both feed to extractFeatures.
export function featureInputOf(game: Omit<ExtractableGame, "_id">): FeatureInput {
  return {
    pgn: game.pgn,
    plies: game.plies,
    color: game.color,
    timeControl: game.timeControl,
    clocks: game.clocks,
    evals: game.analysis?.evals ?? [],
    classifications: game.analysis?.classifications ?? [],
    best: game.analysis?.best,
  };
}

// Gives the event loop a turn once `everyMs` have passed since the last one, and stops the
// work promptly when the job is aborted (lease lost, shutdown).
export function makeYielder(signal: AbortSignal, everyMs = 50, now = () => performance.now()) {
  let last = now();
  return async () => {
    if (now() - last < everyMs) return;
    await new Promise((resolve) => setImmediate(resolve));
    if (signal.aborted) throw signal.reason;
    last = now();
  };
}

export function createExtractHandler({
  batchSize = 20,
  // Tests wrap the yielder to abort the job in the middle of a replay.
  makeYield = makeYielder,
}: { batchSize?: number; makeYield?: (signal: AbortSignal) => () => Promise<void> } = {}): JobHandler {
  return {
    async run({ job, signal, reportProgress }) {
      const { playerId } = job.payload as ExtractPayload;
      if (!playerId) throw new FatalError("bad_payload", "Missing playerId");
      const maybeYield = makeYield(signal);
      // Games tried in this run, so one that can't be saved is never picked up again in a loop.
      const tried: Types.ObjectId[] = [];
      let extracted = 0;
      let failed = 0;

      for (;;) {
        if (signal.aborted) throw signal.reason;
        const games = await Game.find({ ...needsExtraction(playerId), _id: { $nin: tried } }, PROJECTION)
          .limit(batchSize)
          .lean<ExtractableGame[]>();
        if (games.length === 0) break;

        const started = performance.now();
        let mistakes = 0;
        for (const game of games) {
          tried.push(game._id);
          const features = await extractFeatures(featureInputOf(game), { maybeYield });
          // Belt and braces: nothing is written once the job is aborted, whatever
          // extractFeatures returned. The next run extracts this game again.
          if (signal.aborted) throw signal.reason;
          if ("error" in features) failed++;
          else mistakes += features.mistakes.length;
          // Conditional: only while the game is still analysed and still lacks this version.
          await Game.updateOne(
            { _id: game._id, "analysis.status": game.analysis?.status, "features.version": { $ne: FEATURES_VERSION } },
            { $set: { features } },
          );
          extracted++;
        }
        // The Render measurement CLAUDE.md asks for: CPU-heavy work must be timed there.
        // Wall time per game, including the DB write and any time given to other work.
        logger.info("Extract batch", {
          jobId: String(job._id),
          games: games.length,
          mistakes,
          wallMsPerGame: Math.round((performance.now() - started) / games.length),
        });
        await reportProgress({ done: extracted, message: `Extracted ${extracted} games` });
      }

      if (failed > 0) logger.warn("Games whose PGN didn't replay for features", { jobId: String(job._id), playerId, failed });
      // The dashboard's cached (unfiltered) summary now includes these games. Rebuilt even when
      // nothing was extracted: a run with nothing to do is cheap, and it also repairs a
      // summary from an older SUMMARY_VERSION.
      if (signal.aborted) throw signal.reason;
      await rebuildCachedSummary(playerId);
      await reportProgress({ done: extracted, total: extracted, message: `Extracted ${extracted} games` });
    },
  };
}
