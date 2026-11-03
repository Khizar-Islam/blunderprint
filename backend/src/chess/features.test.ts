import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import type { Classification } from "../db/models/game.js";
import { moverOfPly, START_EVAL, winPercentFor, type Eval } from "./classify.js";
import {
  clockBucket,
  extractFeatures,
  FEATURES_VERSION,
  initialSeconds,
  type FeatureInput,
  type GameFeatures,
} from "./features.js";
import { normalizeFen } from "./fen.js";
import { phaseOfPly, type Division } from "./phase.js";

// A game from SAN moves, with every ply "good" except the ones listed, and level evals
// unless given. Enough to test each feature on its own.
function game(
  moves: string[],
  { color = "white", judged = {}, evals, ...rest }: Partial<FeatureInput> & { judged?: Record<number, Classification> } = {},
): FeatureInput {
  const pgn = moves.map((m, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${m}` : m)).join(" ");
  return {
    pgn,
    plies: moves.length,
    color,
    evals: evals ?? moves.map(() => ({ cp: 0 })),
    classifications: moves.map((_, i) => judged[i + 1] ?? "good"),
    ...rest,
  };
}

async function features(input: FeatureInput): Promise<GameFeatures> {
  const out = await extractFeatures(input);
  assert.ok(!("error" in out), "expected the game to replay");
  return out;
}

// Scholar's mate, 7 plies. Black's 3...Nf6?? walks into mate in one.
const SCHOLAR = ["e4", "e5", "Qh5", "Nc6", "Bc4", "Nf6", "Qxf7#"];
const SCHOLAR_EVALS: Eval[] = [{ cp: 30 }, { cp: 25 }, { cp: 10 }, { cp: 20 }, { cp: 15 }, { mate: 1 }, { mate: 0 }];

describe("extractFeatures: one mistake, every field", () => {
  it("records Black's 3...Nf6?? and nothing of White's", async () => {
    const f = await features(
      game(SCHOLAR, {
        color: "black",
        evals: SCHOLAR_EVALS,
        // White's 1.e4 is marked too, to prove the opponent's moves are ignored.
        judged: { 1: "inaccuracy", 6: "blunder" },
        best: [null, null, null, null, null, "g7g6", null],
      }),
    );
    assert.equal(f.version, FEATURES_VERSION);
    assert.equal(f.mistakes.length, 1);
    const m = f.mistakes[0]!;
    const fenBefore = new Chess();
    for (const san of SCHOLAR.slice(0, 5)) fenBefore.move(san);
    assert.deepEqual(m, {
      ply: 6,
      kind: "blunder",
      phase: "opening",
      san: "Nf6",
      best: "g7g6",
      // Black's win% before (White +15 cp) minus after (White mates in 1).
      winDrop: Math.round((winPercentFor({ cp: 15 }, "black", 5) - winPercentFor({ mate: 1 }, "black", 6)) * 10) / 10,
      square: "f6",
      fen: normalizeFen(fenBefore.fen()),
    });
    // Black made 3 moves, all in the opening; no clocks in this game.
    assert.deepEqual(f.moveCounts, { opening: 3, middlegame: 0, endgame: 0 });
  });

  it("winDrop of the first move is measured from Lichess's start eval (+15 cp)", async () => {
    const f = await features(game(["e4", "e5"], { judged: { 1: "inaccuracy" }, evals: [{ cp: -200 }, { cp: -200 }] }));
    const expected = winPercentFor(START_EVAL, "white", 0) - winPercentFor({ cp: -200 }, "white", 1);
    assert.equal(f.mistakes[0]!.winDrop, Math.round(expected * 10) / 10);
  });
});

describe("extractFeatures: piece lost within 2 plies", () => {
  it("3.Nxe5?? dxe5: a knight for a pawn is a lost knight", async () => {
    const f = await features(game(["e4", "e5", "Nf3", "d6", "Nxe5", "dxe5", "a3"], { judged: { 5: "mistake" } }));
    assert.equal(f.mistakes[0]!.pieceLost, "n");
  });

  it("an even trade (4.Bxc6 dxc6) is not a loss", async () => {
    const f = await features(
      game(["e4", "e5", "Nf3", "Nc6", "Bb5", "a6", "Bxc6", "dxc6", "a3"], { judged: { 7: "inaccuracy" } }),
    );
    assert.equal(f.mistakes[0]!.pieceLost, undefined);
  });

  it("the player's recapture inside the window counts: 3.Nd5 Nxd5 4.exd5 loses nothing", async () => {
    const f = await features(game(["e4", "Nf6", "Nc3", "e5", "Nd5", "Nxd5", "exd5"], { judged: { 5: "inaccuracy" } }));
    assert.equal(f.mistakes[0]!.pieceLost, undefined);
  });

  it("a queen that grabs a pawn and is taken is a lost queen: 3...Qxd2+?? 4.Qxd2", async () => {
    const f = await features(
      game(["e4", "d5", "exd5", "Qxd5", "Nc3", "Qxd2+", "Qxd2"], { color: "black", judged: { 6: "blunder" } }),
    );
    // Black took a pawn (+1), then lost the queen (−9): down 8.
    assert.equal(f.mistakes[0]!.pieceLost, "q");
  });

  it("losing only a pawn is below the 2-point line", async () => {
    const f = await features(game(["e4", "d5", "a3", "dxe4", "a4"], { judged: { 3: "inaccuracy" } }));
    assert.equal(f.mistakes[0]!.pieceLost, undefined);
  });

  it("a mistake on the last move has no window and loses nothing", async () => {
    const f = await features(game(SCHOLAR, { evals: SCHOLAR_EVALS, judged: { 7: "inaccuracy" } }));
    assert.equal(f.mistakes[0]!.pieceLost, undefined);
  });
});

describe("extractFeatures: squares", () => {
  it("castling is the king's destination square", async () => {
    const f = await features(game(["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5", "O-O"], { judged: { 7: "inaccuracy" } }));
    assert.equal(f.mistakes[0]!.square, "g1");
    assert.equal(f.mistakes[0]!.san, "O-O");
  });

  it("a promotion is the promotion square, and the new queen counts as material", async () => {
    // A real game from the division fixture: ply 112 (an even ply, so Black's move) is c1=Q.
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/lichess-division.json", import.meta.url), "utf8")) as {
      games: { id: string; moves: string }[];
    };
    const moves = fixture.games.find((g) => g.id === "EAm64S20")!.moves.split(" ");
    assert.equal(moves[111], "c1=Q");
    const f = await features(game(moves, { color: "black", judged: { 112: "inaccuracy" } }));
    assert.equal(f.mistakes[0]!.square, "c1");
    assert.equal(f.mistakes[0]!.san.startsWith("c1=Q"), true);
  });
});

describe("extractFeatures: clocks", () => {
  const moves = ["e4", "e5", "Nf3", "Nc6", "Bc4", "Bc5"];
  it("records clock left and time trouble (under 10% of the starting time)", async () => {
    const f = await features(
      game(moves, {
        timeControl: "60+0",
        clocks: [58, 59, 30, 50, 5, 45], // White: 58, 30, 5 seconds left
        judged: { 3: "mistake", 5: "blunder" },
      }),
    );
    assert.deepEqual(
      f.mistakes.map((m) => [m.ply, m.clockLeft, m.timeTrouble]),
      [
        [3, 30, false],
        [5, 5, true],
      ],
    );
    // White's three moves: 58/60 = 97%, 30/60 = 50% (not over 50), 5/60 = 8%.
    assert.deepEqual(f.moveCounts.clock, { over50: 1, from25to50: 1, from10to25: 0, under10: 1 });
  });

  it("daily games and games without a clock record no clock data", async () => {
    for (const extra of [
      { timeControl: "1/86400", clocks: [1, 1, 1, 1, 1, 1] },
      { timeControl: "60+0", clocks: undefined },
      { timeControl: "60+0", clocks: [1, 2] }, // doesn't line up with the plies
    ]) {
      const f = await features(game(moves, { ...extra, judged: { 3: "mistake" } }));
      assert.equal(f.mistakes[0]!.clockLeft, undefined);
      assert.equal(f.mistakes[0]!.timeTrouble, undefined);
      assert.equal(f.moveCounts.clock, undefined);
    }
  });

  it("initialSeconds and clockBucket", () => {
    assert.equal(initialSeconds("180+2"), 180);
    assert.equal(initialSeconds("600"), 600);
    assert.equal(initialSeconds("1/259200"), undefined);
    assert.equal(initialSeconds(undefined), undefined);
    assert.equal(initialSeconds("-"), undefined);
    assert.equal(clockBucket(100, 60), "over50"); // increments can push the clock past the start
    assert.equal(clockBucket(30, 60), "from25to50");
    assert.equal(clockBucket(15, 60), "from10to25");
    assert.equal(clockBucket(6, 60), "from10to25"); // exactly 10% is not yet trouble
    assert.equal(clockBucket(5.9, 60), "under10");
  });
});

describe("extractFeatures: bad input is a stored error, not a crash", () => {
  it("an illegal move", async () => {
    assert.deepEqual(await extractFeatures(game(["e4", "e5", "Ke3"])), { version: FEATURES_VERSION, error: "replay_failed" });
  });
  it("an error from maybeYield (the job was aborted) propagates instead of becoming replay_failed", async () => {
    let calls = 0;
    const maybeYield = () => {
      if (++calls === 3) throw new Error("lease lost");
    };
    await assert.rejects(extractFeatures(game(SCHOLAR), { maybeYield }), /lease lost/);
  });
  it("plies, evals or classifications that don't line up", async () => {
    const g = game(["e4", "e5"]);
    assert.ok("error" in (await extractFeatures({ ...g, plies: 3 })));
    assert.ok("error" in (await extractFeatures({ ...g, evals: [{ cp: 0 }] })));
    assert.ok("error" in (await extractFeatures({ ...g, classifications: ["good"] })));
  });
});

describe("extractFeatures: on 40 real games (division fixture)", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/lichess-division.json", import.meta.url), "utf8")) as {
    games: { id: string; moves: string; division: Division }[];
  };

  it("one entry per judged player move, phases agree with Lichess's division, FENs are normalized", async () => {
    for (const [i, g] of fixture.games.slice(0, 40).entries()) {
      const moves = g.moves.split(" ");
      const color = i % 2 === 0 ? "white" : "black";
      // Judge every move of both sides: only the player's must come out.
      const judged = Object.fromEntries(moves.map((_, j) => [j + 1, "inaccuracy" as const]));
      const f = await features(game(moves, { color, judged }));
      const playerPlies = moves.map((_, j) => j + 1).filter((ply) => moverOfPly(ply) === color);
      assert.deepEqual(f.mistakes.map((m) => m.ply), playerPlies, g.id);
      assert.deepEqual(f.division, g.division, g.id);
      for (const m of f.mistakes) {
        assert.equal(m.phase, phaseOfPly(g.division, m.ply), `${g.id} ply ${m.ply}`);
        assert.equal(m.fen.split(" ").length, 4);
      }
      const counted = f.moveCounts.opening + f.moveCounts.middlegame + f.moveCounts.endgame;
      assert.equal(counted, playerPlies.length, g.id);
    }
  });

  it("calls maybeYield once per ply", async () => {
    const moves = fixture.games[0]!.moves.split(" ");
    let calls = 0;
    await extractFeatures(game(moves), { maybeYield: () => void calls++ });
    assert.equal(calls, moves.length);
  });
});
