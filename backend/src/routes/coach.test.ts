import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { coachGame, standardCoachGames } from "../../scripts/coachFixture.js";
import { openSseClient, type SseMessage } from "../../scripts/sseClient.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { startTestServer } from "../../scripts/testServer.js";
import { analysedBasis } from "../agent/basis.js";
import { pacificDay } from "../agent/budget.js";
import { createCoachRuntime, type CoachRuntime } from "../agent/coach.js";
import type { Model } from "../agent/model.js";
import { PROMPT_VERSION } from "../agent/prompts.js";
import { createScriptedModel } from "../agent/scriptedModel.js";
import { createApp } from "../app.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Game } from "../db/models/game.js";
import { Job, type JobDoc } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { Usage } from "../db/models/usage.js";
import { createReportHandler, type ReportHandlerOptions } from "../jobs/handlers/report.js";
import { saveReport } from "../agent/reportStore.js";
import { syncRunExpiry } from "../agent/runExpiry.js";
import { createQueue } from "../jobs/queue.js";
import { startWorker, type Worker } from "../jobs/worker.js";

// The whole coach chain with no AI calls: the routes, the report job on its own worker lane,
// the agent loop with the real tools and verifier, the run stream, the cache and the guards.
// The model is the scripted one (agent/scriptedModel.ts) or a fake that misbehaves on purpose.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

let aliceId: Types.ObjectId;
beforeEach(async () => {
  // The previous test's server and workers first, so nothing writes while the DB is cleared.
  await current?.stop();
  current = null;
  await clearDb();
  const alice = await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });
  await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" });
  aliceId = alice._id;
  // 10 analysed games with an endgame-blunder habit (scripts/coachFixture.ts).
  await Game.insertMany(standardCoachGames(alice._id));
});

const ENV = {
  AI_ENABLED: true,
  AI_DAILY_CALL_BUDGET: 400,
  GEMINI_API_KEY: undefined,
  GEMINI_MODEL: "unused",
  // No pacing in tests (the pacer has its own tests).
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
};

// Counts the requests that reached the model.
function counting(model: Model) {
  const counter = { calls: 0 };
  return {
    counter,
    model: { name: model.name, call: (req: Parameters<Model["call"]>[0]) => (counter.calls++, model.call(req)) } as Model,
  };
}

interface Setup {
  base: string;
  coach: CoachRuntime;
  queue: ReturnType<typeof createQueue>;
  startLane(c?: CoachRuntime): Worker;
  stop(): Promise<void>;
}

let current: Setup | null = null;
async function setup({
  env = {},
  model,
  worker = true,
  handler,
  fallback,
}: { env?: Partial<typeof ENV>; model?: Model; worker?: boolean; handler?: ReportHandlerOptions; fallback?: Model } = {}): Promise<Setup> {
  const coach = createCoachRuntime({ ...ENV, ...env }, { model: model ?? createScriptedModel({ delayMs: 20 }), ...(fallback ? { fallback } : {}) });
  const queue = createQueue();
  const server = await startTestServer(
    createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue, version: "test", coach, sseHeartbeatMs: 1_000 }),
  );
  const workers: Worker[] = [];
  const startLane = (c: CoachRuntime = coach) => {
    const w = startWorker({ queue, handlers: { report: createReportHandler(c, handler) }, claimFilter: { type: "report" }, pollMs: 10 });
    workers.push(w);
    return w;
  };
  if (worker) startLane();
  current = {
    base: `${server.baseUrl}/api`,
    coach,
    queue,
    startLane,
    async stop() {
      await Promise.all(workers.map((w) => w.stop()));
      await server.close();
    },
  };
  return current;
}
after(async () => {
  await current?.stop();
});

const reportUrl = (s: Setup, user = "alice") => `${s.base}/players/lichess/${user}/report`;
const post = (url: string) => fetch(url, { method: "POST" });

// Every event of a run's stream, until the server ends it.
async function streamAll(s: Setup, runId: string, timeoutMs = 10_000): Promise<SseMessage[]> {
  const client = await openSseClient(`${s.base}/runs/${runId}/stream`);
  const events: SseMessage[] = [];
  for (;;) {
    const m = await client.nextEvent(timeoutMs);
    if (!m) return events;
    events.push(m);
  }
}

