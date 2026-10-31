import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../app.js";
import { Game } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { createQueue } from "../jobs/queue.js";
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

const get = (path: string) => fetch(`${server.baseUrl}/api${path}`);

test("GET /games/:id: the whole game for the review page, without claim internals", async () => {
  const player = await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });
  const game = await Game.create({
    playerId: player._id,
    platform: "lichess",
    sourceId: "abcd1234",
    playedAt: new Date("2026-10-20T00:00:00Z"),
    color: "white",
    result: "win",
    speed: "blitz",
    pgn: "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0",
    plies: 7,
    clocks: [180, 179, 178, 177, 176, 175, 174],
    analysis: {
      status: "claimed",
      claimedBy: "secret-claim-token",
      claimExpiresAt: new Date(),
      evals: [{ cp: 30 }],
    },
  });

  const res = await get(`/games/${game._id}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    game: Record<string, unknown> & { analysis: Record<string, unknown> };
    player: unknown;
  };
  assert.equal(body.game.id, String(game._id));
  assert.equal(body.game.pgn, game.pgn);
  assert.deepEqual(body.game.clocks, game.clocks);
  assert.equal(body.game.analysis.status, "claimed");
  assert.deepEqual(body.game.analysis.evals, [{ cp: 30 }]);
  assert.equal(body.game.analysis.claimedBy, undefined);
  assert.equal(body.game.analysis.claimExpiresAt, undefined);
  assert.equal(body.game.playerId, undefined);
  assert.equal(body.game._id, undefined);
  assert.deepEqual(body.player, { platform: "lichess", username: "Alice" });
});

test("GET /games/:id: missing or malformed ids are 404", async () => {
  assert.equal((await get(`/games/${"0".repeat(24)}`)).status, 404);
  assert.equal((await get("/games/not-an-id")).status, 404);
  assert.deepEqual(await (await get("/games/not-an-id")).json(), { error: "Game not found" });
});
