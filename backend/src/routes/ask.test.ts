import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { standardCoachGames } from "../../scripts/coachFixture.js";
import { openSseClient, type SseMessage } from "../../scripts/sseClient.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { testGuards } from "../../scripts/testGuards.js";
import { startTestServer } from "../../scripts/testServer.js";
import { ASK_PROMPT_VERSION, questionKey } from "../agent/ask.js";
import { analysedBasis } from "../agent/basis.js";
import { pacificDay } from "../agent/budget.js";
import { createCoachRuntime, type CoachRuntime } from "../agent/coach.js";
import { createCreditGate, type CreditGate } from "../agent/credit.js";
import { ModelError as CreditModelError } from "../agent/model.js";
import type { Model } from "../agent/model.js";
import { hashToken, tokenMatches } from "../agent/runTokens.js";
import { SUGGESTED_QUESTIONS } from "../agent/suggestions.js";
import { createScriptedModel } from "../agent/scriptedModel.js";
import { createApp } from "../app.js";
import { AgentRun, MAX_RUN_TOKENS } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Job, type JobDoc } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { Usage } from "../db/models/usage.js";
import { saveAnswer } from "../agent/answerStore.js";
import { askJobKey, createAskHandler, startAskRun, type AskHandlerOptions } from "../jobs/handlers/ask.js";
import { createReportHandler } from "../jobs/handlers/report.js";
import { createQueue, type Queue } from "../jobs/queue.js";
import { createJobSystem } from "../jobs/setup.js";
import { startWorker, type Worker } from "../jobs/worker.js";
import type { Guards } from "../lib/guards.js";

// "Ask the coach" end to end (Stage 6 chunk B), with no AI calls: POST /ask, the ask job on the
// coach lane with the scripted model, the real tools and verifier, the answer cache, the run
// stream and its secret tokens, and the guards.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await current?.stop();
  await db.stop();
});

let aliceId: Types.ObjectId;
beforeEach(async () => {
  await current?.stop();
  current = null;
  await clearDb();
  const alice = await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });
  await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" });
  aliceId = alice._id;
  await Game.insertMany(standardCoachGames(alice._id));
});

const ENV = {
  AI_ENABLED: true,
  AI_DAILY_CALL_BUDGET: 400,
  GEMINI_API_KEY: undefined,
  GEMINI_MODEL: "unused",
  GEMINI_RPM: 600_000,
  GEMINI_TPM: 1_000_000_000,
  COACH_MODEL: "gemini" as const,
  COACH_SCRIPTED_SCENARIO: "ok" as const,
  COACH_MAX_MODEL_CALLS: 10,
  COACH_MAX_REPAIR_CALLS: 2,
  COACH_MAX_REQUESTS: 16,
  GEMINI_FALLBACK_MODEL: "none",
  COACH_MAX_TOKENS: 120_000,
  COACH_CALL_TIMEOUT_MS: 10_000,
  COACH_RUN_TIMEOUT_MS: 20_000,
  COACH_MIN_BASELINE_GAP: 0.15,
  COACH_MIN_CANDIDATE_GAMES: 5,
  COACH_MIN_CANDIDATE_MOVES: 100,
  COACH_MIN_ANALYSED_GAMES: 10,
  ASK_MAX_MODEL_CALLS: 6,
  ASK_MAX_REPAIR_CALLS: 1,
  ASK_MAX_REQUESTS: 10,
  ASK_RUN_TIMEOUT_MS: 20_000,
};

interface Setup {
  base: string;
  coach: CoachRuntime;
  queue: Queue;
  startLane(coach?: CoachRuntime): Worker;
  stop(): Promise<void>;
}

