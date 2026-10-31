import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { COLORS, Game, RESULTS, SPEEDS } from "../db/models/game.js";
import { ACTIVE_JOB_STATUSES, Job } from "../db/models/job.js";
import { PLATFORMS, Player, type Platform } from "../db/models/player.js";
import { toPublicJob } from "../jobs/events.js";
import { importJobKey } from "../jobs/handlers/import.js";
import type { Queue } from "../jobs/queue.js";
import { afterCursor, decodeCursor, encodeCursor } from "../lib/cursor.js";
import { parseOr400 } from "../lib/validate.js";
import { HttpError } from "../middleware/errorHandler.js";

// A cheap sanity check only; whether the player exists is checked by the import job.
// Lichess: lila's UserName.historicalRegex "[a-zA-Z0-9_-]{2,30}" (modules/core/src/main/userId.scala),
// which every existing account matches (new sign-ups have stricter rules).
// Chess.com: support pages say 3+ characters, letters, digits, "_" and "-". They disagree on the
// maximum (an older article says 20), so we stay loose at 25 rather than reject a real account.
const USERNAME_RULES: Record<Platform, RegExp> = {
  chesscom: /^[A-Za-z0-9_-]{3,25}$/,
  lichess: /^[A-Za-z0-9_-]{2,30}$/,
};

const playerParams = z
  .object({ platform: z.enum(PLATFORMS), username: z.string() })
  .refine(({ platform, username }) => USERNAME_RULES[platform].test(username));

// A player imported less than this long ago is served as-is: Chess.com's data only refreshes
// every 12–24 h anyway, and it saves both sites (and our job queue) needless work.
const FRESH_IMPORT_MS = 6 * 60 * 60_000;
// lastViewedAt only needs hour precision for LRU eviction; writing it on every dashboard load
// would turn every read into a write.
const VIEW_TOUCH_MS = 60 * 60_000;

const gamesQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  speed: z.enum(SPEEDS).optional(),
  color: z.enum(COLORS).optional(),
  result: z.enum(RESULTS).optional(),
});

// The list view doesn't need the heavy fields: PGN, clocks and evals come with GET /api/games/:id.
export const LIST_PROJECTION = {
  pgn: 0,
  clocks: 0,
  playerId: 0,
  __v: 0,
  "analysis.evals": 0,
  "analysis.claimedBy": 0,
  "analysis.claimExpiresAt": 0,
};

export function playersRouter({ queue }: { queue: Pick<Queue, "enqueue"> }): Router {
  const router = Router();
  const params = (raw: unknown) => parseOr400(playerParams, raw, "Invalid platform or username");
  // Uses the partial unique index on key: this filter matches its partialFilterExpression.
  const findActiveImport = (platform: Platform, username: string) =>
    Job.findOne({ key: importJobKey(platform, username), status: { $in: [...ACTIVE_JOB_STATUSES] } });

  // Start (or rejoin) an import. Idempotent: while one is queued or running for this player,
  // the same job comes back, so double-clicks and page reloads never start a second one.
  // A player whose last successful import is under 6 h old gets 200 { upToDate: true } instead.
  router.post("/players/:platform/:username/import", async (req, res) => {
    const { platform, username } = params(req.params);
    const [player, activeJob] = await Promise.all([
      // lastImportedAt is only set when an import finishes successfully.
      Player.findOne({ platform, usernameLower: username.toLowerCase() }, { lastImportedAt: 1 }).lean(),
      findActiveImport(platform, username),
    ]);
    const importedAt = player?.lastImportedAt?.getTime();
    if (!activeJob && importedAt !== undefined && Date.now() - importedAt < FRESH_IMPORT_MS) {
      res.status(200).json({ upToDate: true });
      return;
    }

    const { job, created } = await queue.enqueue({
      type: "import",
      key: importJobKey(platform, username),
      payload: { platform, username },
    });
    res.status(202).json({ jobId: String(job._id), created, status: job.status });
  });

  // The dashboard's first call. player is null while the first import is still queued (the job
  // creates the player once the platform confirms they exist); activeJob lets a reloaded page
  // reattach to the import's SSE stream.
  router.get("/players/:platform/:username", async (req, res) => {
    const { platform, username } = params(req.params);
    const [player, activeJob] = await Promise.all([
      Player.findOne({ platform, usernameLower: username.toLowerCase() }, { importMeta: 0, __v: 0 }).lean(),
      findActiveImport(platform, username),
    ]);
    if (!player && !activeJob) throw new HttpError(404, "Player not found");

    // Viewing a player marks it recently used, so the storage guard (Stage 4) evicts it last.
    // At most once an hour: the filter re-checks the age, so simultaneous loads write once.
    // timestamps: false, because a view isn't a change to the player's data (updatedAt stays).
    const touchBefore = new Date(Date.now() - VIEW_TOUCH_MS);
    if (player && (!player.lastViewedAt || player.lastViewedAt < touchBefore)) {
      await Player.updateOne(
        { _id: player._id, $or: [{ lastViewedAt: null }, { lastViewedAt: { $lt: touchBefore } }] },
        { $set: { lastViewedAt: new Date() } },
        { timestamps: false },
      );
    }

    const { _id, lastViewedAt: _viewed, ...rest } = player ?? {};
    res.json({
      player: player ? { id: String(_id), ...rest } : null,
      activeJob: activeJob ? toPublicJob(activeJob) : null,
    });
  });

  // Newest first, cursor-paginated. Served by the { playerId, playedAt: -1, _id: -1 } index.
  router.get("/players/:platform/:username/games", async (req, res) => {
    const { platform, username } = params(req.params);
    const { cursor, limit, speed, color, result } = parseOr400(gamesQuery, req.query, "Invalid query");

    const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1 }).lean();
    if (!player) throw new HttpError(404, "Player not found");

    const filter = {
      playerId: player._id,
      ...(speed ? { speed } : {}),
      ...(color ? { color } : {}),
      ...(result ? { result } : {}),
      ...(cursor ? afterCursor(decodeCursor(cursor)) : {}),
    };
    // One extra row tells us whether there is a next page without a separate count.
    const rows = await Game.find(filter, LIST_PROJECTION)
      .sort({ playedAt: -1, _id: -1 })
      .limit(limit + 1)
      // With a projection, Mongoose can't infer the row type; these two fields are all we touch.
      .lean<Array<{ _id: Types.ObjectId; playedAt: Date } & Record<string, unknown>>>();
    const page = rows.slice(0, limit);
    const last = page.at(-1);

    res.json({
      games: page.map(({ _id, ...game }) => ({ id: String(_id), ...game })),
      nextCursor: rows.length > limit && last ? encodeCursor({ playedAt: last.playedAt, id: last._id }) : null,
    });
  });

  return router;
}
