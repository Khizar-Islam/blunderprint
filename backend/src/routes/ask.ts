import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { ASK_PROMPT_VERSION, cleanQuestion, HAS_CONTROL_CHARS, MAX_QUESTION_CHARS, questionKey } from "../agent/ask.js";
import { publicAnswerOf } from "../agent/answerStore.js";
import { analysedBasis } from "../agent/basis.js";
import type { CoachRuntime } from "../agent/coach.js";
import { sendFriendly } from "../agent/friendly.js";
import { addRunToken } from "../agent/runTokens.js";
import { Answer } from "../db/models/answer.js";
import { ACTIVE_JOB_STATUSES, Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { askJobKey, startAskRun, type AskPayload } from "../jobs/handlers/ask.js";
import type { Queue } from "../jobs/queue.js";
import { askRules, logRefusal, visitorOf, type Guards } from "../lib/guards.js";
import { refund, take } from "../lib/quota.js";
import { parseOr400 } from "../lib/validate.js";
import { parsePlayerParams } from "./players.js";

// "Ask the coach" (Stage 6 chunk B, CLAUDE.md §10, §11).
//
// POST /api/players/:platform/:username/ask { question } → checked in this order:
//   1. a bad body (not 3-300 characters, control characters, unknown keys)  400
//   2. no such player                                    404 player_not_found
//   3. under COACH_MIN_ANALYSED_GAMES                     409 not_enough_games
//   4. this exact question already answered for this data 200 { answer, cached: true } (no AI call)
//   5. the same question is running right now              202 { runId, token } (joined: free, a
//      token of the visitor's own; 503 busy once the run has MAX_RUN_TOKENS)
//   6. AI switched off / no model                         503 ai_disabled
//   7. budget under one worst-case question (ASK_MAX_REQUESTS) 429 ai_budget_exhausted
//   8. COACH_QUEUE_MAX coach jobs already queued           503 busy (before 9, so a full queue
//      doesn't use up the visitor's questions)
//   9. this visitor's questions used up (hour, day)        429 limit_questions
//  10. otherwise                                          202 { runId, token }
// The token is the only way to stream the run (routes/runs.ts): it isn't stored, only its hash.

const BUSY_RETRY_MS = 60_000;

const askBody = z
  .object({
    question: z
      .string()
      .refine((q) => !HAS_CONTROL_CHARS.test(q), "contains control characters")
      .transform(cleanQuestion)
      .pipe(z.string().min(3).max(MAX_QUESTION_CHARS)),
  })
  .strict();

export interface AskRouterOptions {
  queue: Pick<Queue, "enqueue">;
  coach: CoachRuntime;
  guards?: Guards;
}

export function askRouter({ queue, coach, guards }: AskRouterOptions): Router {
  const router = Router();

  // The run of this question's queued-or-running job (the partial unique index on jobs.key).
  async function activeRunId(playerId: Types.ObjectId, qKey: string): Promise<string | null> {
    const job = await Job.findOne({ key: askJobKey(coach.modelName, playerId, qKey), status: { $in: [...ACTIVE_JOB_STATUSES] } }, { payload: 1 }).lean();
    return (job?.payload as AskPayload | undefined)?.runId ?? null;
  }

  router.post("/players/:platform/:username/ask", async (req, res) => {
    const { platform, username } = parsePlayerParams(req.params);
    const { question } = parseOr400(askBody, req.body, "Invalid question");
    const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1 }).lean();
    if (!player) return sendFriendly(res, 404, "player_not_found");

    const basis = await analysedBasis(player._id);
    if (basis.analysed < coach.minAnalysed) {
      return sendFriendly(res, 409, "not_enough_games", { analysed: basis.analysed, needed: coach.minAnalysed });
    }

    const qKey = questionKey(question);
    const cacheKey = { playerId: player._id, questionKey: qKey, analysedGamesHash: basis.hash, promptVersion: ASK_PROMPT_VERSION, model: coach.modelName };
    const cached = await Answer.findOne(cacheKey);
    if (cached) {
      res.status(200).json({ answer: publicAnswerOf(cached), cached: true });
      return;
    }

    // Joining a run of the same question: free, with a token of their own.
    const join = async (runId: string) => {
      const token = await addRunToken(runId);
      if (!token) {
        // No token: the run is full, or it finished between our lookups. If it finished, its
        // answer is in the cache now: serve that instead of a needless "busy".
        const justSaved = await Answer.findOne(cacheKey);
        if (justSaved) {
          res.status(200).json({ answer: publicAnswerOf(justSaved), cached: true });
          return;
        }
        logRefusal(res, "run_tokens", { runId });
        return sendFriendly(res, 503, "busy", { queue: "coach", retryAfterMs: BUSY_RETRY_MS });
      }
      res.status(202).json({ runId, token });
    };
    const running = await activeRunId(player._id, qKey);
    if (running) return join(running);

    if (!coach.available) return sendFriendly(res, 503, "ai_disabled");
    if ((await coach.budget.remaining()) < coach.askLimits.maxRequests) {
      const resetsInMs = coach.budget.resetsInMs();
      return sendFriendly(res, 429, "ai_budget_exhausted", { resetsInMs, retryAfterMs: resetsInMs });
    }

    let mine: Awaited<ReturnType<typeof take>> | null = null;
    if (guards) {
      // Served by the { status, runAfter } index (status prefix).
      const queued = await Job.countDocuments({ status: "queued", type: { $in: ["report", "ask"] } });
      if (queued >= guards.limits.coachQueueMax) {
        logRefusal(res, "coach_queue", { queued });
        return sendFriendly(res, 503, "busy", { queue: "coach", retryAfterMs: BUSY_RETRY_MS });
      }
      mine = await take(askRules(visitorOf(res), guards.limits), guards.now?.() ?? new Date());
      if (!mine.ok) {
        logRefusal(res, "asks", { window: mine.rule.window });
        return sendFriendly(res, 429, "limit_questions", { retryAfterMs: mine.retryAfterMs });
      }
    }

    let started: Awaited<ReturnType<typeof startAskRun>>;
    try {
      started = await startAskRun(queue, player._id, coach.modelName, question);
    } catch (err) {
      if (mine?.ok) await refund(mine.taken).catch(() => {});
      throw err;
    }
    if (!started.created) {
      // The same question started a moment ago: joined, so it doesn't count.
      if (mine?.ok) await refund(mine.taken);
      return join(started.runId);
    }
    res.status(202).json({ runId: started.runId, token: started.token });
  });

  return router;
}
