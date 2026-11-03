import { Router } from "express";
import { z } from "zod";
import { COLORS, Game, SPEEDS } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { Job } from "../db/models/job.js";
import { enqueueExtract, extractJobKey, needsExtraction } from "../jobs/handlers/extract.js";
import type { Queue } from "../jobs/queue.js";
import { logger } from "../lib/logger.js";
import { parseOr400 } from "../lib/validate.js";
import { HttpError } from "../middleware/errorHandler.js";
import { computeSummary, rebuildCachedSummary, SUMMARY_VERSION, type Summary, type SummaryFilters } from "../stats/summary.js";
import { parsePlayerParams } from "./players.js";

// GET /api/players/:platform/:username/summary?color=&speed=&from=&to=
// The patterns dashboard: every breakdown of stats/summary.ts in one response.
//
// - No filters: the cached players.summary when its version is current; otherwise computed,
//   stored, and returned.
// - Any filter: computed live (at most 200 games, see stats/summary.ts).
// The response shape is the same either way; `cached` says which it was.

// A date ("2026-10-31", midnight UTC) or a full ISO timestamp with a zone.
const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).transform((v) => new Date(v));

const summaryQuery = z
  .strictObject({
    color: z.enum(COLORS).optional(),
    speed: z.enum(SPEEDS).optional(),
    from: isoDate.optional(), // inclusive
    to: isoDate.optional(), // exclusive
  })
  .refine(({ from, to }) => !from || !to || from < to, { message: "from must be before to" });

export function summaryRouter({ queue }: { queue: Pick<Queue, "enqueue"> }): Router {
  const router = Router();

  router.get("/players/:platform/:username/summary", async (req, res) => {
    const { platform, username } = parsePlayerParams(req.params);
    const filters: SummaryFilters = parseOr400(summaryQuery, req.query, "Invalid filters");

    const player = await Player.findOne(
      { platform, usernameLower: username.toLowerCase() },
      { _id: 1, summary: 1, summaryVersion: 1 },
    ).lean();
    if (!player) throw new HttpError(404, "Player not found");

    // Backstop: a GET that can start a job, on purpose. Feature extraction is normally started
    // by a stored engine result or an import, but one can be missed (a result stored just as a
    // running extract job finished, or an enqueue that failed). The dashboard is where missing
    // features would show, so viewing it is the natural moment to catch up. It's safe to repeat:
    // the queue's unique key allows one queued-or-running extract job per player, so a hundred
    // page loads still mean one job, and the check itself is an index lookup.
    const missing = (await Game.exists(needsExtraction(player._id))) !== null;
    if (missing) {
      try {
        await enqueueExtract(queue, player._id);
      } catch (err) {
        // The summary is still worth returning; the next view tries again.
        logger.warn("Summary backstop could not enqueue extraction", { playerId: String(player._id), error: String(err) });
      }
    }

    // extracting: the numbers will still change, so the dashboard should ask again shortly.
    // True while games lack features, AND while the player's extract job is still queued or
    // running: the job writes each game's features first and rebuilds the cached summary only at
    // the end of its run, so in between nothing is "missing" but the cached summary is still the
    // old one. The lookup is the unique { key } index (active jobs only).
    const extracting =
      missing ||
      (await Job.exists({ key: extractJobKey(player._id), status: { $in: ["queued", "running"] } })) !== null;

    const unfiltered = Object.keys(filters).every((k) => filters[k as keyof SummaryFilters] === undefined);
    let summary: Summary;
    let cached = false;
    if (unfiltered && player.summaryVersion === SUMMARY_VERSION && player.summary) {
      summary = player.summary as Summary;
      cached = true;
    } else if (unfiltered) {
      // First view since this version (or since the player was imported): build and keep it.
      summary = await rebuildCachedSummary(player._id);
    } else {
      summary = await computeSummary(player._id, filters);
    }

    res.json({ summary, cached, extracting });
  });

  return router;
}
