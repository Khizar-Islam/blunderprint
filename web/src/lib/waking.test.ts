import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "./api";
import { RETRY_EVERY_MS, runWaking, wakingStateOf } from "./waking";

// The retry loop behind "Waking the server up… (12s)". Render's free API sleeps; while it wakes,
// requests fail with no answer or a bare 502/503/504 from Render's proxy.

// A task that fails with each of `errors` in turn, then answers "ok".
function failingTask(errors: unknown[]) {
  const state = { calls: 0 };
  const task = async () => {
    const err = errors[state.calls++];
    if (err !== undefined) throw err;
    return "ok";
  };
  return { task, state };
}
const noSleep = { sleep: async () => {} };

describe("runWaking", () => {
  test("an answer on the first try is returned without waiting", async () => {
    const { task, state } = failingTask([]);
    const slept: number[] = [];
    const outcome = await runWaking(task, new AbortController().signal, { sleep: async (ms) => void slept.push(ms) });
    assert.deepEqual(outcome, { kind: "done", value: "ok" });
    assert.equal(state.calls, 1);
    assert.deepEqual(slept, []);
  });

  test("a waking server (no answer, then a bare 502 and 503) is retried every 3 s until it answers", async () => {
    const { task, state } = failingTask([new ApiError(0, "Can't reach the API"), new ApiError(502, "Bad gateway"), new ApiError(503, "Unavailable")]);
    const slept: number[] = [];
    const outcome = await runWaking(task, new AbortController().signal, { sleep: async (ms) => void slept.push(ms) });
    assert.deepEqual(outcome, { kind: "done", value: "ok" });
    assert.equal(state.calls, 4);
    assert.deepEqual(slept, [RETRY_EVERY_MS, RETRY_EVERY_MS, RETRY_EVERY_MS]);
  });

  test("a 503 with one of our codes is a real answer: returned at once, not retried for a minute", async () => {
    const busy = new ApiError(503, "The coach is busy", "busy", 60_000);
    const { task, state } = failingTask([busy]);
    const outcome = await runWaking(task, new AbortController().signal, noSleep);
    assert.deepEqual(outcome, { kind: "error", error: busy });
    assert.equal(state.calls, 1);
  });

  test("a 404 after a waking error ends the retries with that error", async () => {
    const notFound = new ApiError(404, "Player not found", "player_not_found");
    const { task, state } = failingTask([new ApiError(502, "Bad gateway"), notFound]);
    const outcome = await runWaking(task, new AbortController().signal, noSleep);
    assert.deepEqual(outcome, { kind: "error", error: notFound });
    assert.equal(state.calls, 2);
  });

  test("an error that isn't the API's (a bug in the task) is shown as a generic error, not retried", async () => {
    const { task, state } = failingTask([new TypeError("x is undefined")]);
    const outcome = await runWaking(task, new AbortController().signal, noSleep);
    assert.equal(outcome.kind, "error");
    assert.ok(outcome.kind === "error" && outcome.error instanceof ApiError);
    assert.deepEqual([outcome.kind === "error" && outcome.error.status, outcome.kind === "error" && outcome.error.message], [0, "Something went wrong"]);
    assert.equal(state.calls, 1);
  });

  test("aborted while waiting between tries: no further try, outcome aborted", async () => {
    const controller = new AbortController();
    const { task, state } = failingTask([new ApiError(0, "x"), new ApiError(0, "x"), new ApiError(0, "x")]);
    let sleeps = 0;
    const outcome = await runWaking(task, controller.signal, {
      sleep: async () => {
        if (++sleeps === 2) controller.abort();
      },
    });
    assert.deepEqual(outcome, { kind: "aborted" });
    assert.equal(state.calls, 2);
  });

  test("aborted during a request: the request's own error is not reported", async () => {
    const controller = new AbortController();
    const outcome = await runWaking(
      async () => {
        controller.abort();
        throw new ApiError(404, "would be a real answer, but nobody is listening");
      },
      controller.signal,
      noSleep,
    );
    assert.deepEqual(outcome, { kind: "aborted" });
  });

  test("already aborted: the task is never called", async () => {
    const controller = new AbortController();
    controller.abort();
    const { task, state } = failingTask([]);
    assert.deepEqual(await runWaking(task, controller.signal, noSleep), { kind: "aborted" });
    assert.equal(state.calls, 0);
  });

  test("the task gets the signal, so the request itself can be cancelled", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    await runWaking(async (signal) => void (seen = signal), controller.signal, noSleep);
    assert.equal(seen, controller.signal);
  });
});

describe("wakingStateOf", () => {
  test("an answer or an error is shown as it is", () => {
    assert.deepEqual(wakingStateOf({ kind: "done", value: 7 }, false), { kind: "done", value: 7 });
    const error = new ApiError(404, "Player not found");
    assert.deepEqual(wakingStateOf({ kind: "error", error }, true), { kind: "error", error });
  });

  test("aborted by the give-up timer: \"Can't reach the API\"; aborted by unmount: nothing", () => {
    const gaveUp = wakingStateOf({ kind: "aborted" }, true);
    assert.ok(gaveUp?.kind === "error");
    assert.deepEqual([gaveUp.error.status, gaveUp.error.message], [0, "Can't reach the API"]);
    assert.equal(wakingStateOf({ kind: "aborted" }, false), null);
  });
});
