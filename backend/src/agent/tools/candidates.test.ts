import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { standardCoachGames } from "../../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../../scripts/testDb.js";
import { Game } from "../../db/models/game.js";
import { Player } from "../../db/models/player.js";
import { DEFAULT_RULES, type AgentContext } from "../context.js";
import { isWithin, isWorseEnough, labelOf, scanCandidates, type Candidate, type GameRow } from "./candidates.js";
import { declaredTools, runTool } from "./index.js";

// The standard coach player (scripts/coachFixture.ts), as the scan reads it from the database.
const rows = () => standardCoachGames(new Types.ObjectId()).map((g) => ({ ...g, _id: new Types.ObjectId() }) as unknown as GameRow);
const allOf = (games: GameRow[]) => games.map((g) => ({ result: (g as unknown as { result: "win" | "draw" | "loss" }).result, opening: g.opening }));
const scan = (rules = DEFAULT_RULES, shown?: number, games = rows(), all = allOf(games)) => scanCandidates(games, all, rules, shown);
const byId = (cs: Candidate[]) => new Map(cs.map((c) => [c.id, c]));

describe("isWorseEnough: at least the gap worse, in the direction that's bad", () => {
  it("both directions, at the 15% line", () => {
    assert.equal(isWorseEnough(4.6, 3.1, "higherIsWorse", 0.15), true); // 48% worse
    assert.equal(isWorseEnough(11.8, 11.9, "higherIsWorse", 0.15), false); // average (even slightly better)
    assert.equal(isWorseEnough(11.5, 10, "higherIsWorse", 0.15), true); // exactly 15%
    assert.equal(isWorseEnough(11.4, 10, "higherIsWorse", 0.15), false);
    assert.equal(isWorseEnough(40, 75.3, "lowerIsWorse", 0.15), true); // score 47% lower
    assert.equal(isWorseEnough(70, 75.3, "lowerIsWorse", 0.15), false); // 7% lower: not enough
    assert.equal(isWorseEnough(90, 75.3, "lowerIsWorse", 0.15), false); // better
  });
});

