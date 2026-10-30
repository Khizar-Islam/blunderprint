import { randomUUID } from "node:crypto";
import type { JobDoc, JobType } from "../db/models/job.js";
import { logger } from "../lib/logger.js";
import { sleep as realSleep, type Sleep } from "../lib/sleep.js";
import { FatalError, RetryableError } from "./errors.js";
import type { Progress, Queue } from "./queue.js";

export interface JobContext {
  job: JobDoc;
  // Aborts when the lease is lost or the server is shutting down. Pass it to every fetch and sleep.
  signal: AbortSignal;
  // Saves progress (and optionally a resume checkpoint). Throws if the lease is gone.
  reportProgress(progress: Progress, checkpoint?: unknown): Promise<void>;
}

export interface JobHandler {
  run(ctx: JobContext): Promise<void>;
  // Called once when the job fails for good (fatal error, out of attempts, or reaped).
  onFailed?(job: JobDoc): Promise<void>;
}

export type Handlers = Partial<Record<JobType, JobHandler>>;

export interface WorkerOptions {
  queue: Queue;
  handlers: Handlers;
  workerId?: string;
  leaseMs?: number;
  pollMs?: number;
  reapEveryMs?: number;
  sleep?: Sleep;
  now?: () => number;
}

class LeaseLost extends Error {
  constructor() {
    super("Lease lost");
    this.name = "LeaseLost";
  }
}
class ShuttingDown extends Error {
  constructor() {
    super("Shutting down");
    this.name = "ShuttingDown";
  }
}

// The job worker runs inside the API process (Render has no free background workers).
// One job at a time: the importers are serial per site anyway, and the free instance is small.
export function startWorker({
  queue,
  handlers,
  workerId = `worker-${randomUUID().slice(0, 8)}`,
  leaseMs = 60_000,
  pollMs = 1_000,
  reapEveryMs = 15_000,
  sleep = realSleep,
  now = Date.now,
}: WorkerOptions) {
  let stopping = false;
  const stopController = new AbortController();
  let current: AbortController | null = null;
  let lastReapAt = -Infinity;

  async function reap(): Promise<void> {
    const { requeued, failed } = await queue.reapExpired();
    for (const job of requeued) logger.warn("Requeued job with expired lease", { jobId: String(job._id), key: job.key });
    for (const job of failed) {
      logger.error("Job failed: lease expired too many times", { jobId: String(job._id), key: job.key });
      await handlers[job.type as JobType]?.onFailed?.(job);
    }
  }

  async function runJob(job: JobDoc): Promise<void> {
    const jobId = String(job._id);
    const started = now();
    const controller = new AbortController();
    current = controller;

    // Keep the lease alive while the handler works: renew at a third of the lease length,
    // so two renewals can fail (a slow DB moment) before the lease actually runs out.
    const renewTimer = setInterval(() => {
      queue.renewLease(job._id, workerId, leaseMs).then(
        (ok) => {
          if (!ok) controller.abort(new LeaseLost());
        },
        (err) => logger.warn("Lease renewal failed", { jobId, error: String(err) }),
      );
    }, leaseMs / 3);

    const ctx: JobContext = {
      job,
      signal: controller.signal,
      async reportProgress(progress, checkpoint) {
        const ok = await queue.saveProgress(job._id, workerId, progress, checkpoint);
        if (!ok) {
          controller.abort(new LeaseLost());
          throw new LeaseLost();
        }
      },
    };

    logger.info("Job started", { jobId, key: job.key, attempt: job.attempts });
    try {
      const handler = handlers[job.type as JobType];
      if (!handler) throw new FatalError("unknown_job_type", `No handler for job type ${job.type}`);
      await handler.run(ctx);
      if (controller.signal.aborted) throw controller.signal.reason;
      await queue.complete(job._id, workerId);
      logger.info("Job done", { jobId, key: job.key, ms: now() - started });
    } catch (err) {
      const reason = controller.signal.aborted ? controller.signal.reason : err;
      if (reason instanceof LeaseLost) {
        // Someone else owns the job now. Touch nothing.
        logger.warn("Job lease lost, stopping", { jobId, key: job.key });
      } else if (reason instanceof ShuttingDown) {
        await queue.release(job._id, workerId);
        logger.info("Job released for shutdown", { jobId, key: job.key, ms: now() - started });
      } else {
        const outcome = await queue.fail(job, workerId, err);
        logger.warn("Job error", {
          jobId,
          key: job.key,
          outcome,
          attempt: job.attempts,
          error: err instanceof Error ? err.message : String(err),
          // Stack traces only for unexpected errors (bugs), not for the ones we throw on purpose.
          stack: err instanceof FatalError || err instanceof RetryableError ? undefined : (err as Error)?.stack,
        });
        if (outcome === "failed") await handlers[job.type as JobType]?.onFailed?.(job);
      }
    } finally {
      clearInterval(renewTimer);
      current = null;
    }
  }

  async function loop(): Promise<void> {
    while (!stopping) {
      try {
        // The reaper only needs to run every ~15 s: leases are 60 s, and a slower sweep
        // means fewer idle queries on the free M0 cluster.
        if (now() - lastReapAt >= reapEveryMs) {
          lastReapAt = now();
          await reap();
        }
        const job = await queue.claimNext(workerId, leaseMs);
        if (job) {
          await runJob(job);
          continue; // there may be more work: look again right away
        }
        await sleep(pollMs, stopController.signal);
      } catch (err) {
        if (stopping) break;
        // Usually the DB is unreachable. Back off and keep going; Mongoose reconnects by itself.
        logger.error("Worker loop error", { error: err instanceof Error ? err.message : String(err) });
        await sleep(pollMs * 5, stopController.signal).catch(() => {});
      }
    }
  }

  const done = loop();
  logger.info("Job worker started", { workerId });

  return {
    workerId,
    // Stop claiming, hand the current job back to the queue, and wait for the loop to exit.
    async stop(): Promise<void> {
      stopping = true;
      stopController.abort(new ShuttingDown());
      current?.abort(new ShuttingDown());
      await done;
    },
  };
}

export type Worker = ReturnType<typeof startWorker>;
