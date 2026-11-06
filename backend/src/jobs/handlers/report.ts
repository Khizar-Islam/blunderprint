import { Types } from "mongoose";
import { analysedBasis } from "../../agent/basis.js";
import type { CoachRuntime } from "../../agent/coach.js";
import { friendly, friendlyFromAgent } from "../../agent/friendly.js";
import { runAgent } from "../../agent/loop.js";
import { PROMPT_VERSION } from "../../agent/prompts.js";
import { publicReportOf, saveReport, toPublicReport } from "../../agent/reportStore.js";
import { createStepWriter, runStore } from "../../agent/runs.js";
import { AgentRun, runExpiresAt } from "../../db/models/agentRun.js";
import type { JobDoc } from "../../db/models/job.js";
import { Player } from "../../db/models/player.js";
import { Report } from "../../db/models/report.js";
import { logger } from "../../lib/logger.js";
import { sleep } from "../../lib/sleep.js";
import { FatalError } from "../errors.js";
import type { Queue } from "../queue.js";
import type { JobHandler } from "../worker.js";

// The `report` job: one coach run (agent/loop.ts) for one player, written to an agentRun as it
// goes (the live trace) and saved as a report at the end.
//
// - Key "report:<model>:<playerId>": one queued-or-running report per player and model, so
//   asking twice returns the same run. The model is in the key (and the payload, and the lane's
//   claim filter) so a local server with the scripted model and the live one never take each
//   other's runs when they share a database.
// - maxAttempts 2. A failed RUN (time limit, model error, no answer) is final and never retried:
//   a retry would spend the AI calls again. Only an error outside the run (the DB) retries.
// - Shutdown mid-run: the abort stops the loop; the run goes back to "queued" and the worker
//   releases the job (attempt refunded). The next process starts the run again from scratch:
//   the conversation lived in memory, so the calls already made are lost.
// - A hard kill: the lease runs out, the reaper requeues the job, and the 2 attempts stop it
//   from looping forever. Out of attempts → the run fails with coach_interrupted.

export interface ReportPayload {
  runId: string;
  model: string;
}

export const reportJobKey = (model: string, playerId: Types.ObjectId | string) => `report:${model}:${String(playerId)}`;
export const REPORT_MAX_ATTEMPTS = 2;

// Starts (or rejoins) a run: the agentRun is created first so the stream can be opened at once;
// if a report job for this player is already active, ours is deleted and its run comes back.
export async function startReportRun(
  queue: Pick<Queue, "enqueue">,
  playerId: Types.ObjectId,
  modelName: string,
): Promise<{ runId: string; created: boolean }> {
  // expiresAt: deleted by the TTL index 14 days from now, unless it ends up behind a demo
  // player's report (agent/runExpiry.ts).
  const run = await AgentRun.create({ playerId, model: modelName, promptVersion: PROMPT_VERSION, expiresAt: runExpiresAt() });
  const payload: ReportPayload = { runId: String(run._id), model: modelName };
  const { job, created } = await queue.enqueue({
    type: "report",
    key: reportJobKey(modelName, playerId),
    payload: payload as unknown as Record<string, unknown>,
    maxAttempts: REPORT_MAX_ATTEMPTS,
  });
  if (!created) {
    await AgentRun.deleteOne({ _id: run._id });
    return { runId: String((job.payload as ReportPayload).runId), created: false };
  }
  await AgentRun.updateOne({ _id: run._id }, { $set: { jobId: job._id } });
  return { runId: payload.runId, created: true };
}

const runIdOf = (job: JobDoc) => new Types.ObjectId(String((job.payload as ReportPayload | undefined)?.runId));

export interface ReportHandlerOptions {
  // Waits between save attempts: 3 attempts in all by default. Tests shorten them.
  saveRetryDelaysMs?: number[];
  // Injected by tests to make the save fail.
  save?: typeof saveReport;
  // Called after a report is saved (setup.ts: keep a demo player's run, agent/runExpiry.ts).
  // A failure is only logged: the report is saved and the run is done.
  afterSave?: () => Promise<unknown>;
}