describe("the candidate scan", () => {
  it("the baselines are the player's own overall figures", () => {
    assert.deepEqual(scan().overall, {
      analysedGames: 10,
      playerMoves: 300,
      per100Moves: 7,
      inaccuracyPer100: 4,
      mistakePer100: 1,
      blunderPer100: 2,
      errorsPerGame: 2.1,
      scorePct: 50,
    });
  });

  it("a real weakness is found, with the numbers, the sample and the example filter", () => {
    const c = byId(scan().candidates).get("phase=endgame|kind=blunder")!;
    assert.deepEqual(c, {
      id: "phase=endgame|kind=blunder",
      label: "Blunders per 100 moves in the endgame",
      measure: "blunderPer100",
      unit: "per100",
      value: 6,
      baseline: 2,
      direction: "higherIsWorse",
      gapPct: 200,
      games: 10,
      moves: 100,
      errors: 6,
      // 6 blunders where her own rate predicts 2: (6 - 2) / √2.
      rankScore: 2.8,
      exampleFilter: { phase: "endgame", kind: "blunder" },
      parentIds: ["phase=endgame"],
    });
  });

  it("gap threshold: average or better groups aren't candidates; the gap is a setting", () => {
    const ids = new Set(scan().candidates.map((c) => c.id));
    assert.equal(ids.has("phase=middlegame"), false, "middlegame 6.0 per 100 vs her 7.0: better, not worse");
    assert.equal(ids.has("phase=opening"), false);
    assert.equal(ids.has("speed=blitz"), false, "every game is blitz: the same as her average");
    assert.equal(ids.has("clockBucket=over50|kind=inaccuracy"), false, "4.5 vs 4.0 is 12.5% worse: under 15%");
    // At 75% only the 200%-worse blunder groups are left; at 70% the endgame (71%) joins them.
    assert.deepEqual(
      new Set(scan({ ...DEFAULT_RULES, minGap: 0.75 }).candidates.map((c) => c.gapPct)),
      new Set([200]),
    );
    assert.ok(scan({ ...DEFAULT_RULES, minGap: 0.7 }).candidates.some((c) => c.id === "phase=endgame" && c.gapPct === 71));
  });

  it("minimum sample: games and moves; openings need games only", () => {
    // Every phase, clock and move-number group has exactly 100 of her moves.
    const strict = scan({ ...DEFAULT_RULES, minMoves: 101 }).candidates;
    assert.deepEqual(strict.map((c) => c.id).sort(), ["eco=B06", "eco=B06|kind=blunder", "eco=B06|kind=inaccuracy"]);
    // Each opening has 5 games.
    assert.ok(scan({ ...DEFAULT_RULES, minGames: 6 }).candidates.every((c) => c.exampleFilter.eco === undefined));
  });

  it("errors from a single game aren't a candidate, however bad the rate", () => {
    // Endgame mistakes: 3 in 100 moves vs her 1.0, all in g10.
    assert.equal(scan().candidates.some((c) => c.exampleFilter.kind === "mistake"), false);
  });

  it("sorted by rankScore, then gap, then id; the top 12", () => {
    const list = scan().candidates;
    assert.equal(list.length, 12);
    assert.deepEqual(
      list.map((c) => [c.id, c.rankScore, c.gapPct]),
      [
        ["clockBucket=under10|kind=blunder", 2.8, 200],
        ["moveNumberBucket=21-30|kind=blunder", 2.8, 200],
        ["phase=endgame|clockBucket=under10|kind=blunder", 2.8, 200],
        ["phase=endgame|kind=blunder", 2.8, 200],
        ["clockBucket=under10", 1.9, 71],
        ["moveNumberBucket=21-30", 1.9, 71],
        ["phase=endgame", 1.9, 71],
        ["phase=endgame|clockBucket=under10", 1.9, 71],
        ["eco=B06|kind=blunder", 1.2, 65],
        ["moveNumberBucket=11-20|kind=inaccuracy", 1, 50],
        ["phase=middlegame|clockBucket=over50|kind=inaccuracy", 1, 50],
        ["phase=middlegame|kind=inaccuracy", 1, 50],
      ],
    );
    assert.equal(scan().qualifying, 14);
  });

  it("nesting: a candidate lists the broader candidates in the list that contain it", () => {
    const list = byId(scan().candidates);
    assert.deepEqual(list.get("phase=endgame|clockBucket=under10|kind=blunder")!.parentIds, [
      "clockBucket=under10|kind=blunder",
      "phase=endgame|kind=blunder",
      "clockBucket=under10",
      "phase=endgame",
      "phase=endgame|clockBucket=under10",
    ]);
    assert.deepEqual(list.get("phase=middlegame|clockBucket=over50|kind=inaccuracy")!.parentIds, ["phase=middlegame|kind=inaccuracy"]);
    assert.equal(list.get("phase=endgame")!.parentIds, undefined, "the broadest has no parent");
    assert.equal(isWithin({ phase: "endgame", kind: "blunder" }, { phase: "endgame" }), true);
    assert.equal(isWithin({ phase: "endgame" }, { phase: "endgame", kind: "blunder" }), false);
    assert.equal(isWithin({ phase: "endgame" }, { clockBucket: "under10" }), false);
  });

  it("one candidate per example filter: the opening's per-100 rate and errors per game bring the same examples", () => {
    const ids = scan({ ...DEFAULT_RULES }, 50).candidates.map((c) => c.id);
    assert.ok(ids.includes("eco=B06"));
    assert.equal(ids.includes("eco=B06|errorsPerGame"), false);
    const b06 = byId(scan({ ...DEFAULT_RULES }, 50).candidates).get("eco=B06")!;
    assert.deepEqual([b06.value, b06.baseline, b06.gapPct, b06.games, b06.label], [8.7, 7, 24, 5, "Errors per 100 moves in the B06 (Modern Defense)"]);
  });

  it("one slot is kept for an opening when none made the cut", () => {
    const top3 = scan(DEFAULT_RULES, 3).candidates.map((c) => c.id);
    assert.deepEqual(top3, ["clockBucket=under10|kind=blunder", "moveNumberBucket=21-30|kind=blunder", "eco=B06|kind=blunder"]);
  });

  it("score %: lowerIsWorse, from every game including unanalysed ones", () => {
    const games = rows();
    // B06 lost every game, C50 won every game, plus one unanalysed C50 win.
    const all = [...allOf(games).map((g) => ({ ...g, result: (g.opening?.eco === "B06" ? "loss" : "win") as "win" | "loss" })), { result: "win" as const, opening: { eco: "C50" } }];
    const list = scan(DEFAULT_RULES, 50, games, all);
    assert.equal(list.overall.scorePct, 54.5); // 6 of 11
    const score = byId(list.candidates).get("eco=B06|scorePct")!;
    assert.deepEqual(
      [score.measure, score.unit, score.value, score.baseline, score.direction, score.gapPct, score.games, score.label],
      ["scorePct", "percent", 0, 54.5, "lowerIsWorse", 100, 5, "Score in the B06 (Modern Defense)"],
    );
  });

  it("labels say exactly what was counted", () => {
    assert.equal(labelOf("blunderPer100", { phase: "endgame", clockBucket: "under10", kind: "blunder" }), "Blunders per 100 moves in the endgame with under 10% of the clock left");
    assert.equal(labelOf("per100Moves", { moveNumberBucket: "41+" }), "Errors per 100 moves from move 41 on");
    assert.equal(labelOf("inaccuracyPer100", { moveNumberBucket: "11-20", speed: "blitz", color: "black" }), "Inaccuracies per 100 moves in moves 11-20 in blitz games with Black");
    assert.equal(labelOf("errorsPerGame", { eco: "D01" }, "Richter-Veresov Attack"), "Errors per game in the D01 (Richter-Veresov Attack)");
  });
});