let current: Setup | null = null;
async function setup({
  env = {},
  model,
  worker = true,
  guards,
  queue = createQueue(),
  handler,
  credit,
}: { env?: Partial<typeof ENV>; model?: Model; worker?: boolean; guards?: Guards; handler?: AskHandlerOptions; credit?: CreditGate; queue?: Pick<Queue, "enqueue" | "depth"> & Partial<Queue> } = {}): Promise<Setup> {
  const coach = createCoachRuntime({ ...ENV, ...env }, { model: model ?? createScriptedModel({ delayMs: 10 }), ...(credit ? { credit } : {}) });
  const server = await startTestServer(
    createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue, version: "test", coach, sseHeartbeatMs: 1_000, guards }),
  );
  const workers: Worker[] = [];
  // A lane with another runtime stands for "the next process" after a shutdown.
  const startLane = (laneCoach: CoachRuntime = coach) => {
    const w = startWorker({
      queue: queue as Queue,
      handlers: { report: createReportHandler(laneCoach), ask: createAskHandler(laneCoach, handler) },
      claimFilter: { type: { $in: ["report", "ask"] } },
      pollMs: 10,
    });
    workers.push(w);
    return w;
  };
  if (worker) startLane();
  current = {
    base: `${server.baseUrl}/api`,
    coach,
    queue: queue as Queue,
    startLane,
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
      await server.close();
    },
  };
  return current;
}

const askUrl = (s: Setup, user = "alice") => `${s.base}/players/lichess/${user}/ask`;
const ask = (s: Setup, question: unknown, user = "alice") =>
  fetch(askUrl(s, user), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question }) });
const QUESTION = "Why do I blunder in the endgame?";

async function accepted(res: Response): Promise<{ runId: string; token: string }> {
  assert.equal(res.status, 202, await res.clone().text());
  const body = (await res.json()) as { runId: string; token: string };
  assert.match(body.runId, /^[0-9a-f]{24}$/);
  assert.match(body.token, /^[0-9a-f-]{36}$/);
  return body;
}

const streamUrl = (s: Setup, runId: string, token?: string) => `${s.base}/runs/${runId}/stream${token === undefined ? "" : `?token=${encodeURIComponent(token)}`}`;

// The worker marks a job done or failed just AFTER its handler returns, so just after the run's
// last stream event. A test that goes on at once could still find the job "running": reading it,
// or asking the route for the next report (an active job means "202, the same run"). On a slow
// machine (CI) that happened, so a finished stream waits here until the run's job has settled.
async function jobSettled(runId: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (!(await Job.exists({ "payload.runId": runId, status: { $in: ["queued", "running"] } }))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`the job of run ${runId} never finished`);
}
const ended = (m: SseMessage | undefined) => m?.event === "done" || m?.event === "failed";

// Every event of a run's stream, until the server ends it (and, after done or failed, until the
// run's job has settled).
async function streamAll(url: string, timeoutMs = 10_000): Promise<SseMessage[]> {
  const client = await openSseClient(url);
  const events: SseMessage[] = [];
  for (;;) {
    const m = await client.nextEvent(timeoutMs);
    if (!m) break;
    events.push(m);
  }
  const runId = /\/runs\/([0-9a-f]{24})\/stream/.exec(url)?.[1];
  if (runId && ended(events.at(-1))) await jobSettled(runId);
  return events;
}

const today = () => `global:ai|${pacificDay(new Date())}`;

