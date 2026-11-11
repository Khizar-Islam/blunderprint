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
import { noDemoPlayers, type IsDemo } from "../lib/demo.js";
import { sendFriendly } from "../agent/friendly.js";
import { importRules, logRefusal, newPlayerRules, visitorOf, type Guards } from "../lib/guards.js";
import { refund, take, type Taken } from "../lib/quota.js";
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

// :platform and :username of every /players/:platform/:username route (also routes/summary.ts).
export const parsePlayerParams = (raw: unknown) => parseOr400(playerParams, raw, "Invalid platform or username");

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

// The list view doesn't need the heavy fields: PGN, clocks, evals and best moves come with
// GET /api/games/:id. Rows keep the classifications (their ribbon) and the accuracy.
export const LIST_PROJECTION = {
  pgn: 0,
  clocks: 0,
  playerId: 0,
  __v: 0,
  "analysis.evals": 0,
  "analysis.best": 0,
  "analysis.claimedBy": 0,
  "analysis.claimExpiresAt": 0,
};

// How long a "busy" (full import queue) refusal asks the visitor to wait.
const BUSY_RETRY_MS = 60_000;

// Who asked for the import: "auto" = the dashboard checking a player on load, "user" = a click
// (Try again, Retry). Default "user", so anything that doesn't say is counted.
const importQuery = z.object({ trigger: z.enum(["auto", "user"]).default("user") }).strict();

