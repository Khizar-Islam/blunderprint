import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Job } from "../db/models/job.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { FatalError, RetryableError } from "./errors.js";
import { jobEvents, type JobEvent } from "./events.js";
import { createQueue } from "./queue.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

// A clock the test moves by hand, so lease expiry and backoff need no real waiting.
function fakeClock(start = Date.parse("2026-10-30T12:00:00Z")) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

const LEASE = 60_000;
const input = { type: "import" as const, key: "import:lichess:alice", payload: { platform: "lichess", username: "alice" } };

test("enqueue is idempotent while a job is active, and allows a new one after it finishes", async () => {
  const queue = createQueue();
  const first = await queue.enqueue(input);
  const second = await queue.enqueue(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(String(second.job._id), String(first.job._id));

  // Still the same job once it's running.
  const claimed = await queue.claimNext("w1", LEASE);
  assert.equal((await queue.enqueue(input)).created, false);

  await queue.complete(claimed!._id, "w1");
  const third = await queue.enqueue(input);
  assert.equal(third.created, true);
  assert.notEqual(String(third.job._id), String(first.job._id));
  assert.equal(await Job.countDocuments({ key: input.key }), 2);
});

test("only one of many simultaneous claims wins a job", async () => {
  const queue = createQueue();
  await queue.enqueue(input);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.claimNext(`w${i}`, LEASE)));
  const winners = results.filter((job) => job !== null);
  assert.equal(winners.length, 1);
  assert.equal(winners[0]!.status, "running");
  assert.equal(winners[0]!.attempts, 1);
});

test("a retryable error requeues with growing backoff, honouring runAfter", async () => {
  const clock = fakeClock();
  const queue = createQueue({ now: clock.now, random: () => 0 });
  await queue.enqueue({ ...input, maxAttempts: 5 });

  let job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.fail(job!, "w1", new RetryableError("network")), "retry");
  let stored = await Job.findById(job!._id);
  assert.equal(stored!.status, "queued");
  assert.equal(stored!.runAfter.getTime() - clock.now().getTime(), 5_000);
  assert.deepEqual({ ...stored!.toObject().error }, { code: "retryable", message: "network" });

  // Not due yet.
  assert.equal(await queue.claimNext("w1", LEASE), null);
  clock.advance(5_000);
  job = await queue.claimNext("w1", LEASE);
  assert.equal(job!.attempts, 2);

  await queue.fail(job!, "w1", new RetryableError("network"));
  stored = await Job.findById(job!._id);
  assert.equal(stored!.runAfter.getTime() - clock.now().getTime(), 10_000);

  // A later success clears the earlier error.
  clock.advance(10_000);
  job = await queue.claimNext("w1", LEASE);
  await queue.complete(job!._id, "w1");
  const finished = await Job.findById(job!._id).lean();
  assert.equal(finished!.status, "done");
  assert.equal(finished!.error, undefined);
});

test("retryAfterMs from a 429 overrides the backoff", async () => {
  const clock = fakeClock();
  const queue = createQueue({ now: clock.now, random: () => 0 });
  await queue.enqueue(input);
  const job = await queue.claimNext("w1", LEASE);
  await queue.fail(job!, "w1", new RetryableError("rate limited", 60_000));
  const stored = await Job.findById(job!._id);
  assert.equal(stored!.runAfter.getTime() - clock.now().getTime(), 60_000);
});

test("a fatal error fails the job immediately with its message", async () => {
  const queue = createQueue();
  await queue.enqueue(input);
  const job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.fail(job!, "w1", new FatalError("user_not_found", "No such player")), "failed");
  const stored = await Job.findById(job!._id);
  assert.equal(stored!.status, "failed");
  assert.equal(stored!.error?.code, "user_not_found");
  assert.equal(stored!.leaseUntil, undefined);
});

test("the job fails once attempts run out, and unknown errors get a fixed message", async () => {
  const queue = createQueue({ backoffBaseMs: 0 });
  await queue.enqueue({ ...input, maxAttempts: 2 });
  let job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.fail(job!, "w1", new Error("boom with internals")), "retry");
  job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.fail(job!, "w1", new Error("boom with internals")), "failed");
  const stored = await Job.findById(job!._id);
  assert.equal(stored!.status, "failed");
  assert.equal(stored!.error?.code, "internal");
  assert.doesNotMatch(stored!.error!.message!, /internals/);
});

