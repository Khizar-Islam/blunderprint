import { Router, type Response } from "express";
import type { Types } from "mongoose";
import { analysedBasis } from "../agent/basis.js";
import type { CoachRuntime } from "../agent/coach.js";
import { friendly, type FriendlyCode, type FriendlyVars } from "../agent/friendly.js";
import { PROMPT_VERSION } from "../agent/prompts.js";
import { toPublicReport } from "../agent/reportStore.js";
import { AgentRun } from "../db/models/agentRun.js";
import { ACTIVE_JOB_STATUSES, Job } from "../db/models/job.js";
import { Player, type Platform } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { reportJobKey, startReportRun, type ReportPayload } from "../jobs/handlers/report.js";
import type { Queue } from "../jobs/queue.js";
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
//      7. otherwise                             202 { runId }
// Every error body is { error, code }: a fixed friendly message and a code (agent/friendly.ts).

export interface CoachRouterOptions {
  queue: Pick<Queue, "enqueue">;
  coach: CoachRuntime;
}

function sendFriendly(res: Response, status: number, code: FriendlyCode, vars?: FriendlyVars): void {
  const f = friendly(code, vars);
  res.status(status).json({ error: f.message, code: f.code });
}

export function coachRouter({ queue, coach }: CoachRouterOptions): Router {
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
    const stale =
      !!latest && (latest.analysedGamesHash !== basis.hash || latest.promptVersion !== PROMPT_VERSION || latest.model !== coach.modelName);

    res.json({
      report: latest ? toPublicReport(latest) : null,
      stale,
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
      res.status(200).json({ report: toPublicReport(cached), cached: true });
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
      res.setHeader("Retry-After", String(Math.ceil(resetsInMs / 1000)));
      return sendFriendly(res, 429, "ai_budget_exhausted", { resetsInMs });
    }

    const { runId } = await startReportRun(queue, player._id, coach.modelName);
    res.status(202).json({ runId });
  });

  return router;
}
