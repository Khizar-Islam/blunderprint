import { Router } from "express";
import type { Types } from "mongoose";
import { analysedBasis } from "../agent/basis.js";
import type { CoachRuntime } from "../agent/coach.js";
import { sendFriendly } from "../agent/friendly.js";
import { PROMPT_VERSION } from "../agent/prompts.js";
import { publicReportOf } from "../agent/reportStore.js";
import { AgentRun } from "../db/models/agentRun.js";
import { ACTIVE_JOB_STATUSES, Job } from "../db/models/job.js";
import { Player, type Platform } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { reportJobKey, startReportRun, type ReportPayload } from "../jobs/handlers/report.js";
import type { Queue } from "../jobs/queue.js";
import { logRefusal, reportRules, visitorOf, type Guards } from "../lib/guards.js";
import { refund, take } from "../lib/quota.js";
import { parsePlayerParams } from "./players.js";

// The coach report (CLAUDE.md §10, §11).
//
// GET  /api/players/:platform/:username/report → the latest report at once (or null), whether
//      it's stale, whether the player has enough analysed games, the active run, the AI state.
// POST /api/players/:platform/:username/report → start one, checked in this order:
//      1. no such player                       404 player_not_found
//      2. a run is already going                202 { runId } (the same run: asking twice is safe)
//      3. a report for exactly this data         200 { report, cached: true } (no AI call)
//      4. under COACH_MIN_ANALYSED_GAMES        409 not_enough_games
//      5. AI switched off / no model            503 ai_disabled
//      6. budget under one worst-case run       429 ai_budget_exhausted (+ Retry-After)
//      7. this visitor's reports today used up  429 limit_reports (+ Retry-After), Stage 6
//      8. otherwise                             202 { runId }
// Only step 8 counts against the visitor's limit: a rejoined run or a cached report is free.
// Every error body is { error, code }: a fixed friendly message and a code (agent/friendly.ts).

export interface CoachRouterOptions {
  queue: Pick<Queue, "enqueue">;
  coach: CoachRuntime;
  // Stage 6 limits (lib/guards.ts). Left out = no per-visitor limit (route tests).
  guards?: Guards;
}

export function coachRouter({ queue, coach, guards }: CoachRouterOptions): Router {
  const router = Router();

  const findPlayer = (platform: Platform, username: string) =>
    Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1 }).lean();

  // The player's queued-or-running report job (the partial unique index on jobs.key) → its run.
  async function activeRun(playerId: Types.ObjectId): Promise<{ runId: string; status: string } | null> {
    const job = await Job.findOne(
      { key: reportJobKey(coach.modelName, playerId), status: { $in: [...ACTIVE_JOB_STATUSES] } },
      { payload: 1 },
    ).lean();
    const runId = (job?.payload as ReportPayload | undefined)?.runId;
    if (!runId) return null;
    const run = await AgentRun.findById(runId, { status: 1 }).lean();
    return { runId, status: run?.status ?? "queued" };
  }

  const cacheKey = (playerId: Types.ObjectId, hash: string) => ({
    playerId,
    analysedGamesHash: hash,
    promptVersion: PROMPT_VERSION,
    model: coach.modelName,
  });

  router.get("/players/:platform/:username/report", async (req, res) => {
    const { platform, username } = parsePlayerParams(req.params);
    const player = await findPlayer(platform, username);
    if (!player) return sendFriendly(res, 404, "player_not_found");

    const [basis, latest, active, budgetLeft] = await Promise.all([
      analysedBasis(player._id),
      // Uses { playerId, model, createdAt: -1 }. Per model: a local scripted report never shows
      // on the live site, and the other way round.
      Report.findOne({ playerId: player._id, model: coach.modelName }).sort({ createdAt: -1 }),
      activeRun(player._id),
      coach.available ? coach.budget.remaining() : Promise.resolve(0),
    ]);
    // Why it's stale, so the page can say it truthfully: a newer prompt or model ("an updated
    // coach is available"), or the analysed games changed ("7 new games since").
    const newVersion = !!latest && (latest.promptVersion !== PROMPT_VERSION || latest.model !== coach.modelName);
    const newData = !!latest && latest.analysedGamesHash !== basis.hash;
    const stale = newVersion || newData;

    res.json({
      report: latest ? await publicReportOf(latest) : null,
      stale,
      staleReason: newVersion ? "new_version" : newData ? "new_games" : null,
      // Analysed games added since the report (0 when games only changed, e.g. old ones trimmed).
      newGames: latest && newData ? Math.max(0, basis.analysed - latest.analysedGames) : 0,
      eligibility: { analysed: basis.analysed, needed: coach.minAnalysed, ok: basis.analysed >= coach.minAnalysed },
      activeRun: active,
      ai: { enabled: coach.available, budgetLeft, canStart: coach.available && budgetLeft >= coach.worstCaseCalls },
    });
  });

  router.post("/players/:platform/:username/report", async (req, res) => {
    const { platform, username } = parsePlayerParams(req.params);
    const player = await findPlayer(platform, username);
    if (!player) return sendFriendly(res, 404, "player_not_found");

    const active = await activeRun(player._id);
    if (active) {
      res.status(202).json({ runId: active.runId });
      return;
    }

    const basis = await analysedBasis(player._id);
    const cached = await Report.findOne(cacheKey(player._id, basis.hash));
    if (cached) {
      res.status(200).json({ report: await publicReportOf(cached), cached: true });
      return;
    }

    if (basis.analysed < coach.minAnalysed) {
      return sendFriendly(res, 409, "not_enough_games", { analysed: basis.analysed, needed: coach.minAnalysed });
    }
    if (!coach.available) return sendFriendly(res, 503, "ai_disabled");
    // Don't start a run that couldn't finish: the budget must cover one worst-case run. Each
    // model request still checks the budget for itself (agent/budget.ts).
    if ((await coach.budget.remaining()) < coach.worstCaseCalls) {
      const resetsInMs = coach.budget.resetsInMs();
      return sendFriendly(res, 429, "ai_budget_exhausted", { resetsInMs, retryAfterMs: resetsInMs });
    }

    // The visitor's own daily limit, taken last: only a run that really starts counts.
    const mine = guards ? await take(reportRules(visitorOf(res), guards.limits), guards.now?.() ?? new Date()) : null;
    if (mine && !mine.ok) {
      logRefusal(res, "reports");
      return sendFriendly(res, 429, "limit_reports", { retryAfterMs: mine.retryAfterMs });
    }
    let started: Awaited<ReturnType<typeof startReportRun>>;
    try {
      started = await startReportRun(queue, player._id, coach.modelName);
    } catch (err) {
      if (mine?.ok) await refund(mine.taken).catch(() => {});
      throw err;
    }
    // Another request started this player's report a moment ago: we rejoined it, so it's free.
    if (!started.created && mine?.ok) await refund(mine.taken);
    res.status(202).json({ runId: started.runId });
  });

  return router;
}