describe("POST /ask end to end", () => {
  it("202 { runId, token } → the stream (with the token) ends with the answer → the same question again is cached, free", async () => {
    const s = await setup({ guards: testGuards() });
    const { runId, token } = await accepted(await ask(s, QUESTION));

    const events = await streamAll(streamUrl(s, runId, token));
    assert.equal(events[0]!.event, "snapshot");
    assert.equal((events[0]!.data as { kind: string }).kind, "ask");
    assert.equal((events[0]!.data as { question: string }).question, QUESTION);
    const last = events.at(-1)!;
    assert.equal(last.event, "done");
    const run = last.data as { status: string; answer: { outcome: string; sentences: string[]; slots: Record<string, { text: string; kind: string }>; evidence: { fen: string; playedUci: string | null; ribbon: string | null }[]; question: string; runId: string } };
    assert.equal(run.status, "done");
    assert.equal(run.answer.outcome, "answer");
    assert.equal(run.answer.runId, runId);
    assert.equal(run.answer.sentences.length, 2);
    // The figure was written by code from the profile, with its unit, and only text + kind go out.
    assert.deepEqual(run.answer.slots, { a: { text: "7 errors per 100 moves", kind: "per100" } });
    assert.ok(run.answer.evidence.length >= 2);
    assert.equal(run.answer.evidence[0]!.playedUci, "g1f3");
    assert.ok(run.answer.evidence[0]!.ribbon);
    // Never the token hashes.
    for (const e of events) assert.ok(!JSON.stringify(e.data ?? {}).includes("tokenHashes"));

    // The same question in other words of case/spacing: the cached answer, no new run, no count.
    const again = await ask(s, "  why do I blunder in the ENDGAME ");
    assert.equal(again.status, 200);
    const body = (await again.json()) as { cached: boolean; answer: { id: string; question: string }; trace: { id: string; kind: string; status: string; steps: unknown[]; question: string } | null };
    assert.equal(body.cached, true);
    assert.equal(body.answer.question, QUESTION);
    // The run that wrote it comes along ("How this answer was made"), with no token needed.
    assert.ok(body.trace);
    assert.equal(body.trace.id, runId);
    assert.equal(body.trace.kind, "ask");
    assert.equal(body.trace.status, "done");
    assert.ok(body.trace.steps.length > 0);
    assert.equal(body.trace.question, QUESTION);
    assert.ok(!JSON.stringify(body).includes("tokenHashes"));
    assert.ok(!JSON.stringify(body).includes(token));
    assert.equal(await AgentRun.countDocuments(), 1);
    assert.equal(await Answer.countDocuments(), 1);
    const asks = await Usage.find({ _id: /\|asks\|/ }).lean();
    assert.deepEqual(asks.map((u) => u.count), [1, 1]); // the hour and the day: one question started
  });

  it("a cached answer whose run has expired comes with trace: null", async () => {
    const s = await setup();
    const { runId, token } = await accepted(await ask(s, QUESTION));
    await streamAll(streamUrl(s, runId, token));
    await AgentRun.deleteOne({ _id: runId }); // what the 14-day TTL does
    const res = await ask(s, QUESTION);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { cached: boolean; trace: unknown; answer: { runId: string } };
    assert.equal(body.cached, true);
    assert.equal(body.trace, null);
    assert.equal(body.answer.runId, runId);
  });

  it("GET report lists the suggested questions; one is marked answered once its answer is cached", async () => {
    const s = await setup();
    const reportUrl = `${s.base}/players/lichess/alice/report`;
    type Info = { ask: { suggestions: { question: string; answered: boolean }[] } };
    const before = (await (await fetch(reportUrl)).json()) as Info;
    assert.deepEqual(before.ask.suggestions, SUGGESTED_QUESTIONS.map((question) => ({ question, answered: false })));

    // Asked in other case/spacing: the same cache key.
    const { runId, token } = await accepted(await ask(s, ` ${SUGGESTED_QUESTIONS[1].toUpperCase()}`));
    await streamAll(streamUrl(s, runId, token));
    const after = (await (await fetch(reportUrl)).json()) as Info;
    assert.deepEqual(after.ask.suggestions.map((x) => x.answered), [false, true, false]);

    // Another model's answer doesn't count (the model is part of the cache key)...
    await Answer.updateMany({}, { $set: { model: "another-model" } });
    assert.deepEqual(((await (await fetch(reportUrl)).json()) as Info).ask.suggestions.map((x) => x.answered), [false, false, false]);
    // ...and neither does an answer from an older prompt version.
    await Answer.updateMany({}, { $set: { model: s.coach.modelName, promptVersion: ASK_PROMPT_VERSION - 1 } });
    assert.deepEqual(((await (await fetch(reportUrl)).json()) as Info).ask.suggestions.map((x) => x.answered), [false, false, false]);
  });

  it("the answer is stored under the cache key, with a 30-day expiry and nothing secret", async () => {
    const s = await setup();
    const { runId, token } = await accepted(await ask(s, QUESTION));
    await streamAll(streamUrl(s, runId, token));
    const { hash } = await analysedBasis(aliceId);
    const doc = await Answer.findOne({ playerId: aliceId, questionKey: questionKey(QUESTION), analysedGamesHash: hash, promptVersion: ASK_PROMPT_VERSION, model: s.coach.modelName }).lean();
    assert.ok(doc);
    const days = (doc.expiresAt!.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29 && days <= 30, String(days));
    assert.ok(!JSON.stringify(doc).includes(token));
  });
});

