import { Types } from "mongoose";
import { askTask, ASK_PROMPT_VERSION, questionKey } from "../../agent/ask.js";
import { publicAnswerOf, saveAnswer, toPublicAnswer } from "../../agent/answerStore.js";
import { analysedBasis } from "../../agent/basis.js";
import type { CoachRuntime } from "../../agent/coach.js";
import { friendly, friendlyFromAgent } from "../../agent/friendly.js";
import { runTask } from "../../agent/loop.js";
import { newRunToken } from "../../agent/runTokens.js";
import { createStepWriter, runStore } from "../../agent/runs.js";
import { AgentRun, runExpiresAt } from "../../db/models/agentRun.js";
import { Answer } from "../../db/models/answer.js";
import type { JobDoc } from "../../db/models/job.js";
import { Player } from "../../db/models/player.js";
import { logger } from "../../lib/logger.js";
import { sleep } from "../../lib/sleep.js";
import { FatalError } from "../errors.js";
import type { Queue } from "../queue.js";
import type { JobHandler } from "../worker.js";

// The `ask` job (Stage 6 chunk B): one "Ask the coach" run for one question, on the coach lane
// next to reports. It follows the report job's rules (jobs/handlers/report.ts):
// - Key "ask:<model>:<playerId>:<questionKey>": one queued-or-running run per question, so the
//   same question asked twice joins the same run.
// - maxAttempts 2; a failed RUN is final (a retry would spend the AI calls again); only errors
//   outside the run (the DB) retry. Shutdown mid-run: back to queued, started again from scratch.
// - Another run may have answered exactly this question while this one waited: served from the
//   answer cache with 0 calls.

export interface AskPayload {
  runId: string;
  model: string;
}

export const askJobKey = (model: string, playerId: Types.ObjectId | string, qKey: string) => `ask:${model}:${String(playerId)}:${qKey}`;
export const ASK_MAX_ATTEMPTS = 2;

// Starts (or joins) a question's run. The agentRun is created first, holding the asker's token
// hash; if the same question is already running for this player, ours is deleted and the caller
// joins the existing run (routes/ask.ts adds a token for them there).
export async function startAskRun(
  queue: Pick<Queue, "enqueue">,
  playerId: Types.ObjectId,
  modelName: string,
  question: string,
): Promise<{ runId: string; created: true; token: string } | { runId: string; created: false }> {
  const { token, hash } = newRunToken();
  const run = await AgentRun.create({
    playerId,
    kind: "ask",
    question,
    model: modelName,
    promptVersion: ASK_PROMPT_VERSION,
    tokenHashes: [hash],
    expiresAt: runExpiresAt(),
  });
  const payload: AskPayload = { runId: String(run._id), model: modelName };
  let enqueued: Awaited<ReturnType<Queue["enqueue"]>>;
  try {
    enqueued = await queue.enqueue({
      type: "ask",
      key: askJobKey(modelName, playerId, questionKey(question)),
      payload: payload as unknown as Record<string, unknown>,
      maxAttempts: ASK_MAX_ATTEMPTS,
    });
  } catch (err) {
    // No job will ever run it: don't leave a queued run (holding a token hash) behind.
    await AgentRun.deleteOne({ _id: run._id }).catch(() => undefined);
    throw err;
  }
  const { job, created } = enqueued;
  if (!created) {
    await AgentRun.deleteOne({ _id: run._id });
    return { runId: String((job.payload as AskPayload).runId), created: false };
  }
  await AgentRun.updateOne({ _id: run._id }, { $set: { jobId: job._id } });
  return { runId: payload.runId, created: true, token };
}

const runIdOf = (job: JobDoc) => new Types.ObjectId(String((job.payload as AskPayload | undefined)?.runId));

export interface AskHandlerOptions {
  saveRetryDelaysMs?: number[];
  save?: typeof saveAnswer;
}

