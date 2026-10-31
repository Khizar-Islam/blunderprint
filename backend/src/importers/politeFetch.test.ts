import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkedResponse, jsonResponse, recordingFetch, statusResponse } from "../../scripts/fakeFetch.js";
import { RetryableError } from "../jobs/errors.js";
import { createPoliteClient, userAgent } from "./politeFetch.js";

const UA = userAgent("dev@example.com");

// A sleep that returns at once and remembers what it was asked to wait.
function fakeSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test("requests to one site never overlap, even when called concurrently", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const { fetch } = recordingFetch(async (url) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 15));
    inFlight--;
    return url.endsWith("/2") ? statusResponse(400) : jsonResponse({ ok: true });
  });
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  // One of them fails: the queue must keep going after a failure.
  const results = await Promise.allSettled([
    client.getJson("https://x.test/1"),
    client.getJson("https://x.test/2"),
    client.getJson("https://x.test/3"),
    client.getJson("https://x.test/4"),
  ]);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected", "fulfilled", "fulfilled"],
  );
});

test("every request sends the User-Agent with contact info", async () => {
  const { fetch, calls } = recordingFetch(() => jsonResponse({}));
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  await client.getJson("https://x.test/a", { headers: { "If-None-Match": 'W/"abc"' } });
  assert.equal(calls[0]!.headers["User-Agent"], "Blunderprint/1.0 (contact: dev@example.com)");
  assert.equal(calls[0]!.headers["If-None-Match"], 'W/"abc"');
});

test("Lichess-style 429: waits a full minute, then retries", async () => {
  const { waits, sleep } = fakeSleep();
  const { fetch, calls } = recordingFetch((_url, n) => (n === 0 ? statusResponse(429) : jsonResponse({ ok: 1 })));
  const client = createPoliteClient({ name: "Lichess", userAgent: UA, rateLimitWaitsMs: [60_000], fetch, sleep, now: () => 0 });
  const res = await client.getJson<{ ok: number }>("https://x.test/a");
  assert.deepEqual(res.data, { ok: 1 });
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [60_000]);
});

test("repeated 429s hand over to the job queue and block the whole site meanwhile", async () => {
  const { waits, sleep } = fakeSleep();
  const { fetch } = recordingFetch(() => statusResponse(429));
  const client = createPoliteClient({ name: "Lichess", userAgent: UA, rateLimitWaitsMs: [60_000], fetch, sleep, now: () => 0 });
  await assert.rejects(client.getJson("https://x.test/a"), (err: unknown) => {
    assert.ok(err instanceof RetryableError);
    assert.equal(err.retryAfterMs, 60_000);
    return true;
  });
  // The next request, even for another URL, waits out the block first.
  waits.length = 0;
  await client.getJson("https://x.test/b").catch(() => {});
  assert.equal(waits[0], 60_000);
});

test("a longer Retry-After header wins over our own wait", async () => {
  const { waits, sleep } = fakeSleep();
  const { fetch } = recordingFetch((_url, n) => (n === 0 ? statusResponse(429, { "retry-after": "90" }) : jsonResponse({})));
  const client = createPoliteClient({ name: "Lichess", userAgent: UA, rateLimitWaitsMs: [60_000], fetch, sleep, now: () => 0 });
  await client.getJson("https://x.test/a");
  assert.deepEqual(waits, [90_000]);
});

test("5xx and network errors are retried, then become RetryableError", async () => {
  const { waits, sleep } = fakeSleep();
  const flaky = recordingFetch((_url, n) => (n < 2 ? statusResponse(503) : jsonResponse({ ok: 1 })));
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch: flaky.fetch, sleep });
  assert.deepEqual((await client.getJson("https://x.test/a")).data, { ok: 1 });
  assert.deepEqual(waits, [1_000, 2_000]);

  const down = recordingFetch(() => Promise.reject(new TypeError("fetch failed")));
  const client2 = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch: down.fetch, sleep });
  await assert.rejects(client2.getJson("https://x.test/a"), RetryableError);
  assert.equal(down.calls.length, 3);
});

test("304 and 404 are returned to the caller, with the ETag", async () => {
  const { fetch } = recordingFetch((url) =>
    url.endsWith("/same") ? statusResponse(304, { etag: 'W/"v1"' }) : statusResponse(404),
  );
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  assert.deepEqual(await client.getJson("https://x.test/same"), { status: 304, etag: 'W/"v1"' });
  assert.equal((await client.getJson("https://x.test/missing")).status, 404);
});

test("the request timeout starts fresh after a 429 wait", async () => {
  // Real sleep longer than the timeout: if the timeout counted the wait, the retry would abort.
  const { fetch, calls } = recordingFetch((_url, n) => (n === 0 ? statusResponse(429) : jsonResponse({})));
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [80], timeoutMs: 40, fetch });
  await client.getJson("https://x.test/a");
  assert.equal(calls[1]!.signal!.aborted, false);
});

test("an aborted job signal stops the request with its own reason, not a retry", async () => {
  const controller = new AbortController();
  const reason = new Error("lease lost");
  const { fetch } = recordingFetch(() => {
    controller.abort(reason);
    return Promise.reject(new DOMException("aborted", "AbortError"));
  });
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  await assert.rejects(client.getJson("https://x.test/a", { signal: controller.signal }), (err) => err === reason);
});

test("streamLines reassembles lines (and UTF-8 characters) split across chunks", async () => {
  const bytes = new TextEncoder().encode('{"name":"Café"}\n');
  const cut = bytes.indexOf(0xc3) + 1; // split inside the two-byte "é"
  const { fetch } = recordingFetch(() =>
    chunkedResponse(['{"a":1}\n{"a"', ":2}\n\n", bytes.slice(0, cut), bytes.slice(cut), '{"a":3}']),
  );
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  const lines: unknown[] = [];
  const status = await client.streamLines("https://x.test/s", (line) => void lines.push(JSON.parse(line)));
  assert.equal(status, 200);
  assert.deepEqual(lines, [{ a: 1 }, { a: 2 }, { name: "Café" }, { a: 3 }]);
});

test("streamLines can POST a text body (Lichess export by IDs); GET is the default", async () => {
  const { fetch, calls } = recordingFetch(() => chunkedResponse(['{"id":"a"}\n']));
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  await client.streamLines("https://x.test/ids", () => {}, {
    method: "POST",
    body: "a,b,c",
    headers: { "Content-Type": "text/plain" },
  });
  await client.streamLines("https://x.test/s", () => {});
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.body, "a,b,c");
  assert.equal(calls[0]!.headers["Content-Type"], "text/plain");
  assert.equal(calls[1]!.method, "GET");
  assert.equal(calls[1]!.body, undefined);
});

test("streamLines keeps the site locked until the stream is fully read", async () => {
  const order: string[] = [];
  const { fetch } = recordingFetch((url) => (url.endsWith("/s") ? chunkedResponse(["1\n", "2\n"]) : jsonResponse({})));
  const client = createPoliteClient({ name: "Test", userAgent: UA, rateLimitWaitsMs: [1], fetch });
  const stream = client.streamLines("https://x.test/s", async (line) => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`line ${line}`);
  });
  const other = client.getJson("https://x.test/j").then(() => order.push("json"));
  await Promise.all([stream, other]);
  assert.deepEqual(order, ["line 1", "line 2", "json"]);
});
