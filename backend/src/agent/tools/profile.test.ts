import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { coachGame, type CoachGameOptions } from "../../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../../scripts/testDb.js";
import { Game } from "../../db/models/game.js";
import { Player } from "../../db/models/player.js";
import type { AgentContext } from "../context.js";
import { getPlayerProfile } from "./profile.js";

// get_player_profile for players who aren't the tidy standard fixture: no games, one colour
// only, nothing analysed yet, games without an accuracy. The model quotes these numbers, so a
// missing figure must be null ("not known"), never 0, NaN or an average with a made-up zero.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

let ctx: AgentContext;
let alice: Types.ObjectId;
beforeEach(async () => {
  await clearDb();
  alice = (await Player.create({ platform: "chesscom", username: "Alice", usernameLower: "alice" }))._id;
  ctx = { playerId: alice, platform: "chesscom" };
});

// An analysed game with a chosen accuracy (the fixture's is 80).
const analysed = (o: Omit<CoachGameOptions, "playerId" | "mistakes"> & { accuracy?: number | null; mistakes?: CoachGameOptions["mistakes"] }) => {
  const game = coachGame({ playerId: alice, mistakes: [], ...o });
  const { accuracy: _a, ...analysis } = game.analysis;
  return { ...game, analysis: o.accuracy === null ? analysis : { ...analysis, accuracy: o.accuracy ?? 80 } };
};
// A game the engine hasn't seen yet: a result, but no accuracy and no features.
const pending = (o: Omit<CoachGameOptions, "playerId" | "mistakes">) => {
  const { features: _f, ...game } = coachGame({ playerId: alice, mistakes: [], ...o });
  return { ...game, analysis: { status: "pending" } };
};

// Every number in a tool result must be a real number: NaN or Infinity would reach the model
// as null or as garbage, depending on the serializer.
function assertFinite(value: unknown, path = "profile"): void {
  if (typeof value === "number") assert.ok(Number.isFinite(value), `${path} is ${value}`);
  else if (Array.isArray(value)) value.forEach((v, i) => assertFinite(v, `${path}[${i}]`));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) assertFinite(v, `${path}.${k}`);
}