describe("ask run tokens", () => {
  // The token with its last character changed. Not simply "replace it with 0": one token in 16
  // already ends in 0, and the "wrong" token was then the right one (the test failed 1 run in 16).
  const wrongLastChar = (token: string) => token.replace(/.$/, (c) => (c === "0" ? "1" : "0"));
  it("only the token's hash is stored; streaming needs one of the run's tokens (missing or wrong → 404 run_not_found)", async () => {
    const s = await setup({ worker: false });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const run = await AgentRun.findById(runId).lean();
    assert.deepEqual(run!.tokenHashes, [hashToken(token)]);
    assert.ok(!JSON.stringify(run).includes(token));

    for (const url of [streamUrl(s, runId), streamUrl(s, runId, "wrong"), streamUrl(s, runId, wrongLastChar(token)), streamUrl(s, runId, "")]) {
      const res = await fetch(url);
      assert.equal(res.status, 404, url);
      assert.deepEqual(await res.json(), { error: "That coach run has expired or doesn't exist.", code: "run_not_found" });
    }
    const client = await openSseClient(streamUrl(s, runId, token));
    const snap = await client.nextEvent();
    assert.equal(snap!.event, "snapshot");
    assert.equal((snap!.data as { status: string }).status, "queued");
    await client.close();
  });

  it("a report run still streams without a token", async () => {
    const s = await setup({ worker: false });
    const run = await AgentRun.create({ playerId: aliceId, model: s.coach.modelName, promptVersion: 6 });
    const client = await openSseClient(streamUrl(s, String(run._id)));
    assert.equal((await client.nextEvent())!.event, "snapshot");
    await client.close();
  });

  it("two visitors asking the same question share one run, each with their own token, and both streams get the answer", async () => {
    const s = await setup({ worker: false, guards: testGuards() });
    const a = await accepted(await ask(s, QUESTION));
    const b = await accepted(await ask(s, "why do i blunder in the endgame"));
    assert.equal(b.runId, a.runId);
    assert.notEqual(b.token, a.token);
    const run = await AgentRun.findById(a.runId).lean();
    assert.deepEqual(run!.tokenHashes, [hashToken(a.token), hashToken(b.token)]);
    // Joining is free: one question counted.
    const asks = await Usage.find({ _id: /\|asks\|/ }).lean();
    assert.deepEqual(asks.map((u) => u.count), [1, 1]);

    const both = Promise.all([streamAll(streamUrl(s, a.runId, a.token)), streamAll(streamUrl(s, b.runId, b.token))]);
    s.startLane();
    for (const events of await both) {
      assert.equal(events.at(-1)!.event, "done");
      assert.equal((events.at(-1)!.data as { answer: { outcome: string } }).answer.outcome, "answer");
    }
  });

  it(`at most ${MAX_RUN_TOKENS} tokens per run: the next joiner gets 503 busy`, async () => {
    const s = await setup({ worker: false });
    const first = await accepted(await ask(s, QUESTION));
    for (let i = 1; i < MAX_RUN_TOKENS; i++) assert.equal((await accepted(await ask(s, QUESTION))).runId, first.runId);
    const refused = await ask(s, QUESTION);
    assert.equal(refused.status, 503);
    assert.equal(refused.headers.get("retry-after"), "60");
    const body = (await refused.json()) as { code: string; error: string };
    assert.equal(body.code, "busy");
    assert.match(body.error, /coach has a lot of questions waiting/);
    const run = await AgentRun.findById(first.runId).lean();
    assert.equal(run!.tokenHashes!.length, MAX_RUN_TOKENS);
  });

  it("joining fails because the run JUST finished: the answer it saved is served (200 cached), not busy", async () => {
    const s = await setup({ worker: false });
    const first = await accepted(await ask(s, QUESTION));
    // The run finishes and saves its answer; its job still looks active to this request (the
    // race: the job is marked done a moment after the answer is saved).
    await AgentRun.updateOne({ _id: first.runId }, { $set: { status: "done" } });
    const { hash } = await analysedBasis(aliceId);
    await Answer.create({
      playerId: aliceId,
      questionKey: questionKey(QUESTION),
      question: QUESTION,
      analysedGamesHash: hash,
      promptVersion: ASK_PROMPT_VERSION,
      model: s.coach.modelName,
      runId: new Types.ObjectId(first.runId),
      outcome: "answer",
      sentences: ["Just answered."],
      analysedGames: 10,
    });
    // The route's FIRST cache lookup happened before the save: make it miss once.
    const original = Answer.findOne.bind(Answer);
    let calls = 0;
    const m = mock.method(Answer, "findOne", (...args: Parameters<typeof Answer.findOne>) => (++calls === 1 ? original({ _id: new Types.ObjectId() }) : original(...args)));
    try {
      const res = await ask(s, QUESTION);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { cached: boolean; answer: { sentences: string[] } };
      assert.equal(body.cached, true);
      assert.deepEqual(body.answer.sentences, ["Just answered."]);
      assert.equal(calls, 2);
    } finally {
      m.mock.restore();
    }
  });

  it("tokenMatches: any of the hashes, nothing for junk", () => {
    const hashes = [hashToken("one"), hashToken("two")];
    assert.equal(tokenMatches(hashes, "two"), true);
    assert.equal(tokenMatches(hashes, "three"), false);
    for (const junk of [undefined, null, "", ["two"], 2, "x".repeat(101)]) assert.equal(tokenMatches(hashes, junk), false);
    assert.equal(tokenMatches([], "one"), false);
    assert.equal(tokenMatches(undefined, "one"), false);
  });
});