export function createAskHandler(coach: CoachRuntime, { saveRetryDelaysMs = [500, 2_000], save = saveAnswer }: AskHandlerOptions = {}): JobHandler {
  return {
    async run({ job, signal }) {
      const runId = runIdOf(job);
      const run = await AgentRun.findById(runId, { playerId: 1, status: 1, question: 1 }).lean();
      if (!run) throw new FatalError("run_not_found", friendly("run_not_found").message);
      if (run.status === "done" || run.status === "failed") return;

      const player = await Player.findById(run.playerId, { platform: 1 }).lean();
      if (!player) {
        const f = friendly("player_not_found");
        await runStore.fail(runId, f);
        throw new FatalError(f.code, f.message);
      }

      const question = run.question ?? "";
      const qKey = questionKey(question);
      const basis = await analysedBasis(player._id);
      await runStore.start(runId, job.attempts, basis.hash);
      // The question itself isn't logged: it's the visitor's text.
      const log = { runId: String(runId), jobId: String(job._id), playerId: String(player._id), attempt: job.attempts, kind: "ask" };

      const cached = await Answer.findOne({ playerId: player._id, questionKey: qKey, analysedGamesHash: basis.hash, promptVersion: ASK_PROMPT_VERSION, model: coach.modelName });
      if (cached) {
        await runStore.doneAsk(runId, { answerId: cached._id, usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, publicAnswerOf(cached));
        logger.info("Ask run served from cache", log);
        return;
      }

      const ctx = { playerId: player._id, platform: player.platform, rules: coach.rules };
      const steps = createStepWriter(runId);
      const result = await runTask({
        ctx,
        task: askTask(ctx, question),
        model: coach.model,
        ...(coach.fallback ? { fallback: coach.fallback } : {}),
        pacer: coach.pacer,
        limits: coach.askLimits,
        signal,
        onStep: (step) => steps.push(step),
      });
      await steps.flush();

      if (signal.aborted) {
        if ((signal.reason as Error | undefined)?.name === "ShuttingDown") await runStore.requeue(runId).catch(() => undefined);
        logger.info("Ask run stopped", { ...log, reason: (signal.reason as Error | undefined)?.name, calls: result.usage.calls });
        return;
      }

      if (result.status === "done" && result.output) {
        const input = {
          playerId: player._id,
          questionKey: qKey,
          question,
          analysedGamesHash: basis.hash,
          analysedGames: basis.analysed,
          promptVersion: ASK_PROMPT_VERSION,
          model: coach.modelName,
          answeredBy: result.answerModel ?? coach.modelName,
          runId,
          answer: result.output,
          usage: result.usage,
          durationMs: result.durationMs,
        };
        // The AI work is paid for: only the save is retried, never the run.
        let saved!: Awaited<ReturnType<typeof saveAnswer>>;
        for (let attempt = 0; ; attempt++) {
          try {
            saved = await save(input);
            break;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            if (attempt >= saveRetryDelaysMs.length) {
              logger.error("Ask answer could not be saved", { ...log, saveAttempts: attempt + 1, error, calls: result.usage.calls });
              const f = friendly("internal");
              await runStore.fail(runId, f, result.usage);
              throw new FatalError(f.code, f.message);
            }
            logger.warn("Ask answer save failed, retrying", { ...log, saveAttempt: attempt + 1, error });
            await sleep(saveRetryDelaysMs[attempt]!);
          }
        }
        await runStore.doneAsk(runId, { answerId: saved._id, usage: result.usage }, toPublicAnswer(saved));
        logger.info("ask_done", {
          ...log,
          answerId: String(saved._id),
          outcome: result.output.outcome,
          reason: result.output.reason,
          sentences: result.output.sentences.length,
          evidence: result.output.evidence.length,
          removed: result.output.removed.length,
          answeredBy: result.answerModel,
          calls: result.usage.calls,
          tokens: result.usage.totalTokens,
          ms: result.durationMs,
        });
        return;
      }

      const f = friendlyFromAgent(result.error, { resetsInMs: coach.budget.resetsInMs() });
      logger.warn("Ask run failed", {
        ...log,
        code: result.error?.code,
        phase: result.error?.phase,
        modelErrorKind: result.error?.modelErrorKind,
        unexpected: result.error?.unexpected,
        error: result.error?.message,
        shown: f.code,
        calls: result.usage.calls,
        ms: result.durationMs,
      });
      await runStore.fail(runId, f, result.usage);
      throw new FatalError(f.code, f.message);
    },

    async onFailed(job) {
      const f = friendly(job.error?.code === "lease_expired" ? "coach_interrupted" : "internal");
      await runStore.fail(runIdOf(job), f).catch((err: unknown) => {
        logger.warn("Could not mark the ask run failed", { jobId: String(job._id), error: err instanceof Error ? err.message : String(err) });
      });
    },
  };
}
