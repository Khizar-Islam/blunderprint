import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
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
    createApp({
      corsOrigins: [],
      trustProxyHops: 0,
      getDbStatus: () => true,
      queue: createQueue(),
      version: "test",
      analysis: { claimSize: 3 },
    }),
  );
});
after(async () => {
  await server.close();
  await db.stop();
});
beforeEach(clearDb);

const api = (path: string, init?: RequestInit) => fetch(`${server.baseUrl}/api${path}`, init);
const postJson = (path: string, body: unknown) =>
  api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

interface ClaimResponse {
  claimId: string;
  expiresAt: string;
  engine: string;
  games: { id: string; pgn: string; plies: number; color: string }[];
}
const claim = async (extra: Record<string, unknown> = {}) => {
  const res = await postJson("/analysis/claim", { platform: "lichess", username: "Alice", ...extra });
  assert.equal(res.status, 200);
  return (await res.json()) as ClaimResponse;
};

// Scholar's mate, 7 plies, alice is White.
const PGN = "1. e4 e5 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0";
const MOVES = ["e2e4", "e7e5", "d1h5", "b8c6", "f1c4", "g8f6", "h5f7"];
// The engine's view: everything level until 3...Nf6??, then mate in one, then mate delivered.
const EVALS = [{ cp: 30 }, { cp: 25 }, { cp: 10 }, { cp: 20 }, { cp: 15 }, { mate: 1 }, { mate: 0 }];
const BEST = ["e2e4", "g8f6", "b1c3", "g7g6", "f1c4", "d8e7", null];

async function makePlayer() {
  return Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice", importState: "ready" });
}

// n games, game 0 newest. Status pending unless given. sourceIds are unique across calls.
let made = 0;
async function makeGames(playerId: Types.ObjectId, n: number, status = "pending") {
  const base = Date.parse("2026-10-20T00:00:00Z");
  const docs = await Game.insertMany(
    Array.from({ length: n }, (_, i) => ({
      playerId,
      platform: "lichess",
      sourceId: `g${made++}`,
      playedAt: new Date(base - i * 60_000),
      color: "white",
      result: "win",
      speed: "blitz",
      pgn: PGN,
      plies: 7,
      analysis: { status },
    })),
  );
  return docs.map((d) => String(d._id));
}

const result = (claimId: string, gameId: string, overrides: Record<string, unknown> = {}) => ({
  claimId,
  gameId,
  evals: EVALS,
  best: BEST,
  moves: MOVES,
  engine: "sf19-lite",
  nodes: 100_000,
  durationMs: 4_200,
  ...overrides,
});

test("claim: unknown player is 404, bad input is 400", async () => {
  assert.equal((await postJson("/analysis/claim", { platform: "lichess", username: "nobody" })).status, 404);
  assert.equal((await postJson("/analysis/claim", { platform: "fide", username: "alice" })).status, 400);
  assert.equal((await postJson("/analysis/claim", { platform: "lichess", username: "a", prefer: "nope" })).status, 400);
});

test("claim: hands out up to K games, newest first, and leases them", async () => {
  const player = await makePlayer();
  const ids = await makeGames(player._id, 5);
  const before = Date.now();

  const first = await claim();
  assert.match(first.claimId, /^[0-9a-f-]{36}$/);
  assert.equal(first.engine, "sf19-lite");
  assert.deepEqual(
    first.games.map((g) => g.id),
    ids.slice(0, 3),
  );
  assert.deepEqual(first.games[0], { id: ids[0], pgn: PGN, plies: 7, color: "white" });
  const expires = Date.parse(first.expiresAt) - before;
  assert.ok(expires > 9 * 60_000 && expires <= 10 * 60_000 + 1_000, "10-minute lease");

  const stored = await Game.findById(ids[0]).lean();
  assert.equal(stored!.analysis?.status, "claimed");
  assert.equal(stored!.analysis?.claimedBy, first.claimId);

  // The next claim gets the rest; then there's nothing left.
  const second = await claim();
  assert.deepEqual(
    second.games.map((g) => g.id),
    ids.slice(3),
  );
  assert.notEqual(second.claimId, first.claimId);
  assert.deepEqual((await claim()).games, []);
});