describe("POST /ask: the checks, in order", () => {
  it("400 for a bad body, 404 for an unknown player, 409 under the minimum games", async () => {
    const s = await setup({ worker: false });
    const none = await fetch(askUrl(s), { method: "POST" });
    assert.equal(none.status, 400);
    for (const body of [{}, { question: "hi" }, { question: "x".repeat(301) }, { question: "why\u0000 this?" }, { question: QUESTION, extra: 1 }, { question: 42 }]) {
      const res = await fetch(askUrl(s), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.deepEqual(await res.json(), { error: "Invalid question" });
    }
    const nobody = await ask(s, QUESTION, "nobody");
    assert.equal(nobody.status, 404);
    assert.equal(((await nobody.json()) as { code: string }).code, "player_not_found");
    const bob = await ask(s, QUESTION, "bob");
    assert.equal(bob.status, 409);
    assert.equal(((await bob.json()) as { code: string }).code, "not_enough_games");
    assert.equal(await AgentRun.countDocuments(), 0);
  });

  it("kill switch: 503 ai_disabled, but a cached answer is still served", async () => {
    const s = await setup({ env: { AI_ENABLED: false }, worker: false });
    const res = await ask(s, QUESTION);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { code: string }).code, "ai_disabled");

    const { hash } = await analysedBasis(aliceId);
    await Answer.create({
      playerId: aliceId,
      questionKey: questionKey(QUESTION),
      question: QUESTION,
      analysedGamesHash: hash,
      promptVersion: ASK_PROMPT_VERSION,
      model: s.coach.modelName,
      runId: new Types.ObjectId(),
      outcome: "cannot_answer",
      reason: "too_few_games",
      analysedGames: 10,
    });
    const cached = await ask(s, QUESTION);
    assert.equal(cached.status, 200);
    const body = (await cached.json()) as { cached: boolean; answer: { outcome: string; reason: string; message: string } };
    assert.equal(body.cached, true);
    assert.equal(body.answer.reason, "too_few_games");
    assert.match(body.answer.message, /aren't enough of your analysed games/);
  });

  it("budget under one worst-case question (ASK_MAX_REQUESTS, 10): 429 with Retry-After, nothing started", async () => {
    const s = await setup({ worker: false });
    await Usage.create({ _id: today(), count: 400 - 9, expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await ask(s, QUESTION);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.equal(((await res.json()) as { code: string }).code, "ai_budget_exhausted");
    assert.equal(await AgentRun.countDocuments(), 0);
    // Exactly enough for one question is enough.
    await Usage.updateOne({ _id: today() }, { $set: { count: 400 - 10 } });
    await accepted(await ask(s, QUESTION));
  });

  it(`a full coach queue: 503 busy before the visitor's limit, so it doesn't use up a question`, async () => {
    const s = await setup({ worker: false, guards: testGuards({ coachQueueMax: 1 }) });
    await Job.create({ type: "report", key: "report:x:y", payload: {}, runAfter: new Date() });
    const res = await ask(s, QUESTION);
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(((await res.json()) as { code: string }).code, "busy");
    assert.equal(await Usage.countDocuments({ _id: /\|asks\|/ }), 0);
    assert.equal(await AgentRun.countDocuments(), 0);
  });

  it("per visitor: only a question that starts a run counts; past LIMIT_ASKS_PER_HOUR → 429 limit_questions + Retry-After", async () => {
    const s = await setup({ worker: false, guards: testGuards({ asksPerHour: 2, asksPerDay: 20 }) });
    await accepted(await ask(s, "Why do I blunder in the endgame?"));
    await accepted(await ask(s, "why do i blunder in the endgame")); // joined: free
    await accepted(await ask(s, "How is my opening play?"));
    const refused = await ask(s, "What about my time use?");
    assert.equal(refused.status, 429);
    const retryAfter = Number(refused.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 3600, String(retryAfter));
    const body = (await refused.json()) as { code: string; error: string };
    assert.equal(body.code, "limit_questions");
    assert.match(body.error, /You can ask another in/);
    assert.equal(await AgentRun.countDocuments(), 2);
    // Stored under the visitor's hash, never the IP.
    const ids = (await Usage.find({ _id: /\|asks\|/ }, { _id: 1 }).lean()).map((d) => String(d._id));
    assert.ok(ids.every((id) => /^ip:[0-9a-f]{32}\|asks\|/.test(id)), ids.join());
  });

  it("the enqueue fails: the visitor's count is given back and no run is left behind", async () => {
    const queue = createQueue();
    const failing = { ...queue, enqueue: async () => Promise.reject(new Error("db down")) };
    const s = await setup({ worker: false, guards: testGuards(), queue: failing });
    const res = await ask(s, QUESTION);
    assert.equal(res.status, 500);
    const asks = await Usage.find({ _id: /\|asks\|/ }).lean();
    assert.deepEqual(asks.map((u) => u.count), [0, 0]);
    assert.equal(await AgentRun.countDocuments(), 0);
  });
});

// The ask job's failure rules (jobs/handlers/ask.ts), the same ones the report job has: a paid
// run is never repeated because of our own side, and a run never stays "running" for ever.
describe("the ask job: shutdown, lost leases and failed saves", () => {
  // Counts the model's calls, so a test can prove the AI wasn't asked twice.
  const counting = (inner: Model) => {
    const counter = { calls: 0 };
    const model: Model = { name: inner.name, call: (req) => (counter.calls++, inner.call(req)) };
    return { model, counter };
  };
  const askJob = async () => (await Job.findOne({ type: "ask" }).lean())!;
  // The worker marks the job done or failed AFTER the handler has returned, so after the run's
  // last stream event: wait for it instead of reading the job at once.
  const finishedJob = async () => {
    for (let i = 0; i < 300; i++) {
      const job = await askJob();
      if (job.status === "done" || job.status === "failed") return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the ask job never finished");
  };

  it("shutdown mid-run: the run goes back to queued with the attempt refunded, and the next worker answers it from scratch", async () => {
    let started!: () => void;
    const hanging = new Promise<void>((r) => (started = r));
    // A model call that never answers until it is aborted: the run is "in the middle" for sure.
    const stuck: Model = {
      name: "scripted",
      call: (req) =>
        new Promise((_, reject) => {
          started();
          req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
        }),
    };
    const s = await setup({ model: stuck, worker: false });
    const lane = s.startLane();
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const client = await openSseClient(streamUrl(s, runId, token));
    await hanging;
    await lane.stop();

    assert.equal((await AgentRun.findById(runId).lean())!.status, "queued");
    const job = await askJob();
    assert.deepEqual([job.status, job.attempts], ["queued", 0], "released, the attempt refunded");
    assert.equal(await Answer.countDocuments(), 0);
    // The viewer saw the run go back to the queue.
    let m: SseMessage | null;
    do m = await client.nextEvent(); while (m && !(m.event === "status" && (m.data as { status: string }).status === "queued"));
    assert.ok(m, "a status: queued event");

    // The next process (a new worker with a working model) picks it up; the visitor's token still works.
    s.startLane(createCoachRuntime(ENV, { model: createScriptedModel({ delayMs: 0 }) }));
    do m = await client.nextEvent(10_000); while (m && m.event !== "done" && m.event !== "failed");
    assert.equal(m!.event, "done");
    const done = m!.data as { attempt: number; answer: { outcome: string } };
    assert.equal(done.attempt, 1);
    assert.equal(done.answer.outcome, "answer");
    client.close();
  });

  it("a job the reaper gives up on fails its run with coach_interrupted; any other final failure with internal", async () => {
    const s = await setup({ worker: false });
    const handler = createAskHandler(s.coach);
    const first = await accepted(await ask(s, QUESTION));
    const job = (await Job.findOne({ type: "ask" })) as JobDoc;
    job.error = { code: "lease_expired", message: "x" };
    await handler.onFailed!(job);
    const run = (await AgentRun.findById(first.runId).lean())!;
    assert.equal(run.status, "failed");
    assert.equal(run.error!.code, "coach_interrupted");

    await Job.deleteMany({});
    const second = await accepted(await ask(s, "Do I play worse with Black?"));
    const other = (await Job.findOne({ type: "ask" })) as JobDoc;
    other.error = { code: "handler_crashed", message: "SECRET stack" };
    await handler.onFailed!(other);
    const failed = (await AgentRun.findById(second.runId).lean())!;
    assert.deepEqual(failed.error, { code: "internal", message: "Something went wrong on our side." });
  });

  // A failed save after a good run must never run the AI again: only the save is retried.
  it("the save fails twice, then succeeds: the answer is served, with exactly one agent run", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    let saves = 0;
    const s = await setup({
      model,
      handler: {
        saveRetryDelaysMs: [5, 5],
        save: async (input) => {
          if (++saves <= 2) throw new Error("Atlas write timed out");
          return saveAnswer(input);
        },
      },
    });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const last = (await streamAll(streamUrl(s, runId, token))).at(-1)!;
    assert.equal(last.event, "done");
    assert.equal(saves, 3);
    // One run's calls, made once: the model wasn't asked again for the retried saves.
    assert.ok(counter.calls > 0);
    assert.equal((last.data as { usage: { calls: number } }).usage.calls, counter.calls);
    const job = await finishedJob();
    assert.deepEqual([job.status, job.attempts], ["done", 1]);
    assert.equal(await Answer.countDocuments({ playerId: aliceId }), 1);
  });

  it("the save always fails: the run fails with internal, the job is not retried, the AI is not asked again", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    let saves = 0;
    const s = await setup({
      model,
      handler: {
        saveRetryDelaysMs: [5, 5],
        save: async () => {
          saves++;
          throw new Error("SECRET Atlas write timed out");
        },
      },
    });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const events = await streamAll(streamUrl(s, runId, token));
    const last = events.at(-1)!;
    assert.equal(last.event, "failed");
    assert.deepEqual((last.data as { error: unknown }).error, { code: "internal", message: "Something went wrong on our side." });
    assert.ok(!JSON.stringify(events).includes("SECRET"), "the real error never reaches the visitor");
    assert.equal(saves, 3);
    const callsOfOneRun = counter.calls;
    const job = await finishedJob();
    assert.deepEqual([job.status, job.attempts], ["failed", 1]);
    // Give the worker a moment: a retried job would be queued again and start a second run.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await askJob()).status, "failed");
    assert.equal(counter.calls, callsOfOneRun, "no second run");
    assert.equal(await Answer.countDocuments(), 0);
  });

  it("the answer was saved while the job waited in the queue: the run is done from the cache, with no AI call", async () => {
    // First visitor: a normal run that saves the answer.
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    const s = await setup({ model, worker: false });
    const lane = s.startLane();
    const first = await accepted(await ask(s, QUESTION));
    await streamAll(streamUrl(s, first.runId, first.token));
    await lane.stop();
    const callsOfFirstRun = counter.calls;

    // A second run for the same question, queued by hand (the route would have served the cache).
    const started = await startAskRun(s.queue, aliceId, s.coach.modelName, QUESTION);
    assert.equal(started.created, true);
    s.startLane();
    const token = (started as { token: string }).token;
    const last = (await streamAll(streamUrl(s, started.runId, token))).at(-1)!;
    assert.equal(last.event, "done");
    const run = last.data as { usage: { calls: number }; answer: { id: string } };
    assert.equal(run.usage.calls, 0);
    assert.equal(counter.calls, callsOfFirstRun, "the model wasn't called");
    assert.equal(run.answer.id, String((await Answer.findOne().lean())!._id));
  });

  it("the player was deleted while the job waited: the run fails with player_not_found, no AI call", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    const s = await setup({ model, worker: false });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    await Player.deleteOne({ _id: aliceId });
    s.startLane();
    const last = (await streamAll(streamUrl(s, runId, token))).at(-1)!;
    assert.equal(last.event, "failed");
    assert.equal((last.data as { error: { code: string } }).error.code, "player_not_found");
    assert.equal(counter.calls, 0);
  });
});

