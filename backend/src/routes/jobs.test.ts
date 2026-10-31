import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { Job } from "../db/models/job.js";
import { jobEvents } from "../jobs/events.js";
import { createQueue } from "../jobs/queue.js";
import { FatalError } from "../jobs/errors.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { openSseClient } from "../../scripts/sseClient.js";
import { startTestServer } from "../../scripts/testServer.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
const queue = createQueue();
before(async () => {
  db = await startTestDb();
  server = await startTestServer(
    createApp({
      corsOrigins: [],
      trustProxyHops: 0,
      getDbStatus: () => true,
      queue,
      version: "test",
      sseHeartbeatMs: 50,
    }),
  );
});
after(async () => {
  await server.close();
  await db.stop();
});
beforeEach(clearDb);

const LEASE = 60_000;
const input = { type: "import" as const, key: "import:lichess:alice", payload: { platform: "lichess", username: "alice" } };
const streamUrl = (id: unknown) => `${server.baseUrl}/api/jobs/${String(id)}/stream`;

async function waitFor(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("bad and unknown job ids get JSON errors, not a stream", async () => {
  const bad = await fetch(streamUrl("not-an-id"));
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Invalid job id" });

  const missing = await fetch(streamUrl("0123456789abcdef01234567"));
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: "Job not found" });
  assert.equal(jobEvents.listenerCount("0123456789abcdef01234567"), 0);
});

test("a live job streams snapshot, progress and done (ids are revs), then the stream ends", async () => {
  const { job } = await queue.enqueue(input);
  const client = await openSseClient(streamUrl(job._id));
  assert.equal(client.res.status, 200);
  assert.match(client.res.headers.get("content-type")!, /^text\/event-stream/);
  assert.equal(client.res.headers.get("cache-control"), "no-cache, no-transform");

  assert.equal((await client.next())!.retry, 3000);
  const snapshot = await client.nextEvent();
  assert.equal(snapshot!.event, "snapshot");
  assert.equal(snapshot!.id, "0");
  assert.equal((snapshot!.data as { status: string }).status, "queued");

  await queue.claimNext("w1", LEASE);
  await queue.saveProgress(job._id, "w1", { done: 40, total: 200, message: "Fetched 2026/10" });
  await queue.complete(job._id, "w1");

  const events = [await client.nextEvent(), await client.nextEvent(), await client.nextEvent()];
  assert.deepEqual(
    events.map((e) => [e!.event, e!.id, (e!.data as { status: string }).status]),
    [
      ["progress", "1", "running"],
      ["progress", "2", "running"],
      ["done", "3", "done"],
    ],
  );
  assert.deepEqual((events[1]!.data as { progress: unknown }).progress, { done: 40, total: 200, message: "Fetched 2026/10" });
  // The server closed the stream after "done", and nothing is left listening.
  assert.equal(await client.nextEvent(), null);
  assert.equal(jobEvents.listenerCount(String(job._id)), 0);
});

test("a finished job sends only its snapshot and closes", async () => {
  const { job } = await queue.enqueue(input);
  await queue.claimNext("w1", LEASE);
  await queue.fail((await Job.findById(job._id))!, "w1", new FatalError("user_not_found", "No player called \"alice\""));

  const client = await openSseClient(streamUrl(job._id));
  const snapshot = await client.nextEvent();
  assert.equal(snapshot!.event, "snapshot");
  assert.deepEqual((snapshot!.data as { error: unknown }).error, { code: "user_not_found", message: "No player called \"alice\"" });
  assert.equal(await client.nextEvent(), null);
});

test("events at or below the snapshot's rev are dropped", async () => {
  const { job } = await queue.enqueue(input);
  const claimed = await queue.claimNext("w1", LEASE); // rev 1
  const client = await openSseClient(streamUrl(job._id));
  assert.equal((await client.nextEvent())!.id, "1");

  // A late, stale event (e.g. emitted out of order) must not reach the client.
  jobEvents.emit("progress", claimed!);
  await queue.complete(job._id, "w1"); // rev 2
  const next = await client.nextEvent();
  assert.equal(next!.event, "done");
  assert.equal(next!.id, "2");
  client.close();
});

test("heartbeats arrive while the job is quiet, and a client that leaves is unsubscribed", async () => {
  const { job } = await queue.enqueue(input);
  const client = await openSseClient(streamUrl(job._id));
  await client.nextEvent(); // snapshot
  assert.equal((await client.next())!.comment, "ping");
  assert.equal(jobEvents.listenerCount(String(job._id)), 1);

  client.close();
  await waitFor(() => jobEvents.listenerCount(String(job._id)) === 0);
});
