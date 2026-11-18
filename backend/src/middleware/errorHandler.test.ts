import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { errorHandler, HttpError } from "./errorHandler.js";
import { startTestServer } from "../../scripts/testServer.js";

// A tiny app whose routes throw different kinds of errors.
function buildApp() {
  const app = express();
  app.get("/http-error", () => {
    throw new HttpError(422, "Username is not valid");
  });
  app.get("/sdk-error", () => {
    // Looks like an SDK error: has `status`, but no `statusCode`.
    throw Object.assign(new Error("upstream said: secret internal detail"), { status: 404 });
  });
  app.get("/crash", async () => {
    throw new Error("database password is hunter2");
  });
  app.get("/after-headers", (_req, res, next) => {
    res.status(200).write("partial");
    next(new Error("too late"));
  });
  app.use(errorHandler);
  return app;
}

test("errorHandler maps statusCode, ignores status, hides 5xx details", async (t) => {
  const server = await startTestServer(buildApp());
  t.after(() => server.close());

  await t.test("HttpError sends its 4xx and message", async () => {
    const res = await fetch(`${server.baseUrl}/http-error`);
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "Username is not valid" });
  });

  await t.test("err.status alone is treated as a 500, not passed through", async () => {
    const res = await fetch(`${server.baseUrl}/sdk-error`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Internal server error");
    assert.ok(!JSON.stringify(body).includes("secret"));
  });

  await t.test("async throw becomes a 500 with a fixed message (Express 5 forwards rejections)", async () => {
    const res = await fetch(`${server.baseUrl}/crash`);
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "Internal server error");
    assert.ok(!JSON.stringify(body).includes("hunter2"));
  });

  await t.test("error after headers were sent does not try to send JSON", async () => {
    const res = await fetch(`${server.baseUrl}/after-headers`).catch((err: Error) => err);
    // Express closes the connection: either the fetch fails, or the body is just the partial write.
    if (res instanceof Response) {
      assert.equal(res.status, 200);
      const text = await res.text().catch(() => "partial");
      assert.ok(text.startsWith("partial"));
    }
  });
});

// Express's own default handler would print the raw error (a multi-line stack, no request ID)
// with console.error. Ours logs one JSON line and cuts the connection itself.
test("an error after headers were sent is logged as one JSON line with the request ID", async (t) => {
  const printed: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => void printed.push(args.map(String).join(" ")));
  const app = express();
  app.use((_req, res, next) => {
    res.locals.requestId = "req-123";
    next();
  });
  app.get("/api/runs/:id/stream", (_req, res, next) => {
    res.status(200).write("partial");
    next(new Error("stream broke"));
  });
  app.use(errorHandler);
  const server = await startTestServer(app);
  t.after(() => server.close());

  const res = await fetch(`${server.baseUrl}/api/runs/abc/stream?token=SECRET-TOKEN`).catch((err: Error) => err);
  if (res instanceof Response) await res.text().catch(() => "");

  assert.equal(printed.length, 1, "exactly one line, and nothing from Express's default handler");
  assert.ok(!printed[0]!.includes("\n"));
  const line = JSON.parse(printed[0]!) as Record<string, unknown>;
  assert.deepEqual(
    [line.level, line.msg, line.requestId, line.path, line.error],
    ["error", "response_failed_after_headers", "req-123", "/api/runs/abc/stream", "stream broke"],
  );
  assert.ok(!printed[0]!.includes("SECRET-TOKEN"));
});
