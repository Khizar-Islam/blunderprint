import { randomUUID } from "node:crypto";
import type { QueryFilter, Types } from "mongoose";
import { AgentRun } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import type { JobFields } from "../db/models/job.js";
import { createAskHandler, startAskRun } from "../jobs/handlers/ask.js";
import type { Queue } from "../jobs/queue.js";
import { startWorker, type Handlers } from "../jobs/worker.js";
import { sleep } from "../lib/sleep.js";
import { ASK_PROMPT_VERSION, questionKey } from "./ask.js";
import { keepAnswer } from "./answerStore.js";
import { analysedBasis } from "./basis.js";
import type { CoachRuntime } from "./coach.js";

// The demo player's pre-answers (Stage 6 chunk C, npm run demo:answers → scripts/demoAnswers.ts).
// Each question goes through the REAL job path: startAskRun creates the run and enqueues the `ask`
// job exactly as POST /ask does, and the ask handler runs it (the model, tools, verifier and the
// answer cache are the production ones). Then the answer and its run are kept for good
// (keepAnswer: no expiresAt), so the chips answer at once and "How this answer was made" never
// expires.
//
// SAFETY: this runs from a laptop against the LIVE database, where visitors' report and ask jobs
// may be queued. So the script's own worker:
// - claims ONLY the job ids this call enqueued itself (ownJobsFilter), never anyone else's job;
// - never runs the lease reaper (reap: false), which would requeue or fail other jobs.
// The live server's coach lane may still claim one of OUR jobs first (it takes any ask job for its
// model): that's fine, it runs the same code, and we wait on the run in the database either way.
// POST /ask's visitor limits aren't involved: nothing here is counted against a visitor.

export const ownJobsFilter = (jobIds: readonly Types.ObjectId[]): QueryFilter<JobFields> => ({
  _id: { $in: [...jobIds] },
  type: "ask",
});

export type PreAnswerStatus =
  | "cached" // already answered for this data, prompt and model: kept, no AI call
  | "done" // answered now (by our worker, or by the live server's) and kept
  | "failed" // the run failed: nothing kept (error has the friendly code)
  | "unfinished"; // still running when we stopped waiting

export interface PreAnswerResult {
  question: string;
  status: PreAnswerStatus;
  runId?: string;
  answerId?: string;
  error?: { code: string; message: string };
  // Whether this call's own worker enqueued the job (false: joined a visitor's run of the same
  // question, which the live server runs).
  ownJob?: boolean;
}

export interface PreAnswerOptions {
  queue: Queue;
  coach: CoachRuntime;
  playerId: Types.ObjectId;
  questions: readonly string[];
  handlers?: Handlers; // default: the production ask handler for `coach`
  pollMs?: number; // how often the runs are checked in the database
  timeoutMs?: number; // stop waiting after this long (default: each question's run timeout + 1 min)
  workerPollMs?: number;
  onRunStarted?: (question: string, runId: string) => void;
}

export async function preAnswer({
  queue,
  coach,
  playerId,
  questions,
  handlers = { ask: createAskHandler(coach) },
  pollMs = 2_000,
  timeoutMs = questions.length * (coach.askLimits.runTimeoutMs + 60_000),
  workerPollMs = 1_000,
  onRunStarted,
}: PreAnswerOptions): Promise<PreAnswerResult[]> {
  const { hash } = await analysedBasis(playerId);
  const results: PreAnswerResult[] = [];
  const pending: { result: PreAnswerResult; runId: string }[] = [];
  const ownJobIds: Types.ObjectId[] = [];

  for (const question of questions) {
    const cached = await Answer.findOne({
      playerId,
      questionKey: questionKey(question),
      analysedGamesHash: hash,
      promptVersion: ASK_PROMPT_VERSION,
      model: coach.modelName,
    });
    if (cached) {
      await keepAnswer(cached._id);
      results.push({ question, status: "cached", runId: String(cached.runId), answerId: String(cached._id) });
      continue;
    }
    const started = await startAskRun(queue, playerId, coach.modelName, question);
    const result: PreAnswerResult = { question, status: "unfinished", runId: started.runId, ownJob: started.created };
    if (started.created) {
      const run = await AgentRun.findById(started.runId, { jobId: 1 }).lean();
      if (run?.jobId) ownJobIds.push(run.jobId as Types.ObjectId);
    }
    onRunStarted?.(question, started.runId);
    results.push(result);
    pending.push({ result, runId: started.runId });
  }

  if (pending.length) {
    const worker = ownJobIds.length
      ? startWorker({
          queue,
          handlers,
          claimFilter: ownJobsFilter(ownJobIds),
          reap: false,
          workerId: `demo-answers-${randomUUID().slice(0, 8)}`,
          pollMs: workerPollMs,
        })
      : null;
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const runs = await AgentRun.find(
          { _id: { $in: pending.map((p) => p.runId) } },
          { status: 1, answerId: 1, error: 1 },
        ).lean();
        const byId = new Map(runs.map((r) => [String(r._id), r]));
        const finished = pending.every((p) => {
          const s = byId.get(p.runId)?.status;
          return s === "done" || s === "failed";
        });
        if (finished || Date.now() >= deadline) {
          for (const p of pending) {
            const run = byId.get(p.runId);
            if (run?.status === "done" && run.answerId) {
              await keepAnswer(run.answerId as Types.ObjectId);
              p.result.status = "done";
              p.result.answerId = String(run.answerId);
            } else if (run?.status === "failed") {
              p.result.status = "failed";
              p.result.error = { code: run.error?.code ?? "internal", message: run.error?.message ?? "" };
            }
          }
          break;
        }
        await sleep(pollMs);
      }
    } finally {
      await worker?.stop();
    }
  }
  return results;
}