test("an expired lease is reaped and another worker takes over; the old worker is locked out", async () => {
  const clock = fakeClock();
  const queue = createQueue({ now: clock.now });
  await queue.enqueue(input);
  const job = await queue.claimNext("dead-worker", LEASE);
  await queue.saveProgress(job!._id, "dead-worker", { done: 50, total: 200 }, { collected: 50 });

  // Lease still valid: nothing to reap.
  clock.advance(LEASE - 1);
  assert.equal((await queue.reapExpired()).requeued.length, 0);

  clock.advance(2);
  const { requeued, failed } = await queue.reapExpired();
  assert.equal(requeued.length, 1);
  assert.equal(failed.length, 0);

  const taken = await queue.claimNext("new-worker", LEASE);
  assert.equal(taken!.workerId, "new-worker");
  assert.equal(taken!.attempts, 2);
  // The checkpoint survives, so the new worker resumes instead of starting over.
  assert.deepEqual(taken!.checkpoint, { collected: 50 });

  // The dead worker waking up can't touch it any more.
  assert.equal(await queue.renewLease(job!._id, "dead-worker", LEASE), false);
  assert.equal(await queue.saveProgress(job!._id, "dead-worker", { done: 60 }), false);
  assert.equal(await queue.complete(job!._id, "dead-worker"), false);
  assert.equal(await queue.fail(job!, "dead-worker", new Error("late")), "lost");
});

test("renewing the lease keeps the reaper away", async () => {
  const clock = fakeClock();
  const queue = createQueue({ now: clock.now });
  await queue.enqueue(input);
  const job = await queue.claimNext("w1", LEASE);
  clock.advance(LEASE - 1_000);
  assert.equal(await queue.renewLease(job!._id, "w1", LEASE), true);
  clock.advance(5_000);
  assert.equal((await queue.reapExpired()).requeued.length, 0);
});

test("the reaper fails a job whose attempts are used up", async () => {
  const clock = fakeClock();
  const queue = createQueue({ now: clock.now });
  await queue.enqueue({ ...input, maxAttempts: 1 });
  await queue.claimNext("w1", LEASE);
  clock.advance(LEASE + 1);
  const { failed } = await queue.reapExpired();
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.status, "failed");
  assert.equal(failed[0]!.error?.code, "lease_expired");
});

test("release hands the job straight back and refunds the attempt", async () => {
  const queue = createQueue();
  await queue.enqueue(input);
  const job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.release(job!._id, "w1"), true);
  const again = await queue.claimNext("w2", LEASE);
  assert.equal(String(again!._id), String(job!._id));
  assert.equal(again!.attempts, 1);
});

test("depth counts queued and running jobs only", async () => {
  const queue = createQueue();
  await queue.enqueue(input);
  await queue.enqueue({ ...input, key: "import:lichess:bob" });
  const job = await queue.claimNext("w1", LEASE);
  assert.equal(await queue.depth(), 2);
  await queue.complete(job!._id, "w1");
  assert.equal(await queue.depth(), 1);
});

test("every visible change bumps rev and emits one event; lease renewals and lost updates don't", async () => {
  const queue = createQueue({ backoffBaseMs: 0 });
  const { job: queued } = await queue.enqueue({ ...input, maxAttempts: 2 });
  assert.equal(queued.rev, 0);

  const seen: JobEvent[] = [];
  const unsubscribe = jobEvents.subscribe(String(queued._id), (event) => seen.push(event));
  try {
    let job = await queue.claimNext("w1", LEASE);
    await queue.renewLease(job!._id, "w1", LEASE);
    await queue.saveProgress(job!._id, "w1", { done: 10, total: 200, message: "Fetched 2026/10" });
    await queue.saveProgress(job!._id, "someone-else", { done: 99 });
    await queue.fail(job!, "w1", new RetryableError("network"));
    job = await queue.claimNext("w1", LEASE);
    await queue.fail(job!, "w1", new FatalError("user_not_found", "No such player"));
  } finally {
    unsubscribe();
  }

  assert.deepEqual(
    seen.map((e) => [e.type, e.job.status, e.job.rev]),
    [
      ["progress", "running", 1],
      ["progress", "running", 2],
      ["retrying", "queued", 3],
      ["progress", "running", 4],
      ["failed", "failed", 5],
    ],
  );
  assert.deepEqual(seen[1]!.job.progress, { done: 10, total: 200, message: "Fetched 2026/10" });
  assert.deepEqual(seen[4]!.job.error, { code: "user_not_found", message: "No such player" });
  // Nothing internal leaks into what the browser will see.
  assert.equal("workerId" in seen[0]!.job, false);
  assert.equal((await Job.findById(queued._id))!.rev, 5);
  assert.equal(jobEvents.listenerCount(String(queued._id)), 0);
});
