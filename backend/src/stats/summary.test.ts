import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import type { PipelineStage, Types } from "mongoose";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { FEATURES_VERSION } from "../chess/features.js";
import { Game } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { summarizeExplain } from "../lib/explain.js";
import { computeSummary, rebuildCachedSummary, summaryPipeline, SUMMARY_VERSION, type Summary } from "./summary.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

// Four games for alice whose every number is known, and one of bob's that must never count.
//   G1 white win  blitz  180+0  2026-10-01 00:00  C50 "Italian Game"            done, 2 mistakes
//   G2 black loss bullet 60+0   2026-10-10 00:00  C50 "Italian Game: Two Knights" done, 2 mistakes
//   G3 white draw blitz  180+0  2026-10-20        B01 "Scandinavian Defense"     pending (no analysis)
//   G4 white win  blitz  180+0  2026-09-01        C50 "Italian Game"            imported, replay error
let alice: Types.ObjectId;
let ids: Record<"g1" | "g2" | "g3" | "g4", string>;

const G1_CLASSES = ["good", "good", "good", "good", "inaccuracy", "good", "good", "good", "blunder", "good"];

async function seed() {
  await clearDb();
  alice = (await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" }))._id;
  const bob = (await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" }))._id;
  const base = { platform: "lichess", pgn: "1. e4 *", termination: "mate" };
  const mistake = (ply: number, kind: string, phase: string, square: string, clockLeft: number) => ({
    ply,
    kind,
    phase,
    san: "e4",
    winDrop: 20,
    clockLeft,
    timeTrouble: false,
    square,
    fen: "8/8/8/8/8/8/8/8 w - -",
  });
  const [g1, g2, g3, g4] = await Game.insertMany([
    {
      ...base,
      playerId: alice,
      sourceId: "g1",
      playedAt: new Date("2026-10-01T00:00:00Z"),
      color: "white",
      result: "win",
      speed: "blitz",
      timeControl: "180+0",
      plies: 10, // White's moves 1–5
      opening: { eco: "C50", name: "Italian Game" },
      analysis: { status: "done", classifications: G1_CLASSES },
      features: {
        version: FEATURES_VERSION,
        division: { middle: 6 },
        mistakes: [
          mistake(5, "inaccuracy", "opening", "e4", 100), // 100/180 = 56%: over50
          mistake(9, "blunder", "middlegame", "f7", 18), // exactly 10%: from10to25, not yet trouble
        ],
        moveCounts: { opening: 3, middlegame: 2, endgame: 0, clock: { over50: 4, from25to50: 1, from10to25: 0, under10: 0 } },
      },
    },
    {
      ...base,
      playerId: alice,
      sourceId: "g2",
      playedAt: new Date("2026-10-10T00:00:00Z"),
      color: "black",
      result: "loss",
      speed: "bullet",
      timeControl: "60+0",
      plies: 30, // Black's moves 1–15
      opening: { eco: "C50", name: "Italian Game: Two Knights" },
      analysis: { status: "done", classifications: Array(30).fill("good") },
      features: {
        version: FEATURES_VERSION,
        division: { middle: 10, end: 20 },
        mistakes: [
          mistake(22, "mistake", "endgame", "e4", 15), // move 11; exactly 25%: from10to25
          mistake(30, "blunder", "endgame", "a1", 3), // move 15; 5%: under10
        ],
        moveCounts: { opening: 5, middlegame: 5, endgame: 5, clock: { over50: 10, from25to50: 3, from10to25: 1, under10: 1 } },
      },
    },
    {
      ...base,
      playerId: alice,
      sourceId: "g3",
      playedAt: new Date("2026-10-20T00:00:00Z"),
      color: "white",
      result: "draw",
      speed: "blitz",
      timeControl: "180+0",
      plies: 8,
      opening: { eco: "B01", name: "Scandinavian Defense" },
      analysis: { status: "pending" },
    },
    {
      ...base,
      playerId: alice,
      sourceId: "g4",
      playedAt: new Date("2026-09-01T00:00:00Z"),
      color: "white",
      result: "win",
      speed: "blitz",
      timeControl: "180+0",
      plies: 6,
      opening: { eco: "C50", name: "Italian Game" },
      analysis: { status: "imported", classifications: ["best", "good", "inaccuracy", "good", "mistake", "blunder"] },
      features: { version: FEATURES_VERSION, error: "replay_failed" },
    },
    {
      ...base,
      playerId: bob,
      sourceId: "g1",
      playedAt: new Date("2026-10-05T00:00:00Z"),
      color: "black",
      result: "loss",
      speed: "blitz",
      timeControl: "180+0",
      plies: 10,
      opening: { eco: "C50", name: "Italian Game" },
      analysis: { status: "done", classifications: G1_CLASSES },
      features: { version: FEATURES_VERSION, mistakes: [mistake(10, "blunder", "opening", "h8", 50)], moveCounts: { opening: 5, middlegame: 0, endgame: 0 } },
    },
  ]);
  ids = { g1: String(g1!._id), g2: String(g2!._id), g3: String(g3!._id), g4: String(g4!._id) };
}

describe("computeSummary: every breakdown on known games", () => {
  let s: Summary;
  before(async () => {
    await seed();
    s = await computeSummary(alice);
  });

  it("totals: all 4 games, 2 analysed (pending and the replay error don't count), bob never", () => {
    assert.deepEqual(s.totals, {
      games: 4,
      analysed: 2,
      moves: 20,
      mistakes: { inaccuracy: 1, mistake: 1, blunder: 2, total: 4 },
      firstPlayedAt: "2026-09-01T00:00:00.000Z",
      lastPlayedAt: "2026-10-20T00:00:00.000Z",
    });
    assert.equal(s.version, SUMMARY_VERSION);
    assert.deepEqual(s.filters, {});
  });

  it("openings: by ECO, score from every game, errors from analysed ones, the most-used name", () => {
    assert.deepEqual(s.openings, [
      // G1, G2, G4: 2 wins + 1 loss; 2 analysed with 4 errors between them.
      { eco: "C50", name: "Italian Game", games: 3, wins: 2, draws: 0, losses: 1, score: 66.7, analysed: 2, mistakesPerGame: 2 },
      { eco: "B01", name: "Scandinavian Defense", games: 1, wins: 0, draws: 1, losses: 0, score: 50, analysed: 0, mistakesPerGame: null },
    ]);
  });

  it("byPhase: per game (÷ 2 analysed) and per 100 of the player's moves in that phase", () => {
    const pick = s.byPhase.map(({ phase, total, moves, perGame, per100 }) => ({ phase, total, moves, perGame, per100 }));
    assert.deepEqual(pick, [
      { phase: "opening", total: 1, moves: 8, perGame: 0.5, per100: 12.5 },
      { phase: "middlegame", total: 1, moves: 7, perGame: 0.5, per100: 14.3 },
      { phase: "endgame", total: 2, moves: 5, perGame: 1, per100: 40 },
    ]);
    assert.deepEqual(
      s.byPhase.map(({ inaccuracy, mistake, blunder }) => [inaccuracy, mistake, blunder]),
      [
        [1, 0, 0],
        [0, 0, 1],
        [0, 1, 1],
      ],
    );
  });

  it("bySpeed: analysed games per speed", () => {
    const bySpeed = Object.fromEntries(s.bySpeed.map(({ speed, games, total, moves, perGame, per100 }) => [speed, { games, total, moves, perGame, per100 }]));
    assert.deepEqual(bySpeed, {
      blitz: { games: 1, total: 2, moves: 5, perGame: 2, per100: 40 },
      bullet: { games: 1, total: 2, moves: 15, perGame: 2, per100: 13.3 },
    });
  });

  it("byClock: the same edges as clockBucket (exactly 10% and exactly 25% are from10to25)", () => {
    const pick = s.byClock.map(({ bucket, total, moves }) => ({ bucket, total, moves }));
    assert.deepEqual(pick, [
      { bucket: "over50", total: 1, moves: 14 },
      { bucket: "from25to50", total: 0, moves: 4 },
      { bucket: "from10to25", total: 2, moves: 1 },
      { bucket: "under10", total: 1, moves: 1 },
    ]);
    assert.equal(s.byClock[1]!.per100, 0);
  });

  it("byMoveNumber: errors by move number, moves counted from plies and colour", () => {
    const pick = s.byMoveNumber.map(({ bucket, total, moves, per100 }) => ({ bucket, total, moves, per100 }));
    assert.deepEqual(pick, [
      { bucket: "1-10", total: 2, moves: 15, per100: 13.3 }, // moves 3 and 5; G1 1–5 + G2 1–10
      { bucket: "11-20", total: 2, moves: 5, per100: 40 }, // moves 11 and 15; G2 11–15
      { bucket: "21-30", total: 0, moves: 0, per100: null },
      { bucket: "31-40", total: 0, moves: 0, per100: null },
      { bucket: "41+", total: 0, moves: 0, per100: null },
    ]);
  });

  it("squares: all 64, a1 first, counts by kind", () => {
    assert.equal(s.squares.length, 64);
    assert.deepEqual(s.squares[0], { square: "a1", inaccuracy: 0, mistake: 0, blunder: 1, total: 1 });
    assert.deepEqual(s.squares[28], { square: "e4", inaccuracy: 1, mistake: 1, blunder: 0, total: 2 });
    assert.deepEqual(s.squares[53], { square: "f7", inaccuracy: 0, mistake: 0, blunder: 1, total: 1 });
    assert.equal(s.squares[63]!.square, "h8");
    assert.equal(s.squares[63]!.total, 0, "bob's h8 blunder isn't alice's");
    assert.equal(s.squares.reduce((n, sq) => n + sq.total, 0), 4);
  });

  it("ribbons: every game with classifications (ours or imported), newest first, one letter per ply", () => {
    assert.deepEqual(
      s.ribbons.map((r) => r.gameId),
      [ids.g2, ids.g1, ids.g4],
    );
    assert.equal(s.ribbons[1]!.classes, "ggggigggxg"); // G1: inaccuracy on ply 5, blunder on ply 9
    assert.equal(s.ribbons[2]!.classes, "bgigmx");
    assert.deepEqual(
      { color: s.ribbons[0]!.color, result: s.ribbons[0]!.result, speed: s.ribbons[0]!.speed, playedAt: s.ribbons[0]!.playedAt },
      { color: "black", result: "loss", speed: "bullet", playedAt: "2026-10-10T00:00:00.000Z" },
    );
  });
});

describe("computeSummary: filters", () => {
  before(seed);
  const games = async (filters: Parameters<typeof computeSummary>[1]) => {
    const s = await computeSummary(alice, filters);
    return { games: s.totals.games, analysed: s.totals.analysed, ribbons: s.ribbons.map((r) => r.gameId) };
  };

  it("colour", async () => {
    assert.deepEqual(await games({ color: "black" }), { games: 1, analysed: 1, ribbons: [ids.g2] });
  });
  it("speed", async () => {
    assert.deepEqual(await games({ speed: "blitz" }), { games: 3, analysed: 1, ribbons: [ids.g1, ids.g4] });
  });
  it("from is inclusive (G1 is at exactly 2026-10-01 00:00)", async () => {
    assert.deepEqual((await games({ from: new Date("2026-10-01T00:00:00Z") })).games, 3);
  });
  it("to is exclusive (G2 is at exactly 2026-10-10 00:00)", async () => {
    assert.deepEqual(await games({ to: new Date("2026-10-10T00:00:00Z") }), { games: 2, analysed: 1, ribbons: [ids.g1, ids.g4] });
  });
  it("all together", async () => {
    const s = await computeSummary(alice, { color: "white", speed: "blitz", from: new Date("2026-09-15T00:00:00Z") });
    assert.equal(s.totals.games, 2); // G1, G3
    assert.deepEqual(s.filters, { color: "white", speed: "blitz", from: "2026-09-15T00:00:00.000Z" });
    assert.deepEqual(s.openings.map((o) => o.eco), ["B01", "C50"]); // 1 game each: ties go by ECO
  });
  it("a player with no games gets zeros, not an error", async () => {
    const s = await computeSummary((await Player.create({ platform: "chesscom", username: "nobody", usernameLower: "nobody" }))._id);
    assert.equal(s.totals.games, 0);
    assert.equal(s.totals.analysed, 0);
    assert.deepEqual(s.openings, []);
    assert.equal(s.byPhase[0]!.perGame, null);
    assert.equal(s.squares.length, 64);
    assert.deepEqual(s.ribbons, []);
  });
});

describe("the summary query uses the { playerId, playedAt, _id } index", () => {
  before(seed);
  for (const [name, filters] of [
    ["unfiltered", {}],
    ["filtered", { color: "white" as const, speed: "blitz" as const, from: new Date("2026-09-15T00:00:00Z") }],
  ] as const) {
    it(`${name}: IXSCAN on playerId_1_playedAt_-1__id_-1, no collection scan, no in-memory sort`, async () => {
      const explain = await Game.aggregate(summaryPipeline(alice, filters)).explain("executionStats");
      const e = summarizeExplain(explain);
      assert.deepEqual(e.indexScans, ["playerId_1_playedAt_-1__id_-1"]);
      assert.equal(e.collectionScan, false);
      assert.equal(e.inMemorySort, false);
    });
  }
});

describe("rebuildCachedSummary", () => {
  before(seed);
  it("stores the unfiltered summary with its version", async () => {
    const s = await rebuildCachedSummary(alice);
    const p = await Player.findById(alice).lean();
    assert.equal(p!.summaryVersion, SUMMARY_VERSION);
    assert.equal((p!.summary as Summary).generatedAt, s.generatedAt);
    assert.equal((p!.summary as Summary).totals.games, 4);
  });
  it("never overwrites a newer summary with an older one", async () => {
    const future = "2099-01-01T00:00:00.000Z";
    await Player.updateOne({ _id: alice }, { $set: { "summary.generatedAt": future } });
    await rebuildCachedSummary(alice);
    assert.equal(((await Player.findById(alice).lean())!.summary as Summary).generatedAt, future);
  });
});

describe("rebuildCachedSummary: overlapping rebuilds", () => {
  before(seed);
  it("a rebuild that started first but finishes last does not overwrite the newer one", async () => {
    // Rebuild A reads the data (4 games), then stalls before it writes. A new game arrives,
    // rebuild B starts, reads 5 games and writes. Then A finishes. A read older data, so its
    // write must be refused, even though it lands last.
    const original = Game.aggregate.bind(Game);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let readA!: () => void;
    const aHasRead = new Promise<void>((resolve) => (readA = resolve));
    let calls = 0;
    const agg = mock.method(Game, "aggregate", (async (pipeline: PipelineStage[]) => {
      const first = ++calls === 1;
      const result = await original(pipeline);
      if (first) {
        readA();
        await gate;
      }
      return result;
    }) as never);
    try {
      const rebuildA = rebuildCachedSummary(alice);
      await aHasRead;
      await Game.create({
        playerId: alice,
        platform: "lichess",
        sourceId: "g5",
        pgn: "1. e4 *",
        playedAt: new Date("2026-10-25T00:00:00Z"),
        color: "black",
        result: "loss",
        speed: "blitz",
        timeControl: "180+0",
        plies: 2,
        analysis: { status: "pending" },
      });
      await new Promise((r) => setTimeout(r, 5)); // B's read is stamped in a later millisecond than A's
      const b = await rebuildCachedSummary(alice);
      release();
      const a = await rebuildA;

      assert.equal(agg.mock.callCount(), 2);
      assert.equal(a.totals.games, 4);
      assert.equal(b.totals.games, 5);
      assert.ok(a.generatedAt < b.generatedAt, "A was stamped when it read, before B");
      const stored = (await Player.findById(alice).lean())!.summary as Summary;
      assert.equal(stored.generatedAt, b.generatedAt);
      assert.equal(stored.totals.games, 5);
    } finally {
      agg.mock.restore();
    }
  });
});
