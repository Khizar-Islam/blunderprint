import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { PublicRun, TraceStep } from "./api";
import { EMPTY_RUN, isFinished, reduceRun, type RunView } from "./runStream";

const step = (n: number, detail = `step ${n}`): TraceStep => ({ n, kind: "tool", label: "get_player_profile()", detail, ms: 10 });
const run = (rev: number, status: PublicRun["status"], steps: TraceStep[] = []): PublicRun => ({ id: "r1", status, rev, attempt: 1, model: "m", steps });

describe("reduceRun", () => {
  test("snapshot, then steps in order, then done", () => {
    let s: RunView = EMPTY_RUN;
    s = reduceRun(s, { type: "snapshot", rev: 3, run: run(3, "running", [step(1)]) });
    s = reduceRun(s, { type: "step", rev: 4, step: step(2) });
    s = reduceRun(s, { type: "step", rev: 5, step: step(3) });
    assert.deepEqual(s.steps.map((x) => x.n), [1, 2, 3]);
    assert.equal(s.rev, 5);
    s = reduceRun(s, { type: "done", rev: 6, run: run(6, "done", [step(1), step(2), step(3)]) });
    assert.equal(s.run!.status, "done");
    assert.ok(isFinished(s.run));
  });

  test("events at or below the current rev are old news (buffered before the snapshot, or repeated)", () => {
    let s = reduceRun(EMPTY_RUN, { type: "snapshot", rev: 5, run: run(5, "running", [step(1), step(2)]) });
    const same = reduceRun(s, { type: "step", rev: 5, step: step(9) });
    assert.equal(same, s);
    s = reduceRun(s, { type: "status", rev: 4, run: run(4, "queued") });
    assert.equal(s.run!.status, "running");
  });

  test("a step already shown is never repeated", () => {
    let s = reduceRun(EMPTY_RUN, { type: "snapshot", rev: 2, run: run(2, "running", [step(1)]) });
    s = reduceRun(s, { type: "step", rev: 3, step: step(1) });
    assert.equal(s.steps.length, 1);
    assert.equal(s.rev, 3);
  });

  test("a reconnect's snapshot replaces everything (the server's whole truth)", () => {
    let s = reduceRun(EMPTY_RUN, { type: "snapshot", rev: 2, run: run(2, "running", [step(1)]) });
    s = reduceRun(s, { type: "step", rev: 3, step: step(2) });
    s = reduceRun(s, { type: "snapshot", rev: 7, run: run(7, "running", [step(1), step(2), step(3), step(4)]) });
    assert.deepEqual(s.steps.map((x) => x.n), [1, 2, 3, 4]);
    assert.equal(s.rev, 7);
  });

  test("a restarted attempt (server restart) comes with an empty trace", () => {
    let s = reduceRun(EMPTY_RUN, { type: "snapshot", rev: 4, run: run(4, "running", [step(1), step(2)]) });
    s = reduceRun(s, { type: "status", rev: 5, run: { ...run(5, "queued"), attempt: 1 } });
    s = reduceRun(s, { type: "status", rev: 6, run: { ...run(6, "running"), attempt: 2 } });
    assert.equal(s.steps.length, 0);
    assert.equal(s.run!.attempt, 2);
  });

  test("failed carries the friendly error", () => {
    const s = reduceRun(EMPTY_RUN, { type: "failed", rev: 9, run: { ...run(9, "failed"), error: { code: "ai_unavailable", message: "The AI service didn't respond." } } });
    assert.equal(s.run!.error!.code, "ai_unavailable");
    assert.ok(isFinished(s.run));
  });
});
