import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppOptions } from "./app.js";
import { startTestServer } from "../scripts/testServer.js";

const ALLOWED = "http://localhost:3000";

function options(overrides: Partial<AppOptions> = {}): AppOptions {
  return { corsOrigins: [ALLOWED], trustProxyHops: 0, getDbStatus: () => true, version: "9.9.9", ...overrides };
}

async function withServer(opts: AppOptions, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = await startTestServer(createApp(opts));
  try {
    await fn(server.baseUrl);
  } finally {
    await server.close();
  }
}

test("GET /api/health reports db up", async () => {
  await withServer(options(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, db: true, queueDepth: 0, version: "9.9.9" });
    assert.ok(res.headers.get("x-request-id"));
  });
});

test("GET /api/health still returns 200 when the db is down", async () => {
  await withServer(options({ getDbStatus: () => false }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, db: false, queueDepth: 0, version: "9.9.9" });
  });
});

test("unknown /api routes return 404 JSON", async () => {
  await withServer(options(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/nope/deeper`);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "Not found" });
  });
});

test("invalid JSON body gets a fixed 400 message", async () => {
  await withServer(options(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/anything`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "Request body is not valid JSON" });
  });
});

test("body over the size limit gets 413", async () => {
  await withServer(options(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/anything`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(200 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.deepEqual(await res.json(), { error: "Request body is too large" });
  });
});

test("allowed origin gets CORS headers, other origins do not", async () => {
  await withServer(options(), async (baseUrl) => {
    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { Origin: ALLOWED } });
    assert.equal(allowed.headers.get("access-control-allow-origin"), ALLOWED);

    const blocked = await fetch(`${baseUrl}/api/health`, { headers: { Origin: "https://evil.example.com" } });
    assert.equal(blocked.headers.get("access-control-allow-origin"), null);
  });
});

test("trust proxy is set from the configured hops", () => {
  assert.equal(createApp(options({ trustProxyHops: 3 })).get("trust proxy"), 3);
  assert.equal(createApp(options()).get("trust proxy"), 0);
});