test("claim: simultaneous claims never get the same game", async () => {
  const player = await makePlayer();
  await makeGames(player._id, 7);
  const claims = await Promise.all([claim(), claim(), claim(), claim()]);
  const all = claims.flatMap((c) => c.games.map((g) => g.id));
  assert.equal(all.length, 7);
  assert.equal(new Set(all).size, 7);
});

test("claim: only pending games (or expired claims); done, imported and unanalysable are never handed out", async () => {
  const player = await makePlayer();
  await makeGames(player._id, 1, "done");
  await makeGames(player._id, 1, "imported");
  await makeGames(player._id, 1, "unanalysable");
  assert.deepEqual((await claim()).games, []);
});

test("claim: prefer puts the requested game first, even if it's older", async () => {
  const player = await makePlayer();
  const ids = await makeGames(player._id, 5);
  const c = await claim({ prefer: ids[4] });
  assert.deepEqual(
    c.games.map((g) => g.id),
    [ids[4], ids[0], ids[1]],
  );
  // Preferring a game that isn't claimable (already claimed) just gives the newest others.
  const d = await claim({ prefer: ids[4] });
  assert.deepEqual(
    d.games.map((g) => g.id),
    [ids[2], ids[3]],
  );
});

test("an expired claim is reclaimed, and the old tab's late result is refused", async () => {
  const player = await makePlayer();
  const [id] = await makeGames(player._id, 1);
  const old = await claim();
  // The first tab went away: its lease ran out.
  await Game.updateOne({ _id: id }, { $set: { "analysis.claimExpiresAt": new Date(Date.now() - 1_000) } });

  const fresh = await claim();
  assert.deepEqual(
    fresh.games.map((g) => g.id),
    [id],
  );
  const late = await postJson("/analysis/results", result(old.claimId, id!));
  assert.equal(late.status, 409);
  assert.equal((await postJson("/analysis/results", result(fresh.claimId, id!))).status, 200);
});

test("results: stores evals, classifies on the server, counts the game; a repeat is a harmless 200", async () => {
  const player = await makePlayer();
  const [id] = await makeGames(player._id, 1);
  const c = await claim();

  const res = await postJson("/analysis/results", result(c.claimId, id!));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { classifications: string[]; accuracy: number };
  // 1.e4 and 3.Bc4 were the engine's best; 3...Nf6?? walked into mate in one.
  assert.deepEqual(body.classifications, ["best", "good", "good", "good", "best", "blunder", "good"]);

  const stored = await Game.findById(id).lean();
  assert.equal(stored!.analysis?.status, "done");
  assert.equal(stored!.analysis?.engine, "sf19-lite");
  assert.equal(stored!.analysis?.depthOrNodes, 100_000);
  assert.equal(stored!.analysis?.durationMs, 4_200);
  assert.deepEqual(
    stored!.analysis?.evals?.map((e) => (e.mate !== undefined && e.mate !== null ? { mate: e.mate } : { cp: e.cp })),
    EVALS,
  );
  assert.deepEqual(stored!.analysis?.best, BEST);
  assert.deepEqual(stored!.analysis?.classifications, body.classifications);
  assert.equal(stored!.analysis?.accuracy, body.accuracy);
  assert.equal(stored!.analysis?.claimExpiresAt, undefined);
  assert.equal((await Player.findById(player._id).lean())!.analysedCount, 1);

  // A retried post from the same claim: 200, nothing changes, nothing is counted twice.
  const again = await postJson("/analysis/results", result(c.claimId, id!));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true, alreadyDone: true });
  assert.equal((await Player.findById(player._id).lean())!.analysedCount, 1);
});

test("results: anything that doesn't fit the game is a 400 and the claim stays open", async () => {
  const player = await makePlayer();
  const [id] = await makeGames(player._id, 1);
  const c = await claim();
  const bad: Record<string, unknown>[] = [
    { evals: EVALS.slice(1) }, // one eval short of the stored plies
    { best: BEST.slice(1) },
    { moves: MOVES.slice(1) },
    { evals: [{ cp: 99_999 }, ...EVALS.slice(1)] }, // out of bounds
    { evals: [{ cp: 1.5 }, ...EVALS.slice(1)] }, // not an integer
    { evals: [{ cp: 10, mate: 2 }, ...EVALS.slice(1)] }, // both
    { evals: [{}, ...EVALS.slice(1)] }, // neither
    { evals: [{ mate: 0 }, ...EVALS.slice(1)] }, // "checkmated" before the last move
    { best: ["e2e9", ...BEST.slice(1)] }, // not UCI
    { engine: "sf17" },
    { nodes: 10 },
    { extra: true },
  ];
  for (const override of bad) {
    const res = await postJson("/analysis/results", result(c.claimId, id!, override));
    assert.equal(res.status, 400, JSON.stringify(override));
  }
  const stored = await Game.findById(id).lean();
  assert.equal(stored!.analysis?.status, "claimed");
  assert.equal(stored!.analysis?.claimedBy, c.claimId);
});

