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
