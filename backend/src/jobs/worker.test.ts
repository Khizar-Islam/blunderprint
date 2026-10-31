import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Job } from "../db/models/job.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { FatalError, RetryableError } from "./errors.js";
import { createQueue } from "./queue.js";
import { startWorker, type JobHandler, type Worker } from "./worker.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
let worker: Worker | undefined;
after(async () => {
  // A running worker loop would keep the test process alive.
  await worker?.stop();
  await db.stop();
});
beforeEach(async () => {
  await worker?.stop();
  worker = undefined;
  await clearDb();
});

const input = { type: "import" as const, key: "import:lichess:alice", payload: { username: "alice" } };

// Polls the DB until the job matches, or fails the test after timeoutMs.
async function waitForJob(id: unknown, check: (job: any) => boolean, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await Job.findById(id).lean();
    if (job && check(job)) return job;
    if (Date.now() > deadline) assert.fail(`Job never reached the expected state: ${JSON.stringify(job)}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

test("the worker runs a job to done and saves its progress", async () => {
  const queue = createQueue();
  const handler: JobHandler = {
    async run({ reportProgress }) {
      await reportProgress({ done: 3, total: 3, message: "all done" });
    },
  };
  const { job } = await queue.enqueue(input);
  worker = startWorker({ queue, handlers: { import: handler }, pollMs: 10 });
  const done = await waitForJob(job._id, (j) => j.status === "done");
  assert.deepEqual(done.progress, { done: 3, total: 3, message: "all done" });
  assert.equal(done.leaseUntil, undefined);
});

test("a retryable error goes back to the queue; a fatal one fails and calls onFailed", async () => {
  const queue = createQueue({ backoffBaseMs: 60_000 });
  const failedKeys: string[] = [];
  const handler: JobHandler = {
    async run({ job }) {
      if ((job.payload as { username: string }).username === "alice") throw new RetryableError("try later");
      throw new FatalError("user_not_found", "No such player");
    },
    async onFailed(job) {
      failedKeys.push(job.key);
    },
  };
  const retry = await queue.enqueue(input);
  const fatal = await queue.enqueue({ ...input, key: "import:lichess:nobody", payload: { username: "nobody" } });
  worker = startWorker({ queue, handlers: { import: handler }, pollMs: 10 });

  const requeued = await waitForJob(retry.job._id, (j) => j.status === "queued" && j.attempts === 1);
  assert.ok(requeued.runAfter.getTime() > Date.now());
  await waitForJob(fatal.job._id, (j) => j.status === "failed");
  assert.deepEqual(failedKeys, ["import:lichess:nobody"]);
});

test("a handler that loses its lease is aborted and leaves the job alone", async () => {
  const queue = createQueue();
  const started = deferred();
  const release = deferred();
  let sawAbort = false;
  const handler: JobHandler = {
    async run({ signal, reportProgress }) {
      started.resolve();
      await release.promise;
      try {
        await reportProgress({ done: 1 });
      } finally {
        sawAbort = signal.aborted;
      }
    },
  };
  const { job } = await queue.enqueue(input);
  worker = startWorker({ queue, handlers: { import: handler }, pollMs: 10 });
  await started.promise;

  // Another worker took the job over (as if our lease had been reaped meanwhile).
  await Job.updateOne({ _id: job._id }, { $set: { workerId: "someone-else" } });
  release.resolve();

  await new Promise((resolve) => setTimeout(resolve, 100));
  const stored = await Job.findById(job._id).lean();
  assert.equal(sawAbort, true);
  assert.equal(stored!.status, "running");
  assert.equal(stored!.workerId, "someone-else");
  assert.equal(stored!.progress?.done, 0);
});

test("stop() aborts the running job and releases it for an immediate restart", async () => {
  const queue = createQueue();
  const started = deferred();
  const handler: JobHandler = {
    async run({ signal }) {
      started.resolve();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    },
  };
  const { job } = await queue.enqueue(input);
  const w = startWorker({ queue, handlers: { import: handler }, pollMs: 10 });
  await started.promise;
  await w.stop();

  const stored = await Job.findById(job._id).lean();
  assert.equal(stored!.status, "queued");
  assert.equal(stored!.attempts, 0); // the interrupted attempt was refunded
  assert.ok(stored!.runAfter.getTime() <= Date.now());
});

test("stop() releases the job even when the handler doesn't wind down within the grace period", async () => {
  // Regression: a handler stuck in a slow DB write held the release past the 10 s force-exit.
  const queue = createQueue();
  const started = deferred();
  const handler: JobHandler = {
    async run() {
      started.resolve();
      await new Promise(() => {}); // ignores the abort entirely
    },
  };
  const { job } = await queue.enqueue(input);
  const w = startWorker({ queue, handlers: { import: handler }, pollMs: 10, shutdownGraceMs: 50 });
  await started.promise;
  const t0 = Date.now();
  await w.stop();
  assert.ok(Date.now() - t0 < 1_000, "stop() should not wait on a stuck handler");

  const stored = await Job.findById(job._id).lean();
  assert.equal(stored!.status, "queued");
  assert.equal(stored!.attempts, 0);
  assert.equal(stored!.workerId, undefined);
});

test("after a hard kill, the reaper requeues the job and the next worker resumes from the checkpoint", async () => {
  let t = Date.now();
  const queue = createQueue({ now: () => new Date(t) });

  // A worker claims the job, saves a checkpoint, then the process dies (no release).
  const { job } = await queue.enqueue(input);
  await queue.claimNext("killed-worker", 60_000);
  await queue.saveProgress(job._id, "killed-worker", { done: 80 }, { collected: 80 });
  t += 61_000;

  let resumedFrom: unknown;
  const handler: JobHandler = {
    async run({ job }) {
      resumedFrom = job.checkpoint;
    },
  };
  worker = startWorker({ queue, handlers: { import: handler }, pollMs: 10, reapEveryMs: 15_000 });
  const done = await waitForJob(job._id, (j) => j.status === "done");
  assert.deepEqual(resumedFrom, { collected: 80 });
  assert.equal(done.attempts, 2);
});

test("a job type with no handler fails instead of looping", async () => {
  const queue = createQueue();
  const { job } = await queue.enqueue({ ...input, type: "extract", key: "extract:x" });
  worker = startWorker({ queue, handlers: {}, pollMs: 10 });
  const failed = await waitForJob(job._id, (j) => j.status === "failed");
  assert.equal(failed.error?.code, "unknown_job_type");
});
