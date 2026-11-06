import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { createApp } from "../app.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { createQueue } from "../jobs/queue.js";
import { demoChecker } from "../lib/demo.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { startTestServer } from "../../scripts/testServer.js";

// Frozen demo players (lib/demo.ts): no re-import, no analysis claims, flagged for the UI.
// "lichess:DemoGuy" is a demo player here; "Alice" is a normal one, to show nothing else changed.

let db: Awaited<ReturnType<typeof startTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
before(async () => {
  db = await startTestDb();
  server = await startTestServer(
    createApp({
      corsOrigins: [],
      trustProxyHops: 0,
      getDbStatus: () => true,
      queue: createQueue(),
      version: "test",
      isDemo: demoChecker(["lichess:demoguy"]),
    }),
  );
});
after(async () => {
  await server.close();
  await db.stop();
});
beforeEach(clearDb);

const api = (path: string, init?: RequestInit) => fetch(`${server.baseUrl}/api${path}`, init);
const postJson = (path: string, body?: unknown) =>
  api(path, {
    method: "POST",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });

const IMPORTED_LONG_AGO = new Date("2026-10-01T00:00:00Z");

async function makePlayer(username: string, lastImportedAt: Date | undefined = IMPORTED_LONG_AGO) {
  return Player.create({
    platform: "lichess",
    username,
    usernameLower: username.toLowerCase(),
    importState: "ready",
    ...(lastImportedAt ? { lastImportedAt } : {}),
  });
}

let made = 0;
async function makePendingGame(playerId: Types.ObjectId) {
  return Game.create({
    playerId,
    platform: "lichess",
    sourceId: `g${made++}`,
    playedAt: new Date("2026-10-20T00:00:00Z"),
    color: "white",
    result: "win",
    speed: "blitz",
    pgn: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
    plies: 7,
    analysis: { status: "pending" },
  });
}

test("import: a demo player imported long ago is frozen (200, no job), in any letter case", async () => {
  await makePlayer("DemoGuy");
  for (const name of ["DemoGuy", "demoguy", "DEMOGUY"]) {
    const res = await postJson(`/players/lichess/${name}/import`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { upToDate: true, frozen: true });
  }
  assert.equal(await Job.countDocuments(), 0);
});

test("import: a normal player imported long ago still re-imports (202)", async () => {
  await makePlayer("Alice");
  const res = await postJson("/players/lichess/Alice/import");
  assert.equal(res.status, 202);
  assert.equal(await Job.countDocuments({ type: "import" }), 1);
});

test("import: a demo player that was never imported gets its first import (seeding)", async () => {
  const res = await postJson("/players/lichess/DemoGuy/import");
  assert.equal(res.status, 202);
  assert.equal(await Job.countDocuments({ type: "import" }), 1);
  // ...and while that import runs, asking again rejoins it (not "frozen").
  const again = await postJson("/players/lichess/DemoGuy/import");
  assert.equal(again.status, 202);
  assert.equal(await Job.countDocuments({ type: "import" }), 1);
});

test("GET player: demo is true only for demo players", async () => {
  await makePlayer("DemoGuy");
  await makePlayer("Alice");
  const demo = (await (await api("/players/lichess/demoguy")).json()) as { player: { demo: boolean } };
  const alice = (await (await api("/players/lichess/Alice")).json()) as { player: { demo: boolean } };
  assert.equal(demo.player.demo, true);
  assert.equal(alice.player.demo, false);
});

test("claim: a demo player's pending games are never handed out and stay pending", async () => {
  const demo = await makePlayer("DemoGuy");
  const game = await makePendingGame(demo._id);
  const res = await postJson("/analysis/claim", { platform: "lichess", username: "DemoGuy", prefer: String(game._id) });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { games: unknown[]; frozen?: boolean };
  assert.deepEqual(body.games, []);
  assert.equal(body.frozen, true);
  const stored = await Game.findById(game._id).lean();
  assert.equal(stored?.analysis?.status, "pending");
  assert.equal(stored?.analysis?.claimedBy, undefined);
});

test("claim: a normal player's games are still handed out", async () => {
  const alice = await makePlayer("Alice");
  await makePendingGame(alice._id);
  const res = await postJson("/analysis/claim", { platform: "lichess", username: "Alice" });
  const body = (await res.json()) as { games: unknown[]; frozen?: boolean };
  assert.equal(body.games.length, 1);
  assert.equal(body.frozen, undefined);
});

test("GET game: carries demo + lastImportedAt, so the review page doesn't start the engine", async () => {
  const demo = await makePlayer("DemoGuy");
  const alice = await makePlayer("Alice");
  const demoGame = await makePendingGame(demo._id);
  const aliceGame = await makePendingGame(alice._id);
  type Body = { player: { demo: boolean; lastImportedAt?: string } };
  const d = (await (await api(`/games/${String(demoGame._id)}`)).json()) as Body;
  const a = (await (await api(`/games/${String(aliceGame._id)}`)).json()) as Body;
  assert.equal(d.player.demo, true);
  assert.equal(d.player.lastImportedAt, IMPORTED_LONG_AGO.toISOString());
  assert.equal(a.player.demo, false);
});
