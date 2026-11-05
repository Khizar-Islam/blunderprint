import { EventEmitter } from "node:events";
import type { QueryFilter, Types, UpdateQuery } from "mongoose";
import { AgentRun, MAX_RUN_STEPS, type AgentRunDoc, type AgentRunFields, type RunStatus } from "../db/models/agentRun.js";
import { logger } from "../lib/logger.js";
import type { FriendlyError } from "./friendly.js";
import type { TraceStep } from "./loop.js";
import type { PublicReport } from "./reportStore.js";

// Coach runs: every change a viewer can see is one atomic update that bumps `rev`, followed by
// an event on this in-process bus, the same design as the job queue (jobs/queue.ts, events.ts).
// GET /api/runs/:id/stream subscribes, sends a snapshot from the DB, then the newer events.

export type RunEventType = "status" | "step" | "done" | "failed";

export interface PublicRun {
  id: string;
  status: string;
  rev: number;
  attempt: number;
  model: string;
  steps: TraceStep[];
  usage?: { calls: number; totalTokens: number };
  error?: FriendlyError;
  // Only on a finished run whose report still exists.
  report?: PublicReport;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

// `step` events carry just the new step (the snapshot already had the earlier ones); the
// others carry the whole public run.
export type RunEvent =
  | { type: "status" | "done" | "failed"; rev: number; run: PublicRun }
  | { type: "step"; rev: number; step: TraceStep };

type RunLike = AgentRunFields & { _id: unknown; createdAt?: Date };

export function toPublicRun(run: AgentRunDoc | RunLike, report?: PublicReport | null): PublicRun {
  const r = run as RunLike;
  return {
    id: String(r._id),
    status: r.status,
    rev: r.rev ?? 0,
    attempt: r.attempt ?? 0,
    model: r.model,
    steps: (r.steps ?? []) as TraceStep[],
    ...(r.usage?.calls != null ? { usage: { calls: r.usage.calls, totalTokens: r.usage.totalTokens ?? 0 } } : {}),
    ...(r.error?.code ? { error: { code: r.error.code, message: r.error.message ?? "" } as FriendlyError } : {}),
    ...(report ? { report } : {}),
    ...(r.createdAt ? { createdAt: r.createdAt.toISOString() } : {}),
    ...(r.startedAt ? { startedAt: r.startedAt.toISOString() } : {}),
    ...(r.finishedAt ? { finishedAt: r.finishedAt.toISOString() } : {}),
  };
}

const emitter = new EventEmitter();
// Every open stream adds a listener; don't warn at the default of 10.
emitter.setMaxListeners(0);

export const runEvents = {
  emit(runId: string, event: RunEvent): void {
    emitter.emit(runId, event);
  },
  subscribe(runId: string, listener: (event: RunEvent) => void): () => void {
    emitter.on(runId, listener);
    return () => emitter.off(runId, listener);
  },
  listenerCount(runId: string): number {
    return emitter.listenerCount(runId);
  },
};

const ACTIVE = { $in: ["queued", "running"] as RunStatus[] };

// One atomic, rev-bumping update; emits `type` with the whole run when it matched.
async function change(
  filter: QueryFilter<AgentRunFields>,
  update: UpdateQuery<AgentRunFields>,
  type: "status" | "done" | "failed",
  report?: PublicReport | null,
): Promise<AgentRunDoc | null> {
  const run = await AgentRun.findOneAndUpdate(filter, { ...update, $inc: { ...update.$inc, rev: 1 } }, { returnDocument: "after" });
  if (run) runEvents.emit(String(run._id), { type, rev: run.rev, run: toPublicRun(run, report) });
  return run;
}

type Usage = { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };

export const runStore = {
  // A new attempt starts: running, a clean trace (an earlier attempt's steps belong to a
  // conversation that's gone), and what it's based on.
  start(runId: Types.ObjectId, attempt: number, analysedGamesHash: string) {
    return change(
      { _id: runId, status: ACTIVE },
      {
        $set: { status: "running", attempt, analysedGamesHash, steps: [], startedAt: new Date() },
        $unset: { error: 1, usage: 1, finishedAt: 1 },
      },
      "status",
    );
  },

  // Back to queued: the server is shutting down and the job goes back to the queue.
  requeue(runId: Types.ObjectId) {
    return change({ _id: runId, status: "running" }, { $set: { status: "queued" } }, "status");
  },

  done(runId: Types.ObjectId, fields: { reportId: unknown; usage: Usage }, report: PublicReport) {
    return change(
      { _id: runId, status: ACTIVE },
      { $set: { status: "done", reportId: fields.reportId, usage: fields.usage, finishedAt: new Date() } },
      "done",
      report,
    );
  },

  // Only an active run can fail, so a late failure never overwrites a finished run.
  fail(runId: Types.ObjectId, error: FriendlyError, usage?: Usage) {
    return change(
      { _id: runId, status: ACTIVE },
      { $set: { status: "failed", error, finishedAt: new Date(), ...(usage ? { usage } : {}) } },
      "failed",
    );
  },

  // Appends one trace step (capped at MAX_RUN_STEPS) and emits it on its own.
  async pushStep(runId: Types.ObjectId, step: TraceStep): Promise<void> {
    const run = await AgentRun.findOneAndUpdate(
      { _id: runId, status: "running" },
      { $push: { steps: { $each: [step], $slice: MAX_RUN_STEPS } }, $inc: { rev: 1 } },
      { returnDocument: "after", projection: { rev: 1 } },
    );
    if (run) runEvents.emit(String(runId), { type: "step", rev: run.rev, step });
  },
};

// The loop reports steps through a synchronous callback; the DB writes are chained so they land
// in order, and flush() waits for the last one. A failed write is logged and skipped: losing a
// trace line must not fail the run.
export function createStepWriter(runId: Types.ObjectId) {
  let chain: Promise<void> = Promise.resolve();
  return {
    push(step: TraceStep): void {
      chain = chain.then(() =>
        runStore.pushStep(runId, step).catch((err: unknown) => {
          logger.warn("Run step write failed", { runId: String(runId), error: err instanceof Error ? err.message : String(err) });
        }),
      );
    },
    flush: () => chain,
  };
}