export function createReportHandler(
  coach: CoachRuntime,
  { saveRetryDelaysMs = [500, 2_000], save = saveReport, afterSave }: ReportHandlerOptions = {},
): JobHandler {
  return {
    async run({ job, signal }) {
      const runId = runIdOf(job);
      const run = await AgentRun.findById(runId, { playerId: 1, status: 1 }).lean();
      // Expired (TTL) or already finished: nothing left to do.
      if (!run) throw new FatalError("run_not_found", friendly("run_not_found").message);
      if (run.status === "done" || run.status === "failed") return;

      const player = await Player.findById(run.playerId, { platform: 1 }).lean();
      if (!player) {
        const f = friendly("player_not_found");
        await runStore.fail(runId, f);
        throw new FatalError(f.code, f.message);
      }

      // What the report will be based on, taken now: games analysed during the run make the
      // saved report "stale" afterwards rather than mislabelled.
      const basis = await analysedBasis(player._id);
      await runStore.start(runId, job.attempts, basis.hash);
      const log = { runId: String(runId), jobId: String(job._id), playerId: String(player._id), attempt: job.attempts };

      // Another run may have produced exactly this report while this one waited in the queue.
      const cached = await Report.findOne({
        playerId: player._id,
        analysedGamesHash: basis.hash,
        promptVersion: PROMPT_VERSION,
        model: coach.modelName,
      });
      if (cached) {
        await runStore.done(runId, { reportId: cached._id, usage: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 } }, await publicReportOf(cached));
        logger.info("Coach run served from cache", log);
        return;
      }

      const steps = createStepWriter(runId);
      const result = await runAgent({
        ctx: { playerId: player._id, platform: player.platform, rules: coach.rules },
        model: coach.model,
        ...(coach.fallback ? { fallback: coach.fallback } : {}),
        pacer: coach.pacer,
        limits: coach.limits,
        signal,
        onStep: (step) => steps.push(step),
      });
      await steps.flush();

      // Stopped from outside. Shutting down: the run waits in the queue again (the worker
      // releases the job). Lease lost: someone else owns the job now, so touch nothing.
      if (signal.aborted) {
        if ((signal.reason as Error | undefined)?.name === "ShuttingDown") {
          await runStore.requeue(runId).catch(() => undefined);
        }
        logger.info("Coach run stopped", { ...log, reason: (signal.reason as Error | undefined)?.name, calls: result.usage.calls });
        return;
      }

      if (result.status === "done" && result.report) {
        // The model's own "not enough data" text is never shown (nothing checks it); log it.
        if (result.report.notEnoughData) logger.info("Coach notEnoughData (not shown)", { ...log, text: result.report.notEnoughData });
        // The AI work is done and paid for: a failed save must never send the job round again
        // (that would run the whole agent a second time). Only the save is retried, here; if it
        // keeps failing, the run fails for good. (runStore.done failing after a good save is
        // already safe: a job retry finds the saved report in the cache and makes 0 calls.)
        const input = {
          playerId: player._id,
          analysedGamesHash: basis.hash,
          analysedGames: basis.analysed,
          promptVersion: PROMPT_VERSION,
          model: coach.modelName,
          answeredBy: result.answerModel ?? coach.modelName,
          runId,
          report: result.report,
          usage: result.usage,
          durationMs: result.durationMs,
        };
        let saved!: Awaited<ReturnType<typeof saveReport>>;
        for (let attempt = 0; ; attempt++) {
          try {
            saved = await save(input);
            break;
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            if (attempt >= saveRetryDelaysMs.length) {
              logger.error("Coach report could not be saved", {
                ...log,
                saveAttempts: attempt + 1,
                error,
                patterns: result.report.patterns.length,
                calls: result.usage.calls,
                tokens: result.usage.totalTokens,
                ms: result.durationMs,
              });
              const f = friendly("internal");
              await runStore.fail(runId, f, result.usage);
              throw new FatalError(f.code, f.message);
            }
            logger.warn("Coach report save failed, retrying", { ...log, saveAttempt: attempt + 1, error });
            await sleep(saveRetryDelaysMs[attempt]!);
          }
        }
        await runStore.done(runId, { reportId: saved._id, usage: result.usage }, toPublicReport(saved));
        if (afterSave) {
          await afterSave().catch((err: unknown) =>
            logger.warn("After-save step failed", { ...log, error: err instanceof Error ? err.message : String(err) }),
          );
        }
        logger.info("Coach report saved", {
          ...log,
          reportId: String(saved._id),
          answeredBy: result.answerModel,
          patterns: result.report.patterns.length,
          dropped: result.report.dropped.length,
          trimmed: result.report.trimmed.length,
          calls: result.usage.calls,
          tokens: result.usage.totalTokens,
          ms: result.durationMs,
        });
        return;
      }

      // A failed run: the visitor gets the friendly pair, the log gets everything.
      const f = friendlyFromAgent(result.error, { resetsInMs: coach.budget.resetsInMs() });
      logger.warn("Coach run failed", {
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

    // The job failed for good outside a finished run: out of attempts after DB errors, or the
    // reaper gave up on it (the process kept dying). No-op if the run already ended.
    async onFailed(job) {
      const f = friendly(job.error?.code === "lease_expired" ? "coach_interrupted" : "internal");
      await runStore.fail(runIdOf(job), f).catch((err: unknown) => {
        logger.warn("Could not mark the coach run failed", { jobId: String(job._id), error: err instanceof Error ? err.message : String(err) });
      });
    },
  };
}
