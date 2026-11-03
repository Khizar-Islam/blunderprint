import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { createApp } from "../app.js";
import { FEATURES_VERSION } from "../chess/features.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { createQueue } from "../jobs/queue.js";
import { SUMMARY_VERSION, type Summary } from "../stats/summary.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { startTestServer } from "../../scripts/testServer.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
before(async () => {
  db = await startTestDb();
  server = await startTestServer(
    createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue: createQueue(), version: "test" }),
  );
});
after(async () => {
  await server.close();
  await db.stop();
});
beforeEach(clearDb);

interface SummaryResponse {
  summary: Summary;
  cached: boolean;
  extracting: boolean;
}
const get = (query = "", who = "lichess/Alice") => fetch(`${server.baseUrl}/api/players/${who}/summary${query}`);
const getJson = async (query = "") => {
  const res = await get(query);
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()) as SummaryResponse;
};

const makePlayer = () => Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice", importState: "ready" });

let made = 0;
// A game with features (extracted) or analysed without them (waiting for the extract job).
async function makeGame(
  playerId: Types.ObjectId,
  { extracted = true, color = "white" as "white" | "black", playedAt = "2026-10-01T00:00:00Z" } = {},
) {
  await Game.create({
    playerId,
    platform: "lichess",
    sourceId: `g${made++}`,
    playedAt: new Date(playedAt),
    color,
    result: "win",
    speed: "blitz",
    timeControl: "180+0",
    pgn: "1. e4 *",
    plies: 4,
    analysis: { status: "done", classifications: ["good", "inaccuracy", "good", "good"] },
    ...(extracted
      ? {
          features: {
            version: FEATURES_VERSION,
            division: {},
            mistakes: [],
            moveCounts: { opening: 2, middlegame: 0, endgame: 0 },
          },
        }
      : {}),
  });
}

test("unknown player is 404; bad filters are 400", async () => {
  assert.equal((await get()).status, 404);
  await makePlayer();
  for (const q of [
    "?color=red",
    "?speed=hyperbullet",
    "?from=yesterday",
    "?from=2026-10-01&to=2026-09-01", // from after to
    "?from=2026-10-01&to=2026-10-01", // empty range
    "?colour=white", // a typo is an error, not a silently unfiltered answer
  ]) {
    assert.equal((await get(q)).status, 400, q);
  }
  assert.equal((await get("", "lichess/a")).status, 400, "username too short");
});

test("unfiltered: built and cached on the first view, served from players.summary after", async () => {
  const p = await makePlayer();
  await makeGame(p._id);

  const first = await getJson();
  assert.equal(first.cached, false);
  assert.equal(first.summary.totals.games, 1);
  const stored = await Player.findById(p._id).lean();
  assert.equal(stored!.summaryVersion, SUMMARY_VERSION);

  // Served from the cache: a game added behind its back doesn't show until a rebuild.
  await makeGame(p._id, { playedAt: "2026-10-02T00:00:00Z" });
  const second = await getJson();
  assert.equal(second.cached, true);
  assert.deepEqual(second.summary, first.summary);
});

test("a cached summary of another SUMMARY_VERSION is ignored and rebuilt", async () => {
  const p = await makePlayer();
  await makeGame(p._id);
  await Player.updateOne({ _id: p._id }, { $set: { summary: { stale: true }, summaryVersion: SUMMARY_VERSION - 1 } });
  const res = await getJson();
  assert.equal(res.cached, false);
  assert.equal(res.summary.version, SUMMARY_VERSION);
  assert.equal((await Player.findById(p._id).lean())!.summaryVersion, SUMMARY_VERSION);
});

test("filtered: computed live, same shape, never stored as the cached summary", async () => {
  const p = await makePlayer();
  await makeGame(p._id, { color: "white" });
  await makeGame(p._id, { color: "black", playedAt: "2026-10-05T00:00:00Z" });
  const all = await getJson();

  const black = await getJson("?color=black&from=2026-10-02&to=2026-10-31T00:00:00Z");
  assert.equal(black.cached, false);
  assert.equal(black.summary.totals.games, 1);
  assert.deepEqual(black.summary.filters, { color: "black", from: "2026-10-02T00:00:00.000Z", to: "2026-10-31T00:00:00.000Z" });
  assert.deepEqual(Object.keys(black.summary).sort(), Object.keys(all.summary).sort());
  assert.equal(((await Player.findById(p._id).lean())!.summary as Summary).totals.games, 2);
});

test("backstop: analysed games without features start one extract job, however many views", async () => {
  const p = await makePlayer();
  await makeGame(p._id, { extracted: false });
  for (let i = 0; i < 3; i++) assert.equal((await getJson()).extracting, true);
  const jobs = await Job.find({ type: "extract" }).lean();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.key, `extract:${String(p._id)}`);
});

test("backstop: nothing to extract, no job", async () => {
  const p = await makePlayer();
  await makeGame(p._id);
  assert.equal((await getJson()).extracting, false);
  assert.equal(await Job.countDocuments({ type: "extract" }), 0);
});

test("extracting stays true while the extract job is active, though every game already has features", async () => {
  // The window between the job writing a game's features and rebuilding the cached summary at
  // the end of its run: nothing is missing, but the cached summary is still the old one.
  const p = await makePlayer();
  await makeGame(p._id);
  const job = await Job.create({ type: "extract", key: `extract:${String(p._id)}`, payload: {}, status: "running", runAfter: new Date() });
  assert.equal((await getJson()).extracting, true);
  await Job.updateOne({ _id: job._id }, { $set: { status: "done" } });
  assert.equal((await getJson()).extracting, false, "a finished job doesn't count");
  await Job.create({ type: "extract", key: "extract:someone-else", payload: {}, status: "queued", runAfter: new Date() });
  assert.equal((await getJson()).extracting, false, "another player's job doesn't count");
});

test("GET /players/:platform/:username doesn't send the cached summary", async () => {
  const p = await makePlayer();
  await makeGame(p._id);
  await getJson(); // caches it
  const res = await fetch(`${server.baseUrl}/api/players/lichess/Alice`);
  const body = (await res.json()) as { player: Record<string, unknown> };
  assert.equal("summary" in body.player, false);
  assert.equal(body.player.summaryVersion, SUMMARY_VERSION);
});