describe("startAskRun", () => {
  it("the same question already queued: our run is deleted and the caller gets the existing run, with no token", async () => {
    const queue = createQueue();
    const first = await startAskRun(queue, aliceId, "m", QUESTION);
    assert.equal(first.created, true);
    // Same question after cleaning (case, spaces, the trailing "?"): the same job key.
    const second = await startAskRun(queue, aliceId, "m", "why do I blunder in the  endgame");
    assert.deepEqual(second, { runId: first.runId, created: false });
    assert.equal(await AgentRun.countDocuments(), 1);
    assert.equal(await Job.countDocuments({ key: askJobKey("m", aliceId, questionKey(QUESTION)) }), 1);
    // Only the first caller's token hash is on the run: a joiner gets their own from the route.
    assert.equal((await AgentRun.findById(first.runId).lean())!.tokenHashes!.length, 1);
  });

  it("the enqueue throws: the run it created (holding a token hash) is deleted and the error is passed on", async () => {
    const failing = { enqueue: async () => Promise.reject(new Error("db down")) };
    await assert.rejects(startAskRun(failing, aliceId, "m", QUESTION), /db down/);
    assert.equal(await AgentRun.countDocuments(), 0);
  });
});

describe("the production coach lane", () => {
  it("takes report AND ask jobs for this process's model", () => {
    const { lanes, handlers, coach } = createJobSystem({ ...ENV, CONTACT_EMAIL: "test@example.com", MAX_GAMES_PER_PLAYER: 200 });
    assert.deepEqual(lanes.coach, { type: { $in: ["report", "ask"] }, "payload.model": coach.modelName });
    assert.ok(handlers.ask);
  });
});

