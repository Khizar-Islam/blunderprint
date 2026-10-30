import { ACTIVE_JOB_STATUSES, Job, type JobDoc, type JobType } from "../db/models/job.js";
import { FatalError, RetryableError } from "./errors.js";

export interface EnqueueInput {
  type: JobType;
  key: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

export interface Progress {
  done: number;
  total?: number;
  message?: string;
}

export interface QueueOptions {
  now?: () => Date;
  // Retry backoff: baseMs × 2^(attempt − 1), capped, plus up to 20% jitter so retries spread out.
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
}

export type FailOutcome = "retry" | "failed" | "lost";

const DUPLICATE_KEY = 11000;

// The job queue lives in MongoDB. Every state change is a single atomic update whose filter
// checks the current state (and, for a running job, the owning workerId), so two workers or a
// worker and the reaper can never both "win" the same job.
export function createQueue({
  now = () => new Date(),
  backoffBaseMs = 5_000,
  backoffMaxMs = 5 * 60_000,
  random = Math.random,
}: QueueOptions = {}) {
  const later = (ms: number) => new Date(now().getTime() + ms);

  // Idempotent: if a job with this key is already queued or running, return it instead.
  async function enqueue(input: EnqueueInput): Promise<{ job: JobDoc; created: boolean }> {
    // Two tries: the existing job may finish between our failed insert and the lookup.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const job = await Job.create({
          type: input.type,
          key: input.key,
          payload: input.payload ?? {},
          maxAttempts: input.maxAttempts ?? 5,
          runAfter: now(),
        });
        return { job, created: true };
      } catch (err) {
        if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
        const existing = await Job.findOne({ key: input.key, status: { $in: [...ACTIVE_JOB_STATUSES] } });
        if (existing) return { job: existing, created: false };
      }
    }
    throw new Error(`Could not enqueue job ${input.key}`);
  }

  // Atomically take the oldest due job and lease it to this worker.
  async function claimNext(workerId: string, leaseMs: number): Promise<JobDoc | null> {
    return Job.findOneAndUpdate(
      { status: "queued", runAfter: { $lte: now() } },
      { $set: { status: "running", workerId, leaseUntil: later(leaseMs) }, $inc: { attempts: 1 } },
      { sort: { runAfter: 1 }, returnDocument: "after" },
    );
  }

  // The filter every update to a running job uses: still running, still ours.
  const owned = (jobId: unknown, workerId: string) => ({ _id: jobId, workerId, status: "running" as const });

  // Returns false when the lease is gone (reaped and taken by someone else): stop working on it.
  async function renewLease(jobId: unknown, workerId: string, leaseMs: number): Promise<boolean> {
    const res = await Job.updateOne(owned(jobId, workerId), { $set: { leaseUntil: later(leaseMs) } });
    return res.matchedCount === 1;
  }

  async function saveProgress(
    jobId: unknown,
    workerId: string,
    progress: Progress,
    checkpoint?: unknown,
  ): Promise<boolean> {
    const set: Record<string, unknown> = { progress };
    if (checkpoint !== undefined) set.checkpoint = checkpoint;
    const res = await Job.updateOne(owned(jobId, workerId), { $set: set });
    return res.matchedCount === 1;
  }

  async function complete(jobId: unknown, workerId: string): Promise<boolean> {
    // Clears the error left by an earlier failed attempt: a done job has no error to show.
    const res = await Job.updateOne(owned(jobId, workerId), {
      $set: { status: "done" },
      $unset: { leaseUntil: 1, workerId: 1, error: 1 },
    });
    return res.matchedCount === 1;
  }

  function backoffMs(attempts: number): number {
    const base = Math.min(backoffBaseMs * 2 ** Math.max(attempts - 1, 0), backoffMaxMs);
    return Math.round(base * (1 + 0.2 * random()));
  }

  // Retry with backoff, or fail for good when the error is fatal or attempts are used up.
  async function fail(job: JobDoc, workerId: string, err: unknown): Promise<FailOutcome> {
    const fatal = err instanceof FatalError;
    if (!fatal && job.attempts < job.maxAttempts) {
      const delay = err instanceof RetryableError && err.retryAfterMs ? err.retryAfterMs : backoffMs(job.attempts);
      const res = await Job.updateOne(owned(job._id, workerId), {
        $set: { status: "queued", runAfter: later(delay), error: errorInfo(err) },
        $unset: { leaseUntil: 1, workerId: 1 },
      });
      return res.matchedCount === 1 ? "retry" : "lost";
    }
    const res = await Job.updateOne(owned(job._id, workerId), {
      $set: { status: "failed", error: errorInfo(err) },
      $unset: { leaseUntil: 1, workerId: 1 },
    });
    return res.matchedCount === 1 ? "failed" : "lost";
  }

  // Graceful shutdown (Ctrl+C, Render redeploy): hand the job back right away instead of
  // waiting for the lease to run out, and give back the attempt it was charged.
  async function release(jobId: unknown, workerId: string): Promise<boolean> {
    const res = await Job.updateOne(owned(jobId, workerId), {
      $set: { status: "queued", runAfter: now() },
      $unset: { leaseUntil: 1, workerId: 1 },
      $inc: { attempts: -1 },
    });
    return res.matchedCount === 1;
  }

  // Finds running jobs whose lease ran out (the worker died or the server slept) and puts them
  // back in the queue, or fails them if they're out of attempts. Each update re-checks
  // leaseUntil < now, so a worker that renews at the last moment keeps its job.
  async function reapExpired(): Promise<{ requeued: JobDoc[]; failed: JobDoc[] }> {
    const cutoff = now();
    const expired = await Job.find({ status: "running", leaseUntil: { $lt: cutoff } });
    const requeued: JobDoc[] = [];
    const failed: JobDoc[] = [];
    for (const job of expired) {
      const outOfAttempts = job.attempts >= job.maxAttempts;
      const updated = await Job.findOneAndUpdate(
        { _id: job._id, status: "running", leaseUntil: { $lt: cutoff } },
        outOfAttempts
          ? {
              $set: {
                status: "failed",
                error: { code: "lease_expired", message: "The job stopped responding too many times." },
              },
              $unset: { leaseUntil: 1, workerId: 1 },
            }
          : { $set: { status: "queued", runAfter: cutoff }, $unset: { leaseUntil: 1, workerId: 1 } },
        { returnDocument: "after" },
      );
      if (updated) (outOfAttempts ? failed : requeued).push(updated);
    }
    return { requeued, failed };
  }

  // Queued + running, for /api/health.
  async function depth(): Promise<number> {
    return Job.countDocuments({ status: { $in: [...ACTIVE_JOB_STATUSES] } });
  }

  return { enqueue, claimNext, renewLease, saveProgress, complete, fail, release, reapExpired, depth };
}

export type Queue = ReturnType<typeof createQueue>;

// What we store on the job: our own messages for known errors, a fixed one for everything else.
function errorInfo(err: unknown): { code: string; message: string } {
  if (err instanceof FatalError) return { code: err.code, message: err.message };
  if (err instanceof RetryableError) return { code: "retryable", message: err.message };
  return { code: "internal", message: "Something went wrong on our side." };
}