async function waitFor<T>(read: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await read();
    if (ok(v)) return v;
    if (Date.now() > deadline) assert.fail(`never reached the expected state: ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

const today = () => `global:ai|${pacificDay(new Date())}`;

describe("the coach chain", () => {
  it("POST 202 → the stream shows the steps and ends with the report → GET has it → POST again is cached", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 20 }));
    const s = await setup({ model });

    const before = await (await fetch(reportUrl(s))).json() as any;
    assert.deepEqual(before, {
      report: null,
      stale: false,
      staleReason: null,
      newGames: 0,
      eligibility: { analysed: 10, needed: 10, ok: true },
      activeRun: null,
      ai: { enabled: true, budgetLeft: 400, canStart: true },
    });

    const res = await post(reportUrl(s));
    assert.equal(res.status, 202);
    const { runId } = await res.json() as any;
    assert.match(runId, /^[0-9a-f]{24}$/);

    const events = await streamAll(s, runId);
    assert.equal(events[0]!.event, "snapshot");
    const last = events.at(-1)!;
    assert.equal(last.event, "done");
    // Event ids are the run's revs: strictly increasing, nothing repeated.
    const revs = events.map((e) => Number(e.id));
    assert.deepEqual(revs, [...revs].sort((a, b) => a - b));
    assert.equal(new Set(revs).size, revs.length);
    const steps = events.filter((e) => e.event === "step").map((e) => (e.data as { step: { kind: string } }).step);
    const snapshotSteps = (events[0]!.data as { steps: unknown[] }).steps.length;
    assert.ok(steps.length + snapshotSteps >= 5, "the trace reached the viewer");

    const run = last.data as {
      status: string;
      usage: { calls: number };
      report: { id: string; patterns: { title: string; stat: { value: number; baseline: number }; evidence: Record<string, unknown>[] }[] };
    };
    assert.equal(run.status, "done");
    assert.equal((run.report as unknown as { runId: string }).runId, runId);
    assert.equal(run.usage.calls, counter.calls);
    assert.ok(run.report.patterns.length >= 1);
    const p = run.report.patterns[0]!;
    assert.ok(p.stat.value > p.stat.baseline);
    // What a mini board needs, with no extra request: FEN, moves as SAN and UCI, colour, facts.
    const e = p.evidence[0]!;
    assert.equal(e.fen, "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -");
    assert.equal(e.played, "Nf3");
    assert.equal(e.playedUci, "g1f3");
    assert.equal(e.color, "white");
    // The game's move ribbon for the fingerprint lens: one letter per ply, the blunder at its ply.
    const ribbon = e.ribbon as string;
    assert.equal(ribbon.length, 60);
    assert.equal(ribbon[(e.ply as number) - 1], { blunder: "x", mistake: "m", inaccuracy: "i" }[e.kind as string]);
    assert.ok(e.facts && typeof e.moveNumber === "number" && typeof e.gameId === "string");
    // Internal lists stay internal.
    assert.ok(!("dropped" in run.report) && !("trimmed" in run.report) && !("notEnoughData" in run.report));

    const afterRun = await (await fetch(reportUrl(s))).json() as any;
    assert.equal(afterRun.report.id, run.report.id);
    assert.equal(afterRun.stale, false);
    assert.equal(afterRun.activeRun, null);
    assert.equal(afterRun.ai.budgetLeft, 400 - counter.calls);
    assert.equal((await Usage.findById(today()).lean())!.count, counter.calls);

    const callsBefore = counter.calls;
    const again = await post(reportUrl(s));
    assert.equal(again.status, 200);
    const cached = await again.json() as any;
    assert.equal(cached.cached, true);
    assert.equal(cached.report.id, run.report.id);
    assert.equal(counter.calls, callsBefore, "a cached report costs no model call");

    // A finished run's stream: just the snapshot (with the report), then the end.
    const replay = await streamAll(s, runId);
    assert.deepEqual(replay.map((m) => m.event), ["snapshot"]);
    assert.equal((replay[0]!.data as { report: { id: string } }).report.id, run.report.id);
  });

  it("asking twice while a run is waiting returns the same run", async () => {
    const s = await setup({ worker: false });
    const a = await (await post(reportUrl(s))).json() as any;
    const res = await post(reportUrl(s));
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json() as any, a);
    assert.equal(await AgentRun.countDocuments(), 1);
    assert.equal(await Job.countDocuments({ type: "report" }), 1);
    const get = await (await fetch(reportUrl(s))).json() as any;
    assert.deepEqual(get.activeRun, { runId: a.runId, status: "queued" });
  });

  it("a newly analysed game makes the report stale; the next report replaces it (other models' reports stay)", async () => {
    const s = await setup();
    const first = await (await post(reportUrl(s))).json() as any;
    await streamAll(s, first.runId);
    const other = await Report.create({
      playerId: aliceId,
      analysedGamesHash: "x",
      promptVersion: PROMPT_VERSION,
      model: "another-model",
      runId: new Types.ObjectId(),
      outcome: "none",
      analysedGames: 10,
    });

    await Game.insertMany([coachGame({ playerId: aliceId, sourceId: "g11", day: 11, mistakes: [{ ply: 45, kind: "blunder", winDrop: 40 }] })]);
    const stale = await (await fetch(reportUrl(s))).json() as any;
    assert.equal(stale.stale, true);
    assert.equal(stale.staleReason, "new_games");
    assert.equal(stale.newGames, 1);
    assert.equal(stale.eligibility.analysed, 11);

    const res = await post(reportUrl(s));
    assert.equal(res.status, 202);
    const second = await res.json() as any;
    const events = await streamAll(s, second.runId);
    const newId = (events.at(-1)!.data as { report: { id: string } }).report.id;
    const kept = await Report.find({ playerId: aliceId }).lean();
    assert.deepEqual(kept.map((r) => String(r._id)).sort(), [newId, String(other._id)].sort());
    assert.equal((await (await fetch(reportUrl(s))).json() as any).stale, false);
  });
});

describe("the guards and errors", () => {
  it("unknown player 404, too few analysed games 409, each with a code", async () => {
    const s = await setup({ env: { COACH_MIN_ANALYSED_GAMES: 20 }, worker: false });
    for (const res of [await fetch(reportUrl(s, "nobody")), await post(reportUrl(s, "nobody"))]) {
      assert.equal(res.status, 404);
      assert.equal((await res.json() as any).code, "player_not_found");
    }
    const res = await post(reportUrl(s));
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json() as any, {
      code: "not_enough_games",
      error: "The coach needs at least 20 analysed games. 10 are ready, so keep this page open while the engine analyses more.",
    });
    assert.equal((await post(reportUrl(s, "bob"))).status, 409);
    assert.equal(await AgentRun.countDocuments(), 0);
  });

  it("kill switch: 503 ai_disabled, but a cached report is still served", async () => {
    const s = await setup({ env: { AI_ENABLED: false }, worker: false });
    const res = await post(reportUrl(s));
    assert.equal(res.status, 503);
    assert.equal((await res.json() as any).code, "ai_disabled");
    const get = await (await fetch(reportUrl(s))).json() as any;
    assert.deepEqual(get.ai, { enabled: false, budgetLeft: 0, canStart: false });

    const { hash } = await analysedBasis(aliceId);
    await Report.create({ playerId: aliceId, analysedGamesHash: hash, promptVersion: PROMPT_VERSION, model: s.coach.modelName, runId: new Types.ObjectId(), outcome: "none", analysedGames: 10 });
    const cached = await post(reportUrl(s));
    assert.equal(cached.status, 200);
    const body = await cached.json() as any;
    assert.equal(body.cached, true);
    assert.match(body.report.noPatternsMessage, /No weakness clearly stood out/);
  });

  it("budget under one worst-case run (COACH_MAX_REQUESTS, 16): 429 with Retry-After, nothing started", async () => {
    const s = await setup({ worker: false });
    await Usage.create({ _id: today(), count: 400 - 15, expiresAt: new Date(Date.now() + 86_400_000) });
    const res = await post(reportUrl(s));
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get("retry-after"));
    assert.ok(retryAfter > 0 && retryAfter <= 25 * 3600, String(retryAfter));
    const body = await res.json() as any;
    assert.equal(body.code, "ai_budget_exhausted");
    assert.match(body.error, /resets at midnight Pacific time/);
    assert.equal(await AgentRun.countDocuments(), 0);
    assert.equal((await (await fetch(reportUrl(s))).json() as any).ai.canStart, false);
  });

  it("the budget running out mid-run stops it with ai_budget_exhausted", async () => {
    const scripted = createScriptedModel({ delayMs: 0 });
    let calls = 0;
    const model: Model = {
      name: scripted.name,
      async call(req) {
        // After the 2nd request, someone else uses up the rest of today's budget.
        if (++calls === 2) await Usage.updateOne({ _id: today() }, { $set: { count: 16 } });
        return scripted.call(req);
      },
    };
    const s = await setup({ env: { AI_DAILY_CALL_BUDGET: 16 }, model });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const events = await streamAll(s, runId);
    const last = events.at(-1)!;
    assert.equal(last.event, "failed");
    assert.equal((last.data as { error: { code: string } }).error.code, "ai_budget_exhausted");
    assert.equal(calls, 2);
    const job = await Job.findOne({ type: "report" }).lean();
    assert.equal(job!.status, "failed");
    assert.equal(job!.error!.code, "ai_budget_exhausted");
  });

  it("an unexpected error's text reaches the logs, never the visitor", async () => {
    const SECRET = "SECRET-db-password at 10.0.0.7";
    const lines: string[] = [];
    const log = mock.method(console, "log", (line: string) => void lines.push(String(line)));
    const err = mock.method(console, "error", (line: string) => void lines.push(String(line)));
    try {
      const model: Model = {
        name: "scripted",
        async call() {
          throw new Error(SECRET);
        },
      };
      const s = await setup({ model });
      const { runId } = await (await post(reportUrl(s))).json() as any;
      const events = await streamAll(s, runId);
      assert.equal(events.at(-1)!.event, "failed");
      assert.deepEqual((events.at(-1)!.data as { error: unknown }).error, { code: "internal", message: "Something went wrong on our side." });

      const seen = [JSON.stringify(events), JSON.stringify(await (await fetch(reportUrl(s))).json() as any), JSON.stringify(await AgentRun.find().lean()), JSON.stringify(await Job.find().lean())];
      for (const text of seen) assert.ok(!text.includes("SECRET"), text);
      assert.ok(lines.some((l) => l.includes(SECRET) && l.includes("Coach run failed")), "the real error is logged");
    } finally {
      log.mock.restore();
      err.mock.restore();
    }
  });

  it("a model error maps to its friendly code (a server error, retried once → ai_unavailable)", async () => {
    const { ModelError } = await import("../agent/model.js");
    let calls = 0;
    const model: Model = {
      name: "scripted",
      async call() {
        calls++;
        throw new ModelError("server", "Gemini 503 UNAVAILABLE: internal upstream detail");
      },
    };
    const s = await setup({ model });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const events = await streamAll(s, runId);
    const data = events.at(-1)!.data as { error: { code: string; message: string } };
    assert.equal(data.error.code, "ai_unavailable");
    assert.ok(!data.error.message.includes("upstream"));
    assert.equal(calls, 2);
    // Each retry was a real request: both were taken from the budget.
    assert.equal((await Usage.findById(today()).lean())!.count, 2);
  });

  it("shutdown mid-run: the run goes back to queued, and the next worker runs it from scratch", async () => {
    let started!: () => void;
    const hanging = new Promise<void>((r) => (started = r));
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
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const client = await openSseClient(`${s.base}/runs/${runId}/stream`);
    await hanging;
    await lane.stop();

    const run = await AgentRun.findById(runId).lean();
    assert.equal(run!.status, "queued");
    const job = await Job.findOne({ type: "report" }).lean();
    assert.equal(job!.status, "queued");
    assert.equal(job!.attempts, 0, "the attempt was refunded");
    // The viewer saw the run go back to the queue.
    let m: SseMessage | null;
    do m = await client.nextEvent(); while (m && !(m.event === "status" && (m.data as { status: string }).status === "queued"));
    assert.ok(m, "a status: queued event");

    // The next process (a new worker with a working model) picks it up.
    const fresh = createCoachRuntime(ENV, { model: createScriptedModel({ delayMs: 0 }) });
    s.startLane(fresh);
    do m = await client.nextEvent(10_000); while (m && m.event !== "done" && m.event !== "failed");
    assert.equal(m!.event, "done");
    const done = m!.data as { attempt: number; steps: { label: string }[] };
    assert.equal(done.attempt, 1);
    client.close();
  });

  // A failed save after a good run must never run the AI again: only the save is retried.
  it("the save fails twice, then succeeds: done, with exactly one agent run", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    let saves = 0;
    const s = await setup({
      model,
      handler: {
        saveRetryDelaysMs: [5, 5],
        save: async (input) => {
          if (++saves <= 2) throw new Error("Atlas write timed out");
          return saveReport(input);
        },
      },
    });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const events = await streamAll(s, runId);
    const last = events.at(-1)!;
    assert.equal(last.event, "done");
    assert.equal(saves, 3);
    // One run's calls, made once: the model wasn't asked again.
    assert.equal((last.data as { usage: { calls: number } }).usage.calls, counter.calls);
    assert.equal(counter.calls, 4);
    const job = await Job.findOne({ type: "report" }).lean();
    assert.deepEqual([job!.status, job!.attempts], ["done", 1]);
    assert.equal(await Report.countDocuments({ playerId: aliceId }), 1);
  });

  // The worker marks the job done after the handler (and so afterSave) has returned.
  const jobDone = async () => {
    for (let i = 0; i < 200; i++) {
      const job = await Job.findOne({ type: "report" }).lean();
      if (job?.status === "done" || job?.status === "failed") return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("the report job never finished");
  };

  it("afterSave runs after the save: a demo player's new run loses its expiresAt (the trace is kept)", async () => {
    const s = await setup({ handler: { afterSave: () => syncRunExpiry(["lichess:alice"]) } });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    assert.ok((await AgentRun.findById(runId).lean())!.expiresAt, "created with an expiry");
    assert.equal((await streamAll(s, runId)).at(-1)!.event, "done");
    assert.equal((await jobDone()).status, "done");
    assert.equal((await AgentRun.findById(runId).lean())!.expiresAt, undefined);
  });

  it("a failing afterSave is only logged: the run is done and the report saved", async () => {
    const s = await setup({
      handler: {
        afterSave: async () => {
          throw new Error("Atlas hiccup");
        },
      },
    });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    assert.equal((await streamAll(s, runId)).at(-1)!.event, "done");
    const job = await jobDone();
    assert.deepEqual([job.status, job.attempts], ["done", 1]);
    assert.equal(await Report.countDocuments({ playerId: aliceId }), 1);
    assert.ok((await AgentRun.findById(runId).lean())!.expiresAt, "a normal run keeps its expiry");
  });

  it("the save always fails: the run fails with internal, the job is not retried, one agent run", async () => {
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
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const events = await streamAll(s, runId);
    const last = events.at(-1)!;
    assert.equal(last.event, "failed");
    assert.deepEqual((last.data as { error: unknown }).error, { code: "internal", message: "Something went wrong on our side." });
    assert.ok(!JSON.stringify(events).includes("SECRET"));
    assert.equal(saves, 3);
    assert.equal(counter.calls, 4);
    // Give the worker a moment: a retried job would be queued again and start a second run.
    await new Promise((r) => setTimeout(r, 100));
    const job = await Job.findOne({ type: "report" }).lean();
    assert.deepEqual([job!.status, job!.attempts, job!.error!.code], ["failed", 1, "internal"]);
    assert.equal(counter.calls, 4);
    assert.equal(await Report.countDocuments(), 0);
  });

  it("overloaded twice → fallback: every request counts in the budget, the report records who answered", async () => {
    const { ModelError } = await import("../agent/model.js");
    let mainCalls = 0;
    const main: Model = {
      name: "main-model",
      async call() {
        mainCalls++;
        throw new ModelError("overloaded", "Gemini 503 UNAVAILABLE: high demand", { status: 503 });
      },
    };
    const scripted = createScriptedModel({ delayMs: 0 });
    let fallbackCalls = 0;
    const fallback: Model = { name: "fallback-model", call: (req) => (fallbackCalls++, scripted.call(req)) };
    const s = await setup({ model: main, fallback });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const events = await streamAll(s, runId, 20_000);
    const last = events.at(-1)!;
    assert.equal(last.event, "done");
    const run = last.data as { usage: { calls: number }; steps: { kind: string; detail: string }[]; report: { model: string; answeredBy: string } };
    assert.equal(mainCalls, 2);
    assert.equal(run.usage.calls, mainCalls + fallbackCalls);
    assert.equal((await Usage.findById(today()).lean())!.count, mainCalls + fallbackCalls, "the budget counted every request");
    assert.ok(run.steps.some((st) => st.kind === "switch" && st.detail.startsWith("switched to fallback-model")));
    // Cached under the model that was asked for; the answer's author recorded beside it.
    assert.equal(run.report.model, "main-model");
    assert.equal(run.report.answeredBy, "fallback-model");
    assert.equal((await Report.findOne().lean())!.model, "main-model");
  });

  it("a report saved before the lens existed gets its ribbons filled on read, saved back, no AI call", async () => {
    const { model, counter } = counting(createScriptedModel({ delayMs: 0 }));
    const s = await setup({ model });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    await streamAll(s, runId);
    const callsAfterRun = counter.calls;

    // Make it look like a pre-chunk-D report: no `ribbon` on any evidence.
    const stored = (await Report.findOne({ playerId: aliceId }).lean())!;
    const stripped = (stored.patterns as { evidence: Record<string, unknown>[] }[]).map((p) => ({
      ...p,
      evidence: p.evidence.map(({ ribbon: _ribbon, ...rest }) => rest),
    }));
    await Report.updateOne({ _id: stored._id }, { $set: { patterns: stripped } }, { timestamps: false });
    const before = (await Report.findById(stored._id).lean())!;
    assert.ok((before.patterns as { evidence: { ribbon?: string }[] }[]).every((p) => p.evidence.every((e) => e.ribbon === undefined)));

    const get = await (await fetch(reportUrl(s))).json() as any;
    const evidence = get.report.patterns.flatMap((p: { evidence: { ribbon: string; ply: number }[] }) => p.evidence);
    assert.ok(evidence.length > 0);
    for (const e of evidence) {
      assert.equal(typeof e.ribbon, "string");
      assert.equal(e.ribbon.length, 60);
    }
    // Saved back, without moving the report's date.
    const after = (await Report.findById(stored._id).lean())!;
    assert.ok((after.patterns as { evidence: { ribbon?: string }[] }[]).every((p) => p.evidence.every((e) => typeof e.ribbon === "string")));
    assert.equal(after.updatedAt!.toISOString(), before.updatedAt!.toISOString());
    assert.equal(counter.calls, callsAfterRun, "no AI call");
    assert.equal(get.stale, false, "still the same report, not stale");

    // The next read finds them stored and writes nothing.
    const writes = mock.method(Report, "updateOne");
    try {
      await fetch(reportUrl(s));
      assert.equal(writes.mock.callCount(), 0);
    } finally {
      writes.mock.restore();
    }
  });

  it("a report from an older prompt version is stale with staleReason new_version", async () => {
    const s = await setup({ worker: false });
    const { hash } = await analysedBasis(aliceId);
    await Report.create({ playerId: aliceId, analysedGamesHash: hash, promptVersion: PROMPT_VERSION - 1, model: s.coach.modelName, runId: new Types.ObjectId(), outcome: "none", analysedGames: 10 });
    const get = await (await fetch(reportUrl(s))).json() as any;
    assert.deepEqual([get.stale, get.staleReason, get.newGames], [true, "new_version", 0]);
  });

  it("a job the reaper gives up on fails its run with coach_interrupted", async () => {
    const s = await setup({ worker: false });
    const { runId } = await (await post(reportUrl(s))).json() as any;
    const job = (await Job.findOne({ type: "report" })) as JobDoc;
    job.error = { code: "lease_expired", message: "x" };
    await createReportHandler(s.coach).onFailed!(job);
    const run = await AgentRun.findById(runId).lean();
    assert.equal(run!.status, "failed");
    assert.equal(run!.error!.code, "coach_interrupted");
  });
});

describe("GET /api/runs/:id/stream", () => {
  it("bad and unknown ids get JSON errors with codes, not a stream", async () => {
    const s = await setup({ worker: false });
    const bad = await fetch(`${s.base}/runs/nope/stream`);
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json() as any, { error: "Invalid run id" });
    const missing = await fetch(`${s.base}/runs/0123456789abcdef01234567/stream`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json() as any, { error: "That coach run has expired or doesn't exist.", code: "run_not_found" });
  });
});