describe("out of AI credit (HTTP 402)", () => {
  const broke = () =>
    createScriptedModel({ delayMs: 5, failFirst: Infinity, failWith: () => new CreditModelError("out_of_credit", "Gemini 402: Your prepayment credits are depleted.", { status: 402 }) });
  const askCounters = async () => (await Usage.find({ _id: /\|asks\|/ }).lean()).map((d) => d.count);

  it("the question fails with ai_out_of_credit, both of the asker's counters (hour and day) are refunded, and the next question is refused up front", async () => {
    const credit = createCreditGate();
    const s = await setup({ model: broke(), credit, guards: testGuards({ asksPerHour: 2, asksPerDay: 5 }) });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const events = await streamAll(streamUrl(s, runId, token));
    assert.equal(events.at(-1)!.event, "failed");
    assert.deepEqual((events.at(-1)!.data as { error: unknown }).error, {
      code: "ai_out_of_credit",
      message: "The coach is resting: its AI allowance has run out. Reports already written are still shown.",
    });
    assert.deepEqual(await askCounters(), [0, 0]);
    assert.equal((await AgentRun.findById(runId).lean())!.refundIds, undefined);
    assert.equal(JSON.stringify(events).includes("refundIds"), false);

    const refused = await ask(s, "How is my opening play?");
    assert.equal(refused.status, 503);
    assert.equal(((await refused.json()) as { code: string }).code, "ai_out_of_credit");
    assert.equal(await AgentRun.countDocuments(), 1);
    assert.deepEqual(await askCounters(), [0, 0]);
  });

  it("an answer already cached is still served while the coach is out of credit", async () => {
    const credit = createCreditGate();
    const s = await setup({ credit });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    await streamAll(streamUrl(s, runId, token));
    credit.mark();
    const cached = await ask(s, QUESTION);
    assert.equal(cached.status, 200);
    assert.equal(((await cached.json()) as { cached: boolean }).cached, true);
  });
});