test("results: an unknown game is 404, a game never claimed is 409", async () => {
  const player = await makePlayer();
  const [id] = await makeGames(player._id, 1);
  const c = await claim();
  assert.equal((await postJson("/analysis/results", result(c.claimId, "0".repeat(24)))).status, 404);
  const [unclaimed] = await makeGames(player._id, 1);
  assert.equal((await postJson("/analysis/results", result(c.claimId, unclaimed!))).status, 409, "never claimed");
  assert.equal(
    (await postJson("/analysis/results", result(crypto.randomUUID(), id!))).status,
    409,
    "someone else's claim token",
  );
});

test("results: a PGN the browser can't replay marks the game unanalysable, never handed out again", async () => {
  const player = await makePlayer();
  const [id] = await makeGames(player._id, 1);
  const c = await claim();

  const res = await postJson("/analysis/results", { claimId: c.claimId, gameId: id, error: "illegal_pgn", atPly: 12 });
  assert.equal(res.status, 200);
  const stored = await Game.findById(id).lean();
  assert.equal(stored!.analysis?.status, "unanalysable");
  assert.deepEqual(stored!.analysis?.error, { code: "illegal_pgn", atPly: 12 });
  assert.equal((await Player.findById(player._id).lean())!.analysedCount, 0);

  // Repeat from the same claim is fine; the game never comes back in a claim.
  const again = await postJson("/analysis/results", { claimId: c.claimId, gameId: id, error: "illegal_pgn", atPly: 12 });
  assert.deepEqual(await again.json(), { ok: true, alreadyDone: true });
  assert.deepEqual((await claim()).games, []);

  assert.equal(
    (await postJson("/analysis/results", { claimId: c.claimId, gameId: id, error: "cosmic_rays" })).status,
    400,
  );
});

test("release: a text/plain body (sendBeacon) hands unfinished games straight back", async () => {
  const player = await makePlayer();
  const ids = await makeGames(player._id, 3);
  const c = await claim();

  // Exactly what navigator.sendBeacon(url, jsonString) sends: Content-Type text/plain.
  const res = await api("/analysis/release", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ claimId: c.claimId, gameIds: ids }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { released: 3 });

  const stored = await Game.find().lean();
  for (const g of stored) {
    assert.equal(g.analysis?.status, "pending");
    assert.equal(g.analysis?.claimedBy, undefined);
    assert.equal(g.analysis?.claimExpiresAt, undefined);
  }
  // The released games can be claimed again at once, and the old claim's results are refused.
  assert.equal((await claim()).games.length, 3);
  assert.equal((await postJson("/analysis/results", result(c.claimId, ids[0]!))).status, 409);
});

test("release: only this claim's games go back; a JSON body works too; garbage is 400", async () => {
  const player = await makePlayer();
  const ids = await makeGames(player._id, 2);
  const mine = await claim();
  const res = await postJson("/analysis/release", { claimId: crypto.randomUUID(), gameIds: ids });
  assert.deepEqual(await res.json(), { released: 0 });
  assert.equal((await Game.countDocuments({ "analysis.status": "claimed" })), 2);

  assert.deepEqual(await (await postJson("/analysis/release", { claimId: mine.claimId, gameIds: ids })).json(), {
    released: 2,
  });

  const text = (body: string) =>
    api("/analysis/release", { method: "POST", headers: { "Content-Type": "text/plain" }, body });
  assert.equal((await text("{not json")).status, 400);
  assert.equal((await text(JSON.stringify({ claimId: "x", gameIds: ids }))).status, 400);
  assert.equal((await text("x".repeat(5_000))).status, 413);
});