describe("get_player_profile: edge players", () => {
  it("a player with no games at all: zero counts, and every rate null instead of 0 or NaN", async () => {
    const p = await getPlayerProfile(ctx);
    assertFinite(p);
    assert.deepEqual(
      {
        platform: p.platform,
        currentRatings: p.currentRatings,
        games: p.games,
        analysedGames: p.analysedGames,
        firstGame: p.firstGame,
        lastGame: p.lastGame,
        results: p.results,
        byColor: p.byColor,
        bySpeed: p.bySpeed,
        accuracyPct: p.accuracyPct,
      },
      {
        platform: "chesscom",
        currentRatings: {},
        games: 0,
        analysedGames: 0,
        firstGame: null,
        lastGame: null,
        results: { win: 0, draw: 0, loss: 0, scorePct: null },
        byColor: { white: { games: 0, scorePct: null }, black: { games: 0, scorePct: null } },
        bySpeed: [],
        accuracyPct: { all: null, white: null, black: null },
      },
    );
    assert.deepEqual([p.errors.total, p.errors.playerMoves, p.errors.per100Moves, p.errors.perGame], [0, 0, null, null]);
    assert.deepEqual([p.errors.inaccuracyPer100, p.errors.mistakePer100, p.errors.blunderPer100], [null, null, null]);
  });

  it("games imported but none analysed yet: results are known, accuracy and error rates are null", async () => {
    await Game.insertMany([pending({ sourceId: "g1", day: 1, result: "win" }), pending({ sourceId: "g2", day: 2, result: "draw", color: "black", speed: "rapid" })]);
    const p = await getPlayerProfile(ctx);
    assertFinite(p);
    assert.deepEqual([p.games, p.analysedGames], [2, 0]);
    assert.deepEqual(p.results, { win: 1, draw: 1, loss: 0, scorePct: 75 });
    assert.deepEqual(p.accuracyPct, { all: null, white: null, black: null });
    assert.deepEqual([p.errors.per100Moves, p.errors.perGame], [null, null]);
    assert.deepEqual(
      p.bySpeed.map((s) => [s.speed, s.games, s.scorePct, s.analysedGames, s.errorsPer100Moves]).sort(),
      [
        ["blitz", 1, 100, 0, null],
        ["rapid", 1, 50, 0, null],
      ],
    );
  });

  it("only White games: Black's score and accuracy are null, and the overall accuracy is White's, not halved", async () => {
    await Game.insertMany([analysed({ sourceId: "g1", day: 1, accuracy: 90, result: "win" }), analysed({ sourceId: "g2", day: 2, accuracy: 70, result: "loss" })]);
    const p = await getPlayerProfile(ctx);
    assertFinite(p);
    assert.deepEqual(p.byColor, { white: { games: 2, scorePct: 50 }, black: { games: 0, scorePct: null } });
    assert.deepEqual(p.accuracyPct, { all: 80, white: 80, black: null });
  });

  it("the overall accuracy is weighted by games: 3 White games at 90 and 1 Black game at 50 is 80, not 70", async () => {
    await Game.insertMany([
      analysed({ sourceId: "g1", day: 1, accuracy: 90 }),
      analysed({ sourceId: "g2", day: 2, accuracy: 90 }),
      analysed({ sourceId: "g3", day: 3, accuracy: 90 }),
      analysed({ sourceId: "g4", day: 4, accuracy: 50, color: "black" }),
    ]);
    assert.deepEqual((await getPlayerProfile(ctx)).accuracyPct, { all: 80, white: 90, black: 50 });
  });

  it("an analysed game without an accuracy is left out of the average, not counted as 0", async () => {
    await Game.insertMany([analysed({ sourceId: "g1", day: 1, accuracy: 84 }), analysed({ sourceId: "g2", day: 2, accuracy: null })]);
    const p = await getPlayerProfile(ctx);
    assert.equal(p.analysedGames, 2, "it still counts as analysed: its mistakes are known");
    assert.deepEqual(p.accuracyPct, { all: 84, white: 84, black: null });
  });

  it("a pending game's results count, but it adds nothing to accuracy or the error rates", async () => {
    await Game.insertMany([
      analysed({ sourceId: "g1", day: 1, accuracy: 80, result: "loss", mistakes: [{ ply: 45, kind: "blunder" }] }),
      pending({ sourceId: "g2", day: 2, result: "win" }),
    ]);
    const p = await getPlayerProfile(ctx);
    assert.deepEqual([p.games, p.analysedGames, p.results.scorePct], [2, 1, 50]);
    // 1 blunder in the one analysed game's 30 moves; the pending game's moves aren't in the base.
    assert.deepEqual([p.errors.total, p.errors.playerMoves, p.errors.per100Moves, p.errors.perGame], [1, 30, 3.3, 1]);
    assert.deepEqual(p.bySpeed, [{ speed: "blitz", games: 2, scorePct: 50, analysedGames: 1, errorsPer100Moves: 3.3 }]);
  });

  it("another player's games never count, and the player is taken from the context only", async () => {
    const bob = await Player.create({ platform: "chesscom", username: "Bob", usernameLower: "bob", profile: { ratings: { blitz: 2800 } } });
    await Game.insertMany([coachGame({ playerId: bob._id, sourceId: "b1", day: 1, result: "win", mistakes: [{ ply: 5, kind: "blunder" }] })]);
    await Game.insertMany([analysed({ sourceId: "g1", day: 3, result: "loss" })]);
    const p = await getPlayerProfile(ctx);
    assert.deepEqual([p.games, p.results.win, p.errors.total, p.currentRatings], [1, 0, 0, {}]);
    assert.ok(!JSON.stringify(p).includes("2800"));
  });
});
