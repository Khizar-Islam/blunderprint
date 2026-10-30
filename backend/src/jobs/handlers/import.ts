import type { Types } from "mongoose";
import { Game } from "../../db/models/game.js";
import type { JobDoc } from "../../db/models/job.js";
import { Player, type Platform } from "../../db/models/player.js";
import type { Importer, NormalizedGame } from "../../importers/normalize.js";
import { logger } from "../../lib/logger.js";
import { FatalError } from "../errors.js";
import type { JobHandler } from "../worker.js";

export interface ImportPayload {
  platform: Platform;
  username: string;
}

const PLATFORM_NAMES: Record<Platform, string> = { chesscom: "Chess.com", lichess: "Lichess" };

export const importJobKey = (platform: Platform, username: string) => `import:${platform}:${username.toLowerCase()}`;

// Upserts by { playerId, sourceId }, so importing the same games twice changes nothing.
// analysis is only written on insert: a re-import must never wipe evals our engine produced.
export async function upsertGames(playerId: Types.ObjectId, platform: Platform, games: NormalizedGame[]): Promise<void> {
  if (games.length === 0) return;
  await Game.bulkWrite(
    games.map(({ evals, ...game }) => ({
      updateOne: {
        filter: { playerId, sourceId: game.sourceId },
        update: {
          $set: { ...game, playerId, platform },
          $setOnInsert: {
            analysis: evals ? { status: "imported", evals } : { status: "pending" },
          },
        },
        upsert: true,
      },
    })),
    { ordered: false },
  );
}

// Keep only the newest maxGames for this player (MAX_GAMES_PER_PLAYER), so storage stays bounded.
export async function trimToNewest(playerId: Types.ObjectId, maxGames: number): Promise<number> {
  const extra = await Game.find({ playerId }, { _id: 1 }).sort({ playedAt: -1, _id: -1 }).skip(maxGames).lean();
  if (extra.length === 0) return 0;
  const res = await Game.deleteMany({ _id: { $in: extra.map((g) => g._id) } });
  return res.deletedCount;
}

export function createImportHandler({
  importers,
  maxGames,
}: {
  importers: Record<Platform, Importer>;
  maxGames: number;
}): JobHandler {
  return {
    async run({ job, signal, reportProgress }) {
      const { platform, username } = job.payload as ImportPayload;
      const importer = importers[platform];
      if (!importer) throw new FatalError("bad_payload", "Unknown platform");

      // 1. The player must exist on the platform before we store anything about them.
      const profile = await importer.fetchProfile(username, signal);
      if (!profile) {
        throw new FatalError("user_not_found", `No player called "${username}" on ${PLATFORM_NAMES[platform]}.`);
      }

      const player = await Player.findOneAndUpdate(
        { platform, usernameLower: username.toLowerCase() },
        {
          $set: {
            username: profile.username,
            profile: { ratings: profile.ratings, avatarUrl: profile.avatarUrl, country: profile.country },
            importState: "importing",
          },
          $setOnInsert: { lastViewedAt: new Date() },
        },
        { upsert: true, returnDocument: "after" },
      );
      if (!player) throw new Error("Player upsert returned nothing");

      // 2. Fetch games newest first, storing each chunk before saving the checkpoint that
      //    says it's done. A crash between the two only means one chunk is fetched again.
      const { newestGameAt } = await importer.importGames({
        username: profile.username,
        maxGames,
        signal,
        known: {
          newestGameAt: player.importMeta?.newestGameAt ?? undefined,
          monthEtags: Object.fromEntries(player.importMeta?.monthEtags ?? []),
        },
        checkpoint: job.checkpoint ?? undefined,
        async onBatch({ games, checkpoint, month }) {
          const started = Date.now();
          await upsertGames(player._id, platform, games);
          logger.info("Import batch stored", { jobId: String(job._id), games: games.length, ms: Date.now() - started });
          if (month?.etag) {
            await Player.updateOne({ _id: player._id }, { $set: { [`importMeta.monthEtags.${month.key}`]: month.etag } });
          }
          const collected = (checkpoint as { collected: number }).collected;
          await reportProgress(
            {
              done: collected,
              total: maxGames,
              message: month ? `Fetched ${month.key} (${games.length} games)` : `Fetched ${collected} games`,
            },
            checkpoint,
          );
        },
      });

      // 3. Trim, count and mark the player ready.
      const previousNewest = player.importMeta?.newestGameAt ?? undefined;
      const newest = newestGameAt && (!previousNewest || newestGameAt > previousNewest) ? newestGameAt : previousNewest;
      await trimToNewest(player._id, maxGames);
      const [gamesCount, analysedCount] = await Promise.all([
        Game.countDocuments({ playerId: player._id }),
        Game.countDocuments({ playerId: player._id, "analysis.status": { $in: ["done", "imported"] } }),
      ]);
      await Player.updateOne(
        { _id: player._id },
        {
          $set: {
            importState: "ready",
            lastImportedAt: new Date(),
            gamesCount,
            analysedCount,
            ...(newest ? { "importMeta.newestGameAt": newest } : {}),
          },
        },
      );
      await reportProgress({ done: gamesCount, total: gamesCount, message: `Imported ${gamesCount} games` });
    },

    // Out of attempts or a fatal error: don't leave the player stuck on "importing".
    // (If the user didn't exist, there's no player document and this matches nothing.)
    async onFailed(job: JobDoc) {
      const { platform, username } = job.payload as ImportPayload;
      await Player.updateOne({ platform, usernameLower: username.toLowerCase() }, { $set: { importState: "failed" } });
    },
  };
}
