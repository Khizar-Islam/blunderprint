import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { AgentRun, RUN_TTL_MS } from "../db/models/agentRun.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { startReportRun } from "../jobs/handlers/report.js";
import { createQueue } from "../jobs/queue.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { syncRunExpiry } from "./runExpiry.js";

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
