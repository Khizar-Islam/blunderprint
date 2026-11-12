import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { AgentRun, RUN_TTL_MS } from "../db/models/agentRun.js";
import { Answer, ANSWER_TTL_MS } from "../db/models/answer.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { startReportRun } from "../jobs/handlers/report.js";
import { createQueue } from "../jobs/queue.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { keepAnswer } from "./answerStore.js";
import { syncAnswerExpiry, syncRunExpiry } from "./runExpiry.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

const DEMO = ["lichess:demoguy"];
const CREATED = new Date("2026-11-01T10:00:00Z");

async function makePlayer(username: string) {
  return Player.create({ platform: "lichess", username, usernameLower: username.toLowerCase(), importState: "ready" });
}

// A run as saved before expiresAt existed: no expiresAt, a fixed createdAt.
async function makeOldRun(playerId: Types.ObjectId) {
  const run = await AgentRun.create({ playerId, model: "m", promptVersion: 6 });
  await AgentRun.collection.updateOne({ _id: run._id }, { $set: { createdAt: CREATED }, $unset: { expiresAt: "" } });
  return run._id;
}

async function makeReport(playerId: Types.ObjectId, runId: Types.ObjectId) {
  return Report.create({
    playerId,
    analysedGamesHash: new Types.ObjectId().toHexString(),
    promptVersion: 6,
    model: "m",
    runId,
    outcome: "patterns",
    analysedGames: 20,
  });
}

const expiryOf = async (id: Types.ObjectId) => (await AgentRun.findById(id).lean())?.expiresAt;

test("the TTL index is on expiresAt (at the date in the field); there is no createdAt TTL", async () => {
  const indexes = await AgentRun.collection.indexes();
  const ttl = indexes.filter((i) => i.expireAfterSeconds !== undefined);
  assert.deepEqual(
    ttl.map((i) => ({ key: i.key, expireAfterSeconds: i.expireAfterSeconds })),
    [{ key: { expiresAt: 1 }, expireAfterSeconds: 0 }],
  );
});

test("a new run is created with expiresAt 14 days from now", async () => {
  const player = await makePlayer("Alice");
  const before = Date.now();
  const { runId } = await startReportRun(createQueue(), player._id, "m");
  const expiresAt = await expiryOf(new Types.ObjectId(runId));
  assert.ok(expiresAt);
  assert.ok(expiresAt.getTime() >= before + RUN_TTL_MS && expiresAt.getTime() <= Date.now() + RUN_TTL_MS);
});

test("old runs without expiresAt get createdAt + 14 days; the demo report's run is kept", async () => {
  const demo = await makePlayer("DemoGuy");
  const alice = await makePlayer("Alice");
  const demoRun = await makeOldRun(demo._id);
  const demoOlderRun = await makeOldRun(demo._id); // a failed or replaced run: not behind a report
  const aliceRun = await makeOldRun(alice._id);
  await makeReport(demo._id, demoRun);
  await makeReport(alice._id, aliceRun);

  const result = await syncRunExpiry(DEMO);
  assert.deepEqual(result, { kept: 0, dated: 2 }); // the demo run had no date to remove
  assert.equal(await expiryOf(demoRun), undefined);
  assert.equal((await expiryOf(demoOlderRun))?.getTime(), CREATED.getTime() + RUN_TTL_MS);
  assert.equal((await expiryOf(aliceRun))?.getTime(), CREATED.getTime() + RUN_TTL_MS);

  // Idempotent: nothing left to change.
  assert.deepEqual(await syncRunExpiry(DEMO), { kept: 0, dated: 0 });
});

test("a new demo report's run loses its expiresAt; the replaced report's kept run is dated again", async () => {
  const demo = await makePlayer("DemoGuy");
  const first = await makeOldRun(demo._id);
  await makeReport(demo._id, first);
  await syncRunExpiry(DEMO);
  assert.equal(await expiryOf(first), undefined);

  // A new report replaces the first (saveReport deletes the older one); its run was created
  // with an expiresAt, like every new run.
  const { runId } = await startReportRun(createQueue(), demo._id, "m");
  const second = new Types.ObjectId(runId);
  await Report.deleteMany({ playerId: demo._id });
  await makeReport(demo._id, second);

  assert.deepEqual(await syncRunExpiry(DEMO), { kept: 1, dated: 1 });
  assert.equal(await expiryOf(second), undefined);
  assert.equal((await expiryOf(first))?.getTime(), CREATED.getTime() + RUN_TTL_MS);
});