describe("get_weakness_candidates through the registry", () => {
  let db: Awaited<ReturnType<typeof startTestDb>>;
  let ctx: AgentContext;
  before(async () => {
    db = await startTestDb();
    await clearDb();
    const p = await Player.create({ platform: "lichess", username: "Cand", usernameLower: "cand" });
    ctx = { playerId: p._id, platform: "lichess" };
    await Game.insertMany(standardCoachGames(p._id));
    // Another player's terrible game never counts.
    const other = await Player.create({ platform: "lichess", username: "Other", usernameLower: "other" });
    await Game.insertMany(standardCoachGames(other._id).slice(0, 1).map((g) => ({ ...g, features: { ...g.features, mistakes: [] } })));
  });
  after(async () => {
    await db.stop();
  });

  it("declared to the model right after the profile, with no arguments", () => {
    const tools = declaredTools();
    assert.equal(tools[1]!.name, "get_weakness_candidates");
    assert.deepEqual(tools[1]!.parameters, { type: "object", properties: {} });
  });

  it("its baselines are exactly the profile's overall figures", async () => {
    const [cands, profile] = await Promise.all([runTool(ctx, "get_weakness_candidates", {}), runTool(ctx, "get_player_profile", {})]);
    assert.ok(cands.ok && profile.ok);
    const overall = (cands.data as { overall: Record<string, number> }).overall;
    const p = profile.data as { errors: Record<string, number>; results: { scorePct: number }; analysedGames: number };
    assert.deepEqual(
      [overall.per100Moves, overall.inaccuracyPer100, overall.mistakePer100, overall.blunderPer100, overall.errorsPerGame, overall.scorePct, overall.analysedGames, overall.playerMoves],
      [p.errors.per100Moves, p.errors.inaccuracyPer100, p.errors.mistakePer100, p.errors.blunderPer100, p.errors.perGame, p.results.scorePct, p.analysedGames, p.errors.playerMoves],
    );
  });

  it("each candidate's exampleFilter works as find_example_mistakes filters, and finds the errors it counts", async () => {
    const r = await runTool(ctx, "get_weakness_candidates", {});
    assert.ok(r.ok);
    for (const c of (r.data as { candidates: Candidate[] }).candidates) {
      const e = await runTool(ctx, "find_example_mistakes", { filters: c.exampleFilter, limit: 5 });
      assert.ok(e.ok, `${c.id}: ${!e.ok && e.error}`);
      assert.deepEqual((e.data as { filters: object }).filters, c.exampleFilter, c.id);
      assert.equal((e.data as { matchingErrors: number }).matchingErrors, c.errors, c.id);
    }
  });

  it("the rules come from the context", async () => {
    const r = await runTool({ ...ctx, rules: { minGap: 0.75 } }, "get_weakness_candidates", {});
    assert.ok(r.ok);
    assert.deepEqual((r.data as { rules: object }).rules, { minGapPct: 75, minGames: 5, minMoves: 100 });
    assert.ok((r.data as { candidates: Candidate[] }).candidates.every((c) => c.gapPct >= 75));
  });

  it("unknown arguments are a readable error", async () => {
    assert.deepEqual(await runTool(ctx, "get_weakness_candidates", { phase: "endgame" }), {
      ok: false,
      error: 'Invalid arguments. arguments: unknown key "phase" (allowed: none)',
    });
  });
});
