import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as wait } from "node:timers/promises";
import express from "express";
import { startTestServer } from "../../scripts/testServer.js";
import { requestId } from "./requestId.js";

function captureRequests(t: TestContext) {
  const lines: Array<Record<string, unknown>> = [];
  t.mock.method(console, "log", (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>));
  return () => lines.filter((l) => l.msg === "request");
}

function buildApp() {
  const app = express();
  app.use(requestId);
  app.get("/api/quick", (_req, res) => void res.json({ ok: true }));
  // Like an SSE stream: headers and a first chunk, then it stays open.
  app.get("/api/runs/:id/stream", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": hello\n\n");
  });
  return app;
}

test("a finished request logs one line: id, method, path without the query string, status, ms", async (t) => {
  const requests = captureRequests(t);
  const server = await startTestServer(buildApp());
  t.after(() => server.close());

  const res = await fetch(`${server.baseUrl}/api/quick?token=SECRET-TOKEN&x=1`);
  await res.text();
  await wait(20);

  const lines = requests();
  assert.equal(lines.length, 1, "finish and close together still log once");
  const line = lines[0]!;
  assert.equal(line.requestId, res.headers.get("x-request-id"));
  assert.deepEqual([line.method, line.path, line.status], ["GET", "/api/quick", 200]);
  assert.equal(typeof line.ms, "number");
  assert.equal(line.aborted, undefined);
  assert.ok(!JSON.stringify(line).includes("SECRET-TOKEN"), "the query string (an ask run's token) is never logged");
});

test("a stream the visitor closes still gets its line, marked aborted", async (t) => {
  const requests = captureRequests(t);
  const server = await startTestServer(buildApp());
  t.after(() => server.close());

  const controller = new AbortController();
  const res = await fetch(`${server.baseUrl}/api/runs/abc/stream?token=SECRET-TOKEN`, { signal: controller.signal });
  assert.equal(res.status, 200);
  assert.equal(requests().length, 0, "nothing logged while the stream is open");
  controller.abort(); // the visitor closes the tab
  for (let i = 0; i < 100 && requests().length === 0; i++) await wait(10);

  const lines = requests();
  assert.equal(lines.length, 1);
  assert.deepEqual([lines[0]!.path, lines[0]!.status, lines[0]!.aborted], ["/api/runs/abc/stream", 200, true]);
  assert.ok(!JSON.stringify(lines[0]).includes("SECRET-TOKEN"));
});

// A job's "done" event ends its SSE stream from inside the job's log context (the worker emits,
// the route's listener calls res.end()). The request line must still be only about the request.
test("a stream ended from inside a job's log context logs a request line without the job's id", async (t) => {
  const requests = captureRequests(t);
  const { withLogContext } = await import("../lib/logger.js");
  const { EventEmitter } = await import("node:events");
  const bus = new EventEmitter();
  const app = express();
  app.use(requestId);
  app.get("/api/jobs/:id/stream", (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(": hello\n\n");
    bus.once("done", () => res.end());
  });
  const server = await startTestServer(app);
  t.after(() => server.close());

  const res = await fetch(`${server.baseUrl}/api/jobs/abc/stream`);
  withLogContext({ jobId: "job-9", runId: "run-9" }, () => bus.emit("done")); // the worker, inside its job
  await res.text();
  for (let i = 0; i < 100 && requests().length === 0; i++) await wait(10);

  const line = requests()[0]!;
  assert.deepEqual([line.path, line.status, line.aborted], ["/api/jobs/abc/stream", 200, undefined]);
  assert.deepEqual([line.jobId, line.runId], [undefined, undefined]);
});