test("a player removed from DEMO_PLAYERS: the kept run is dated again", async () => {
  const demo = await makePlayer("DemoGuy");
  const run = await makeOldRun(demo._id);
  await makeReport(demo._id, run);
  await syncRunExpiry(DEMO);
  assert.equal(await expiryOf(run), undefined);

  assert.deepEqual(await syncRunExpiry([]), { kept: 0, dated: 1 });
  assert.equal((await expiryOf(run))?.getTime(), CREATED.getTime() + RUN_TTL_MS);
});

test("dating a run leaves its updatedAt alone", async () => {
  const alice = await makePlayer("Alice");
  const run = await makeOldRun(alice._id);
  const updatedAt = (await AgentRun.findById(run).lean())?.updatedAt;
  await syncRunExpiry([]);
  assert.equal((await AgentRun.findById(run).lean())?.updatedAt?.getTime(), updatedAt?.getTime());
});

// Stage 6 chunk C: the demo player's kept answers (no expiresAt) and their runs.
async function makeAnswer(playerId: Types.ObjectId, runId: Types.ObjectId, question = "Do I play worse with Black?") {
  const answer = await Answer.create({
    playerId,
    questionKey: question.toLowerCase(),
    question,
    analysedGamesHash: "h",
    promptVersion: 5,
    model: "m",
    runId,
    outcome: "answer",
    analysedGames: 20,
    expiresAt: new Date(Date.now() + ANSWER_TTL_MS),
  });
  await Answer.collection.updateOne({ _id: answer._id }, { $set: { createdAt: CREATED } });
  return answer._id;
}
const answerExpiryOf = async (id: Types.ObjectId) => (await Answer.findById(id).lean())?.expiresAt;

test("keepAnswer removes the expiry of the answer and of its run, without touching updatedAt", async () => {
  const demo = await makePlayer("DemoGuy");
  const { runId } = await startReportRun(createQueue(), demo._id, "m"); // any run with an expiresAt
  const run = new Types.ObjectId(runId);
  const answer = await makeAnswer(demo._id, run);
  const updatedAt = (await Answer.findById(answer).lean())?.updatedAt;

  assert.equal(await keepAnswer(answer), true);
  assert.equal(await answerExpiryOf(answer), undefined);
  assert.equal(await expiryOf(run), undefined);
  assert.equal((await Answer.findById(answer).lean())?.updatedAt?.getTime(), updatedAt?.getTime());
  assert.equal(await keepAnswer(new Types.ObjectId()), false);
});

test("the run behind a demo player's kept answer is kept; an expiring answer's run and a non-demo kept answer's run are dated", async () => {
  const demo = await makePlayer("DemoGuy");
  const alice = await makePlayer("Alice");
  const keptRun = await makeOldRun(demo._id);
  const expiringRun = await makeOldRun(demo._id);
  const aliceRun = await makeOldRun(alice._id);
  await keepAnswer(await makeAnswer(demo._id, keptRun));
  await makeAnswer(demo._id, expiringRun, "Am I worse in the opening or the endgame?"); // a visitor's: 30 days
  await keepAnswer(await makeAnswer(alice._id, aliceRun));

  assert.deepEqual(await syncRunExpiry(DEMO), { kept: 0, dated: 2 });
  assert.equal(await expiryOf(keptRun), undefined);
  assert.equal((await expiryOf(expiringRun))?.getTime(), CREATED.getTime() + RUN_TTL_MS);
  assert.equal((await expiryOf(aliceRun))?.getTime(), CREATED.getTime() + RUN_TTL_MS);
  assert.deepEqual(await syncRunExpiry(DEMO), { kept: 0, dated: 0 });
});

test("syncAnswerExpiry: a demo player's kept answers stay kept; a non-demo player's get createdAt + 30 days", async () => {
  const demo = await makePlayer("DemoGuy");
  const alice = await makePlayer("Alice");
  const demoAnswer = await makeAnswer(demo._id, await makeOldRun(demo._id));
  const aliceAnswer = await makeAnswer(alice._id, await makeOldRun(alice._id));
  await keepAnswer(demoAnswer);
  await keepAnswer(aliceAnswer);

  assert.deepEqual(await syncAnswerExpiry(DEMO), { dated: 1 });
  assert.equal(await answerExpiryOf(demoAnswer), undefined);
  assert.equal((await answerExpiryOf(aliceAnswer))?.getTime(), CREATED.getTime() + ANSWER_TTL_MS);
  assert.deepEqual(await syncAnswerExpiry(DEMO), { dated: 0 });

  // The demo player leaves DEMO_PLAYERS: their kept answer gets its 30 days back (its run gets
  // its 14 days back from syncRunExpiry, as in the test above).
  assert.deepEqual(await syncAnswerExpiry([]), { dated: 1 });
  assert.equal((await answerExpiryOf(demoAnswer))?.getTime(), CREATED.getTime() + ANSWER_TTL_MS);
});
