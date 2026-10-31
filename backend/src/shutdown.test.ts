import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";
import { Job } from "./db/models/job.js";
import { createQueue } from "./jobs/queue.js";
import { startWorker, type JobHandler } from "./jobs/worker.js";
import { createShutdown } from "./shutdown.js";
import { startTestDb } from "../scripts/testDb.js";
import { openSseClient } from "../scripts/sseClient.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

test("shutdown releases the running job before closing SSE, so viewers see 'retrying', then exits 0", async () => {
  const queue = createQueue();
  const app = createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue, version: "test" });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  let started!: () => void;
  const running = new Promise<void>((resolve) => (started = resolve));
  const handler: JobHandler = {
    async run({ signal }) {
      started();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    },
  };
  const { job } = await queue.enqueue({ type: "import", key: "import:lichess:alice", payload: {} });
  const worker = startWorker({ queue, handlers: { import: handler }, pollMs: 10 });
  await running;

  const client = await openSseClient(`http://127.0.0.1:${port}/api/jobs/${String(job._id)}/stream`);
  assert.equal((await client.nextEvent())!.event, "snapshot");

  const exits: number[] = [];
  let disconnected = false;
  const shutdown = createShutdown({
    server,
    getWorker: () => worker,
    // The test DB stays up for the assertions below; just record that we got this far.
    disconnect: async () => void (disconnected = true),
    exit: (code) => void exits.push(code),
  });
  await shutdown("SIGTERM");

  // The release reached the viewer before the server ended the stream.
  const last = await client.nextEvent();
  assert.equal(last!.event, "retrying");
  assert.equal((last!.data as { status: string }).status, "queued");
  assert.equal(await client.nextEvent(), null);

  assert.deepEqual(exits, [0]);
  assert.equal(disconnected, true);
  const stored = await Job.findById(job._id).lean();
  assert.equal(stored!.status, "queued");
  assert.equal(stored!.attempts, 0);

  // A second signal while (or after) stopping does nothing.
  await shutdown("SIGINT");
  assert.deepEqual(exits, [0]);
});

test("a request that never finishes can't hold the shutdown: its connection is cut after drainMs", async () => {
  const { createServer } = await import("node:http");
  const server = createServer(() => {}); // never responds
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as { port: number }).port;
  const hanging = fetch(`http://127.0.0.1:${port}/slow`).catch((err: unknown) => err);
  await new Promise((resolve) => setTimeout(resolve, 50)); // let the request arrive

  const exits: number[] = [];
  const t0 = Date.now();
  await createShutdown({ server, getWorker: () => null, disconnect: async () => {}, drainMs: 100, exit: (c) => void exits.push(c) })(
    "SIGTERM",
  );
  const ms = Date.now() - t0;
  assert.deepEqual(exits, [0]);
  assert.ok(ms >= 100 && ms < 1_000, `took ${ms} ms`);
  assert.ok((await hanging) instanceof Error); // the client saw its connection cut
});
