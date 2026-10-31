import { EventEmitter } from "node:events";
import type { JobDoc } from "../db/models/job.js";

export type JobEventType = "progress" | "retrying" | "done" | "failed";

// What a browser may see about a job: no workerId, lease or payload internals.
export interface PublicJob {
  id: string;
  type: string;
  status: string;
  rev: number;
  attempts: number;
  maxAttempts: number;
  progress: { done: number; total?: number; message?: string };
  runAfter?: string;
  error?: { code: string; message: string };
}

export interface JobEvent {
  type: JobEventType;
  job: PublicJob;
}

export function toPublicJob(job: JobDoc): PublicJob {
  const progress = job.progress ?? { done: 0 };
  return {
    id: String(job._id),
    type: job.type,
    status: job.status,
    rev: job.rev ?? 0,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    progress: {
      done: progress.done ?? 0,
      ...(progress.total != null ? { total: progress.total } : {}),
      ...(progress.message ? { message: progress.message } : {}),
    },
    ...(job.runAfter ? { runAfter: job.runAfter.toISOString() } : {}),
    ...(job.error?.code ? { error: { code: job.error.code, message: job.error.message ?? "" } } : {}),
  };
}

// In-process bus: the queue emits after every visible change, SSE routes listen per job.
// One process runs both the worker and the API (Render free tier), so no Redis or change
// streams are needed. Events are a fast path only: a stream always starts from a DB snapshot.
const emitter = new EventEmitter();
// Every open SSE stream adds a listener; don't warn at the default of 10.
emitter.setMaxListeners(0);

export const jobEvents = {
  emit(type: JobEventType, job: JobDoc): void {
    const event: JobEvent = { type, job: toPublicJob(job) };
    emitter.emit(event.job.id, event);
  },
  // Returns the unsubscribe function.
  subscribe(jobId: string, listener: (event: JobEvent) => void): () => void {
    emitter.on(jobId, listener);
    return () => emitter.off(jobId, listener);
  },
  listenerCount(jobId: string): number {
    return emitter.listenerCount(jobId);
  },
};
