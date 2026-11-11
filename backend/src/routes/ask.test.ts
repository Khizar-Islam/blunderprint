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
import type { Model } from "../agent/model.js";
import { hashToken, tokenMatches } from "../agent/runTokens.js";
import { createScriptedModel } from "../agent/scriptedModel.js";
import { createApp } from "../app.js";
import { AgentRun, MAX_RUN_TOKENS } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { Usage } from "../db/models/usage.js";
import { createAskHandler } from "../jobs/handlers/ask.js";
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
  startLane(): Worker;
  stop(): Promise<void>;
}

let current: Setup | null = null;
async function setup({
  env = {},
  model,
  worker = true,
  guards,
  queue = createQueue(),
}: { env?: Partial<typeof ENV>; model?: Model; worker?: boolean; guards?: Guards; queue?: Pick<Queue, "enqueue" | "depth"> & Partial<Queue> } = {}): Promise<Setup> {
  const coach = createCoachRuntime({ ...ENV, ...env }, { model: model ?? createScriptedModel({ delayMs: 10 }) });
  const server = await startTestServer(
    createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue, version: "test", coach, sseHeartbeatMs: 1_000, guards }),
  );
  const workers: Worker[] = [];
  const startLane = () => {
    const w = startWorker({
      queue: queue as Queue,
      handlers: { report: createReportHandler(coach), ask: createAskHandler(coach) },
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

async function streamAll(url: string, timeoutMs = 10_000): Promise<SseMessage[]> {
  const client = await openSseClient(url);
  const events: SseMessage[] = [];
  for (;;) {
    const m = await client.nextEvent(timeoutMs);
    if (!m) return events;
    events.push(m);
  }
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
    const body = (await again.json()) as { cached: boolean; answer: { id: string; question: string } };
    assert.equal(body.cached, true);
    assert.equal(body.answer.question, QUESTION);
    assert.equal(await AgentRun.countDocuments(), 1);
    assert.equal(await Answer.countDocuments(), 1);
    const asks = await Usage.find({ _id: /\|asks\|/ }).lean();
    assert.deepEqual(asks.map((u) => u.count), [1, 1]); // the hour and the day: one question started
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
  it("only the token's hash is stored; streaming needs one of the run's tokens (missing or wrong → 404 run_not_found)", async () => {
    const s = await setup({ worker: false });
    const { runId, token } = await accepted(await ask(s, QUESTION));
    const run = await AgentRun.findById(runId).lean();
    assert.deepEqual(run!.tokenHashes, [hashToken(token)]);
    assert.ok(!JSON.stringify(run).includes(token));

    for (const url of [streamUrl(s, runId), streamUrl(s, runId, "wrong"), streamUrl(s, runId, token.replace(/.$/, "0")), streamUrl(s, runId, "")]) {
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

describe("the production coach lane", () => {
  it("takes report AND ask jobs for this process's model", () => {
    const { lanes, handlers, coach } = createJobSystem({ ...ENV, CONTACT_EMAIL: "test@example.com", MAX_GAMES_PER_PLAYER: 200 });
    assert.deepEqual(lanes.coach, { type: { $in: ["report", "ask"] }, "payload.model": coach.modelName });
    assert.ok(handlers.ask);
  });
});