export function playersRouter({
  queue,
  isDemo = noDemoPlayers,
  guards,
}: {
  queue: Pick<Queue, "enqueue">;
  isDemo?: IsDemo;
  // Stage 6 limits (lib/guards.ts). Left out = no limits (route tests).
  guards?: Guards;
}): Router {
  const router = Router();
  const params = parsePlayerParams;
  // Uses the partial unique index on key: this filter matches its partialFilterExpression.
  const findActiveImport = (platform: Platform, username: string) =>
    Job.findOne({ key: importJobKey(platform, username), status: { $in: [...ACTIVE_JOB_STATUSES] } });

  // Start (or rejoin) an import. Idempotent: while one is queued or running for this player,
  // the same job comes back, so double-clicks and page reloads never start a second one.
  // A player whose last successful import is under 6 h old gets 200 { upToDate: true } instead.
  // A demo player (lib/demo.ts) is frozen once imported: 200 { upToDate: true, frozen: true }
  // however old the import is. Their first import still runs, to seed them.
  router.post("/players/:platform/:username/import", async (req, res) => {
    const { platform, username } = params(req.params);
    const { trigger } = parseOr400(importQuery, req.query, "Invalid query");
    const [player, activeJob] = await Promise.all([
      // lastImportedAt is only set when an import finishes successfully.
      Player.findOne(
        { platform, usernameLower: username.toLowerCase() },
        { lastImportedAt: 1, "importMeta.lastAutoRefreshAt": 1 },
        // With a dotted projection Mongoose can't infer the row type; these are all we read.
      ).lean<{ _id: Types.ObjectId; lastImportedAt?: Date | null; importMeta?: { lastAutoRefreshAt?: Date | null } }>(),
      findActiveImport(platform, username),
    ]);
    const importedAt = player?.lastImportedAt?.getTime();
    const demo = isDemo(platform, username);
    if (!activeJob && importedAt !== undefined && demo) {
      res.status(200).json({ upToDate: true, frozen: true });
      return;
    }
    if (!activeJob && importedAt !== undefined && Date.now() - importedAt < FRESH_IMPORT_MS) {
      res.status(200).json({ upToDate: true });
      return;
    }
    // Rejoining the running import is free: nothing new starts.
    if (activeJob) {
      res.status(202).json({ jobId: String(activeJob._id), created: false, status: activeJob.status });
      return;
    }

    // An automatic refresh of a STORED player (the dashboard found it stale on load) isn't the
    // visitor's doing, so it doesn't count toward their import limit. Instead it's held to one
    // per player per 6 h, claimed atomically here: of two tabs loading at once, one starts it.
    // If the last automatic one failed, the next waits out the 6 h (a click can retry sooner,
    // and that counts). New players always count, whatever the trigger says.
    const autoRefresh = trigger === "auto" && player !== null && !demo;
    const previousAuto = player?.importMeta?.lastAutoRefreshAt ?? null;
    if (autoRefresh) {
      const cutoff = new Date(Date.now() - FRESH_IMPORT_MS);
      const claimed = await Player.updateOne(
        {
          _id: player._id,
          $or: [{ "importMeta.lastAutoRefreshAt": null }, { "importMeta.lastAutoRefreshAt": { $lt: cutoff } }],
        },
        { $set: { "importMeta.lastAutoRefreshAt": new Date() } },
        { timestamps: false },
      );
      if (claimed.modifiedCount === 0) {
        res.status(200).json({ upToDate: true });
        return;
      }
    }
    // Hands the 6-hour slot back when no import came of it (refused, or the enqueue failed).
    const releaseAuto = async () => {
      if (!autoRefresh) return;
      await Player.updateOne(
        { _id: player!._id },
        previousAuto
          ? { $set: { "importMeta.lastAutoRefreshAt": previousAuto } }
          : { $unset: { "importMeta.lastAutoRefreshAt": 1 } },
        { timestamps: false },
      );
    };

    // A new import really starts here, so the Stage 6 guards apply (never to a demo player,
    // whose first import seeds the demo). Cheapest and global first, the visitor's own counters
    // last, so a refusal for a full database doesn't use up the visitor's imports.
    let taken: Taken[] = [];
    if (guards && !demo) {
      const now = guards.now?.() ?? new Date();
      // "New" = nothing stored yet. A stored player's re-import replaces games, it doesn't add a player.
      const newPlayer = !player;
      if (newPlayer && (await guards.storage.full())) {
        logRefusal(res, "storage", { usedMb: await guards.storage.usedMb(), limitMb: guards.storage.limitMb });
        return sendFriendly(res, 503, "storage_full");
      }
      // Served by the { status, runAfter } index (status prefix).
      const queued = await Job.countDocuments({ status: "queued", type: "import" });
      if (queued >= guards.limits.importQueueMax) {
        await releaseAuto();
        logRefusal(res, "queue", { queued });
        return sendFriendly(res, 503, "busy", { retryAfterMs: BUSY_RETRY_MS });
      }
      if (!autoRefresh) {
        const mine = await take(importRules(visitorOf(res), guards.limits), now);
        if (!mine.ok) {
          logRefusal(res, "imports", { window: mine.rule.window });
          return sendFriendly(res, 429, "limit_imports", { retryAfterMs: mine.retryAfterMs });
        }
        taken = [mine.taken];
      }
      if (newPlayer) {
        const global = await take(newPlayerRules(guards.limits), now);
        if (!global.ok) {
          await Promise.all(taken.map(refund));
          logRefusal(res, "new_players");
          return sendFriendly(res, 503, "limit_new_players", { retryAfterMs: global.retryAfterMs });
        }
        taken.push(global.taken);
      }
    }
    const giveBack = () => Promise.all(taken.map(refund));

    let enqueued: Awaited<ReturnType<typeof queue.enqueue>>;
    try {
      enqueued = await queue.enqueue({
        type: "import",
        key: importJobKey(platform, username),
        payload: { platform, username },
      });
    } catch (err) {
      await giveBack().catch(() => {});
      await releaseAuto().catch(() => {});
      throw err;
    }
    const { job, created } = enqueued;
    // Someone else started the same import a moment ago: we rejoined it, so it isn't ours to count.
    if (!created) await giveBack();
    res.status(202).json({ jobId: String(job._id), created, status: job.status });
  });

  // The dashboard's first call. player is null while the first import is still queued (the job
  // creates the player once the platform confirms they exist); activeJob lets a reloaded page
  // reattach to the import's SSE stream.
  router.get("/players/:platform/:username", async (req, res) => {
    const { platform, username } = params(req.params);
    const [player, activeJob] = await Promise.all([
      // Not the cached summary (~30 KB with its ribbons): the dashboard gets it from /summary.
      Player.findOne({ platform, usernameLower: username.toLowerCase() }, { importMeta: 0, summary: 0, __v: 0 }).lean(),
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
      // demo: frozen (lib/demo.ts): the dashboard shows "Demo player · games as of <date>" and
      // runs no analysis.
      player: player ? { id: String(_id), ...rest, demo: isDemo(platform, username) } : null,
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
