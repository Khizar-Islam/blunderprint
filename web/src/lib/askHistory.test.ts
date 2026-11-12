import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CoachAnswer, PublicRun } from "./api";
import { EMPTY_HISTORY, isBusy, lastEntry, reduceAsk, type AskEvent, type AskHistory } from "./askHistory";

const answer = (question: string): CoachAnswer => ({
  id: "a1",
  runId: "r1",
  question,
  generatedAt: "2026-11-12T00:00:00Z",
  model: "m",
  answeredBy: "m",
  analysedGames: 20,
  outcome: "answer",
  sentences: ["You make {{a}}."],
  slots: { a: { text: "7 errors per 100 moves", kind: "per100" } },
  evidence: [],
});
const run = (id: string, status: PublicRun["status"], extra: Partial<PublicRun> = {}): PublicRun => ({ id, status, rev: 1, attempt: 1, model: "m", steps: [], ...extra });
const play = (events: AskEvent[], from: AskHistory = EMPTY_HISTORY) => events.reduce(reduceAsk, from);

describe("reduceAsk", () => {
  test("submit → accepted (token kept) → finished with the answer (token dropped)", () => {
    let h = play([{ type: "submit", question: "Q1" }]);
    assert.equal(lastEntry(h)?.status, "sending");
    assert.ok(isBusy(h));
    h = play([{ type: "accepted", id: 1, runId: "r1", token: "t1" }], h);
    assert.deepEqual([lastEntry(h)?.status, lastEntry(h)?.runId, lastEntry(h)?.token], ["streaming", "r1", "t1"]);
    h = play([{ type: "finished", id: 1, run: run("r1", "done", { answer: answer("Q1") }) }], h);
    const e = lastEntry(h)!;
    assert.equal(e.status, "done");
    assert.equal(e.answer?.question, "Q1");
    assert.equal(e.trace?.id, "r1");
    assert.equal(e.token, undefined);
    assert.ok(!isBusy(h));
  });

  test("a cached answer: done at once, with its trace", () => {
    const h = play([
      { type: "submit", question: "Q1" },
      { type: "cached", id: 1, answer: answer("Q1"), trace: null },
    ]);
    assert.deepEqual([lastEntry(h)?.status, lastEntry(h)?.cached, lastEntry(h)?.trace], ["done", true, null]);
  });

  test("one question at a time: a submit while one is on its way is ignored", () => {
    const h = play([
      { type: "submit", question: "Q1" },
      { type: "submit", question: "Q2" },
    ]);
    assert.deepEqual(h.entries.map((e) => e.question), ["Q1"]);
  });

  test("the history keeps its order, oldest first, with increasing ids", () => {
    const h = play([
      { type: "submit", question: "Q1" },
      { type: "cached", id: 1, answer: answer("Q1"), trace: null },
      { type: "submit", question: "Q2" },
      { type: "refused", id: 2, error: { code: "limit_questions", message: "m" } },
      { type: "submit", question: "Q3" },
    ]);
    assert.deepEqual(h.entries.map((e) => [e.id, e.question, e.status]), [
      [1, "Q1", "done"],
      [2, "Q2", "failed"],
      [3, "Q3", "sending"],
    ]);
  });

  test("a failed run: failed with the run's friendly error and its trace", () => {
    const h = play([
      { type: "submit", question: "Q1" },
      { type: "accepted", id: 1, runId: "r1", token: "t1" },
      { type: "finished", id: 1, run: run("r1", "failed", { error: { code: "coach_timeout", message: "took too long" } }) },
    ]);
    const e = lastEntry(h)!;
    assert.deepEqual([e.status, e.error?.code, e.trace?.id, e.token], ["failed", "coach_timeout", "r1", undefined]);
  });

  test("a finish from another run, or before the 202, is ignored", () => {
    const sending = play([{ type: "submit", question: "Q1" }]);
    assert.equal(reduceAsk(sending, { type: "finished", id: 1, run: run("r1", "done", { answer: answer("Q1") }) }), sending);
    const streaming = play([{ type: "accepted", id: 1, runId: "r1", token: "t" }], sending);
    assert.equal(reduceAsk(streaming, { type: "finished", id: 1, run: run("other", "done", { answer: answer("Q1") }) }), streaming);
    // Still running: not a finish.
    assert.equal(reduceAsk(streaming, { type: "finished", id: 1, run: run("r1", "running") }), streaming);
  });

  test("a lost stream fails the entry; retry sends the same question again, only when nothing else is on its way", () => {
    let h = play([
      { type: "submit", question: "Q1" },
      { type: "accepted", id: 1, runId: "r1", token: "t1" },
      { type: "lost", id: 1 },
    ]);
    assert.deepEqual([lastEntry(h)?.status, lastEntry(h)?.error?.code, lastEntry(h)?.token], ["failed", "stream_lost", undefined]);
    h = play([{ type: "retry", id: 1 }], h);
    assert.deepEqual(h.entries.map((e) => [e.id, e.question, e.status, e.runId]), [[1, "Q1", "sending", undefined]]);
    // Busy now: another retry or submit changes nothing.
    assert.equal(reduceAsk(h, { type: "retry", id: 1 }), h);
    assert.equal(reduceAsk(h, { type: "submit", question: "Q2" }), h);
  });

  test("events for an unknown entry change nothing", () => {
    const h = play([{ type: "submit", question: "Q1" }]);
    assert.equal(reduceAsk(h, { type: "accepted", id: 9, runId: "r", token: "t" }), h);
  });
});
