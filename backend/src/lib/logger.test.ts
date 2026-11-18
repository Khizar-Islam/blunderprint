import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import { createPoliteClient } from "../importers/politeFetch.js";
import type { JobDoc } from "../db/models/job.js";
import type { Queue } from "../jobs/queue.js";
import { startWorker } from "../jobs/worker.js";
import { errorMessage, logger, withLogContext } from "./logger.js";

// Collects what the logger prints (it writes one string per line to console.log / console.error).
function captureLogs(t: TestContext) {
  const raw: string[] = [];
  t.mock.method(console, "log", (line: string) => void raw.push(line));
  t.mock.method(console, "error", (line: string) => void raw.push(line));
  return {
    raw,
    lines: () => raw.map((line) => JSON.parse(line) as Record<string, unknown>),
    named: (msg: string) => raw.map((line) => JSON.parse(line) as Record<string, unknown>).filter((l) => l.msg === msg),
  };
}

test("every line is one line of JSON, even with a multi-line stack in it", (t) => {
  const logs = captureLogs(t);
  logger.error("unhandled_error", { error: "boom", stack: "Error: boom\n    at a (file.ts:1:1)\n    at b (file.ts:2:2)" });
  assert.equal(logs.raw.length, 1);
  assert.ok(!logs.raw[0]!.includes("\n"), "no raw newline in the line");
  const line = logs.lines()[0]!;
  assert.equal(line.level, "error");
  assert.equal(line.msg, "unhandled_error");
  assert.match(String(line.time), /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(String(line.stack).includes("\n"), "the stack survives, escaped inside the JSON string");
});

test("a field can't overwrite the line's own level, time or msg", (t) => {
  const logs = captureLogs(t);
  logger.info("job_started", { level: "error", time: "never", msg: "something else", jobId: "j1" });
  const line = logs.lines()[0]!;
  assert.equal(line.level, "info");
  assert.equal(line.msg, "job_started");
  assert.notEqual(line.time, "never");
  assert.equal(line.jobId, "j1");
});

test("errorMessage: an Error's message, anything else as text", () => {
  assert.equal(errorMessage(new Error("nope")), "nope");
  assert.equal(errorMessage("plain"), "plain");
  assert.equal(errorMessage(undefined), "undefined");
});

test("log context: fields reach every line logged inside, nest, and never leak out", async (t) => {
  const logs = captureLogs(t);
  logger.info("before");
  await withLogContext({ jobId: "j1" }, async () => {
    logger.info("in_job");
    await wait(1); // across an await
    await withLogContext({ runId: "r1" }, async () => {
      setTimeout(() => logger.info("in_timer"), 1); // a timer started inside keeps the context
      await wait(5);
      logger.info("in_run", { jobId: "explicit" }); // a call's own field wins
    });
    logger.info("after_run");
  });
  logger.info("after");

  const by = Object.fromEntries(logs.lines().map((l) => [l.msg, l]));
  assert.equal(by.before!.jobId, undefined);
  assert.equal(by.in_job!.jobId, "j1");
  assert.deepEqual([by.in_timer!.jobId, by.in_timer!.runId], ["j1", "r1"]);
  assert.deepEqual([by.in_run!.jobId, by.in_run!.runId], ["explicit", "r1"]);
  assert.deepEqual([by.after_run!.jobId, by.after_run!.runId], ["j1", undefined]);
  assert.equal(by.after!.jobId, undefined);
});

test("log context: two jobs running at the same time keep their own ids", async (t) => {
  const logs = captureLogs(t);
  const work = (jobId: string, ms: number) =>
    withLogContext({ jobId }, async () => {
      for (let i = 0; i < 3; i++) {
        await wait(ms);
        logger.info("tick", { expected: jobId });
      }
    });
  await Promise.all([work("a", 2), work("b", 3)]);
  const ticks = logs.named("tick");
  assert.equal(ticks.length, 6);
  for (const line of ticks) assert.equal(line.jobId, line.expected);
});

// The importers send their requests through one process-wide queue per site (a promise chain).
// A retry warning logged from inside that queue must still carry the id of the job that asked.
test("log context survives the polite client's serial queue", async (t) => {
  const logs = captureLogs(t);
  const failedOnce = new Set<string>();
  const client = createPoliteClient({
    name: "TestSite",
    userAgent: "test",
    rateLimitWaitsMs: [1],
    errorWaitsMs: [1],
    sleep: async () => {},
    fetch: async (url) => {
      await wait(2);
      if (!failedOnce.has(url)) {
        failedOnce.add(url);
        throw new Error("socket hang up");
      }
      return Response.json({ ok: true });
    },
  });
  await Promise.all(
    ["a", "b", "c"].map((jobId) => withLogContext({ jobId }, () => client.getJson(`https://example.test/${jobId}`))),
  );
  const retries = logs.named("fetch_retry");
  assert.equal(retries.length, 3);
  for (const line of retries) {
    assert.equal(line.site, "TestSite");
    assert.equal(line.error, "socket hang up");
    assert.equal(line.url, `https://example.test/${String(line.jobId)}`);
  }
});

// The worker is where the job context starts: a handler (and whatever it calls) logs without
// knowing its job id, and the line has it.
test("the worker runs each job inside its jobId context, onFailed included", async (t) => {
  const logs = captureLogs(t);
  const job = (id: string, type: string) => ({ _id: id, key: `${type}:${id}`, type, attempts: 1 }) as unknown as JobDoc;
  const pending = [job("job-1", "import"), job("job-2", "extract")];
  let finished = 0;
  const queue = {
    reapExpired: async () => ({ requeued: [], failed: [] }),
    claimNext: async () => pending.shift() ?? null,
    renewLease: async () => true,
    saveProgress: async () => true,
    complete: async () => void finished++,
    fail: async () => {
      finished++;
      return "failed";
    },
    release: async () => true,
  } as unknown as Queue;

  const worker = startWorker({
    queue,
    pollMs: 5,
    handlers: {
      import: {
        async run() {
          await wait(1);
          logger.info("from_handler");
        },
      },
      extract: {
        async run() {
          throw new Error("extract broke");
        },
        async onFailed() {
          logger.warn("from_on_failed");
        },
      },
    },
  });
  while (finished < 2) await wait(5);
  await worker.stop();

  assert.equal(logs.named("from_handler")[0]!.jobId, "job-1");
  assert.equal(logs.named("from_on_failed")[0]!.jobId, "job-2");
  const error = logs.named("job_error")[0]!;
  assert.deepEqual([error.jobId, error.error, error.outcome], ["job-2", "extract broke", "failed"]);
  // The worker's own startup line is outside any job.
  assert.equal(logs.named("worker_started")[0]!.jobId, undefined);
  // Every line the whole run printed is parseable one-line JSON with a snake_case event name.
  for (const line of logs.lines()) assert.match(String(line.msg), /^[a-z][a-z0-9_]*$/);
});

// Lines that aren't about the running job must not pick up its id. Events run their listeners
// in the context of whoever emits them, so two places opt out with withoutLogContext.
test("Mongoose connection events fired from inside a job carry no job id", async (t) => {
  const logs = captureLogs(t);
  const { default: mongoose } = await import("mongoose");
  await import("../db/connect.js"); // registers the listeners (no connection is opened)
  withLogContext({ jobId: "j1", runId: "r1" }, () => {
    logger.info("inside"); // the context is really there...
    mongoose.connection.emit("disconnected");
    mongoose.connection.emit("error", new Error("pool socket closed"));
    mongoose.connection.emit("reconnected");
  });
  assert.equal(logs.named("inside")[0]!.jobId, "j1");
  for (const name of ["mongo_disconnected", "mongo_error", "mongo_reconnected"]) {
    const line = logs.named(name)[0]!;
    assert.deepEqual([line.jobId, line.runId], [undefined, undefined], name); // ...and these lines ignore it
  }
  assert.equal(logs.named("mongo_error")[0]!.error, "pool socket closed");
});
