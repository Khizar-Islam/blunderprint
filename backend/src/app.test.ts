import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, type AppOptions } from "./app.js";
import { startTestServer } from "../scripts/testServer.js";

const ALLOWED = "http://localhost:3000";

// No database here: a fake queue that reports a fixed depth.
const fakeQueue = (depth = 2): AppOptions["queue"] => ({
  depth: async () => depth,
  enqueue: async () => {
    throw new Error("not used in these tests");
  },
});

function options(overrides: Partial<AppOptions> = {}): AppOptions {
  return {
    corsOrigins: [ALLOWED],
    trustProxyHops: 0,
    getDbStatus: () => true,
    queue: fakeQueue(),
    version: "9.9.9",
    ...overrides,
  };
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
    assert.deepEqual(await res.json(), { ok: true, db: true, queueDepth: 2, version: "9.9.9" });
    assert.ok(res.headers.get("x-request-id"));
  });
});

test("GET /api/health still returns 200 when the db is down", async () => {
  await withServer(options({ getDbStatus: () => false }), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: false, db: false, queueDepth: null, version: "9.9.9" });
  });
});

test("GET /api/health caches queueDepth, and a failing count reports null", async () => {
  let calls = 0;
  let failing = false;
  const queue: AppOptions["queue"] = {
    ...fakeQueue(),
    depth: async () => {
      calls++;
      if (failing) throw new Error("count timed out");
      return 7;
    },
  };
  await withServer(options({ queue, healthCacheMs: 200 }), async (baseUrl) => {
    const depth = async () => ((await (await fetch(`${baseUrl}/api/health`)).json()) as { queueDepth: number | null }).queueDepth;
    // Three requests at once share one count query.
    assert.deepEqual(await Promise.all([depth(), depth(), depth()]), [7, 7, 7]);
    assert.equal(calls, 1);

    failing = true;
    assert.equal(await depth(), 7); // still cached
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(await depth(), null);
    assert.equal(calls, 2);
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
