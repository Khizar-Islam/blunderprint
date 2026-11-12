import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { standardCoachGames } from "../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { startAskRun } from "../jobs/handlers/ask.js";
import { startReportRun } from "../jobs/handlers/report.js";
import { createQueue } from "../jobs/queue.js";
import { createCoachRuntime } from "./coach.js";
import { ownJobsFilter, preAnswer } from "./demoAnswers.js";
import { createScriptedModel } from "./scriptedModel.js";
import { SUGGESTED_QUESTIONS } from "./suggestions.js";

// npm run demo:answers runs from a laptop against the LIVE database (Stage 6 chunk C, addition A):
// its worker must take only the jobs it enqueued itself, never a visitor's queued report or ask
// job, and must never reap someone else's expired lease.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

let demoId: Types.ObjectId;
beforeEach(async () => {
  await clearDb();
  const demo = await Player.create({ platform: "lichess", username: "DemoGuy", usernameLower: "demoguy" });
  demoId = demo._id;
  await Game.insertMany(standardCoachGames(demo._id));
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

const coachRuntime = () => createCoachRuntime(ENV, { model: createScriptedModel({ delayMs: 5 }) });
const fast = { pollMs: 20, workerPollMs: 10 };
const VISITOR_QUESTION = "Which piece do I blunder most?";

describe("preAnswer (npm run demo:answers)", () => {
  it("answers through the job path and keeps the answers and runs; a visitor's queued ask and report jobs and an expired lease are left alone", async () => {
    const queue = createQueue();
    const coach = coachRuntime();
    // What a visitor may have waiting on the live database at that moment.
    const visitorAsk = await startAskRun(queue, demoId, coach.modelName, VISITOR_QUESTION);
    assert.equal(visitorAsk.created, true);
    await startReportRun(queue, demoId, coach.modelName);
    const stuck = await Job.create({
      type: "import",
      key: "import:lichess:someone",
      status: "running",
      workerId: "a-server-that-died",
      leaseUntil: new Date(Date.now() - 60_000),
      attempts: 1,
      maxAttempts: 5,
      runAfter: new Date(),
    });

    const questions = SUGGESTED_QUESTIONS.slice(0, 2);
    const results = await preAnswer({ queue, coach, playerId: demoId, questions, ...fast });

    assert.deepEqual(results.map((r) => [r.question, r.status, r.ownJob]), questions.map((q) => [q, "done", true]));
    for (const r of results) {
      const answer = await Answer.findById(r.answerId).lean();
      assert.ok(answer);
      assert.equal(answer.expiresAt, undefined, "the answer is kept");
      assert.equal(String(answer.runId), r.runId);
      const run = await AgentRun.findById(r.runId).lean();
      assert.equal(run?.status, "done");
      assert.equal(run?.expiresAt, undefined, "its run is kept");
    }
    // Our two jobs ran and finished...
    assert.equal(await Job.countDocuments({ type: "ask", status: "done" }), 2);
    // ...the visitor's ask job and its run were never touched...
    const theirJob = await Job.findOne({ type: "ask", status: { $ne: "done" } }).lean();
    assert.equal(theirJob?.status, "queued");
    assert.equal(theirJob?.attempts, 0);
    assert.equal(theirJob?.workerId, undefined);
    const theirRun = await AgentRun.findById(visitorAsk.runId).lean();
    assert.equal(theirRun?.status, "queued");
    assert.ok(theirRun?.expiresAt);
    // ...nor the queued report...
    const report = await Job.findOne({ type: "report" }).lean();
    assert.equal(report?.status, "queued");
    assert.equal(report?.attempts, 0);
    // ...nor the expired lease (no reaper in this worker).
    const after = await Job.findById(stuck._id).lean();
    assert.equal(after?.status, "running");
    assert.equal(after?.workerId, "a-server-that-died");
    assert.equal(await Answer.countDocuments(), 2);
  });

  it("a second call: the cached answers are kept, with no new run and no job", async () => {
    const queue = createQueue();
    const coach = coachRuntime();
    const questions = SUGGESTED_QUESTIONS.slice(0, 1);
    await preAnswer({ queue, coach, playerId: demoId, questions, ...fast });
    // As if a later 30-day answer had replaced the kept one's expiry: the second call keeps it again.
    await Answer.updateMany({}, { $set: { expiresAt: new Date(Date.now() + 1_000_000) } });
    const runs = await AgentRun.countDocuments();
    const jobs = await Job.countDocuments();

    const again = await preAnswer({ queue, coach, playerId: demoId, questions, ...fast });
    assert.equal(again[0]?.status, "cached");
    assert.equal(await AgentRun.countDocuments(), runs);
    assert.equal(await Job.countDocuments(), jobs);
    assert.equal((await Answer.findById(again[0]?.answerId).lean())?.expiresAt, undefined);
  });

  it("the same question already queued by a visitor: joined, NOT claimed by our worker (left for the live server)", async () => {
    const queue = createQueue();
    const coach = coachRuntime();
    const theirs = await startAskRun(queue, demoId, coach.modelName, SUGGESTED_QUESTIONS[0]);
    assert.equal(theirs.created, true);

    const results = await preAnswer({ queue, coach, playerId: demoId, questions: SUGGESTED_QUESTIONS.slice(0, 1), timeoutMs: 300, ...fast });
    assert.equal(results[0]?.status, "unfinished");
    assert.equal(results[0]?.ownJob, false);
    assert.equal(results[0]?.runId, theirs.runId);
    const job = await Job.findOne({ type: "ask" }).lean();
    assert.equal(job?.status, "queued");
    assert.equal(job?.attempts, 0);
    assert.equal(await AgentRun.countDocuments({ kind: "ask" }), 1, "our extra run was deleted by startAskRun");
  });

  it("ownJobsFilter: only ask jobs with exactly these ids", () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    assert.deepEqual(ownJobsFilter(ids), { _id: { $in: ids }, type: "ask" });
    // An empty list matches nothing (preAnswer doesn't start a worker then anyway).
    assert.deepEqual(ownJobsFilter([]), { _id: { $in: [] }, type: "ask" });
  });
});
