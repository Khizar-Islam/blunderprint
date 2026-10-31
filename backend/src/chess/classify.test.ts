import { test } from "node:test";
import assert from "node:assert/strict";
import fixtures from "./fixtures/lichess-analysed.json" with { type: "json" };
import {
  averageAccuracy,
  classifyGame,
  judgeMove,
  moveAccuracy,
  START_EVAL,
  whiteWinPercent,
  winningChances,
  type Eval,
  type Judgement,
} from "./classify.js";

// The cp at which winningChances crosses a given value: solves 2 / (1 + e^(−k·cp)) − 1 = w.
const cpForChances = (w: number) => Math.log((1 + w) / (1 - w)) / 0.00368208;

test("winningChances: Lichess's curve, symmetric, 0 at equality", () => {
  assert.equal(winningChances(0), 0);
  assert.ok(Math.abs(winningChances(300) + winningChances(-300)) < 1e-12);
  // Spot value worked out by hand: 2 / (1 + e^(−0.00368208·100)) − 1
  assert.ok(Math.abs(winningChances(100) - 0.18203) < 1e-4);
  assert.ok(winningChances(5000) < 1 && winningChances(5000) > 0.99);
});

test("whiteWinPercent: capped at ±1000 cp, mates count as ±1000, mate 0 = side to move lost", () => {
  assert.equal(whiteWinPercent({ cp: 0 }, 1), 50);
  assert.equal(whiteWinPercent({ cp: 5000 }, 1), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: 3 }, 1), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: -3 }, 1), whiteWinPercent({ cp: -1000 }, 1));
  // After an odd number of plies Black is to move: mate 0 means Black is mated, White won.
  assert.equal(whiteWinPercent({ mate: 0 }, 5), whiteWinPercent({ cp: 1000 }, 1));
  assert.equal(whiteWinPercent({ mate: 0 }, 6), whiteWinPercent({ cp: -1000 }, 1));
});

test("cp judgements: thresholds 0.1 / 0.2 / 0.3 of win chances, from the mover's side", () => {
  // White (ply 1) starts from 0 and drops to just past / just short of each threshold.
  const cases: [number, Judgement | null][] = [
    [0.099, null],
    [0.101, "inaccuracy"],
    [0.199, "inaccuracy"],
    [0.201, "mistake"],
    [0.299, "mistake"],
    [0.301, "blunder"],
  ];
  for (const [drop, expected] of cases) {
    const after = -cpForChances(drop);
    assert.equal(judgeMove({ cp: 0 }, { cp: after }, 1), expected, `White drop ${drop}`);
    // The same drop for Black (ply 2) is the mirror image in White's view.
    assert.equal(judgeMove({ cp: 0 }, { cp: -after }, 2), expected, `Black drop ${drop}`);
  }
  // Gaining win chances is never judged.
  assert.equal(judgeMove({ cp: 0 }, { cp: 900 }, 1), null);
  assert.equal(judgeMove({ cp: 0 }, { cp: -900 }, 2), null);
});

test("cp judgements use the raw cp, not the ±1000 display cap (lila CpAdvice)", () => {
  // +2000 → +700: raw chances 0.9987 → 0.8584, a 0.14 drop (inaccuracy). With the display cap
  // it would be 1000 → 700, only 0.093, and no judgement.
  assert.equal(judgeMove({ cp: 2000 }, { cp: 700 }, 1), "inaccuracy");
  assert.equal(judgeMove({ cp: 1000 }, { cp: 700 }, 1), null);
});

test("MateCreated: walking into a forced mate", () => {
  // White to move at ply 1; afterwards Black mates (mate < 0 in White's view).
  assert.equal(judgeMove({ cp: 50 }, { mate: -4 }, 1), "blunder");
  assert.equal(judgeMove({ cp: -800 }, { mate: -4 }, 1), "mistake"); // already worse than −700
  assert.equal(judgeMove({ cp: -1200 }, { mate: -4 }, 1), "inaccuracy"); // already lost
  // Same for Black (ply 2): White mates afterwards.
  assert.equal(judgeMove({ cp: -50 }, { mate: 4 }, 2), "blunder");
  assert.equal(judgeMove({ cp: 800 }, { mate: 4 }, 2), "mistake");
});

test("MateLost: letting a forced mate go", () => {
  assert.equal(judgeMove({ mate: 3 }, { cp: 300 }, 1), "blunder");
  assert.equal(judgeMove({ mate: 3 }, { cp: 800 }, 1), "mistake");
  assert.equal(judgeMove({ mate: 3 }, { cp: 1500 }, 1), "inaccuracy"); // still totally winning
  assert.equal(judgeMove({ mate: 3 }, { mate: -2 }, 1), "blunder"); // and now getting mated
  assert.equal(judgeMove({ mate: -3 }, { cp: -300 }, 2), "blunder"); // Black had mate
});

test("mate → mate: delayed, faster, or the loser's mate getting longer is never judged", () => {
  assert.equal(judgeMove({ mate: 3 }, { mate: 5 }, 1), null); // MateDelayed
  assert.equal(judgeMove({ mate: 5 }, { mate: 2 }, 1), null);
  assert.equal(judgeMove({ mate: -3 }, { mate: -2 }, 1), null); // White was getting mated anyway
  assert.equal(judgeMove({ cp: 400 }, { mate: 6 }, 1), null); // finding a mate is good
});

test("delivering checkmate: { mate: 0 } after the move is never judged", () => {
  assert.equal(judgeMove({ mate: 1 }, { mate: 0 }, 1), null); // White mates, Black to move is mated
  assert.equal(judgeMove({ mate: -1 }, { mate: 0 }, 2), null); // Black mates
  assert.equal(judgeMove({ cp: 900 }, { mate: 0 }, 1), null);
});

test("classifyGame: ply 1 is judged against the +15 start eval", () => {
  assert.deepEqual(START_EVAL, { cp: 15 });
  const [first] = classifyGame({ evals: [{ cp: 15 - 300 }] });
  assert.equal(first, "blunder");
  assert.deepEqual(classifyGame({ evals: [{ cp: 20 }, { cp: 30 }] }), ["good", "good"]);
});

test("classifyGame: the engine's best move is 'best' and never judged (lila hasVariation)", () => {
  // White's move loses a lot of eval on paper, but it was the engine's own best move:
  // the drop is search noise between depths, not a mistake.
  const evals: Eval[] = [{ cp: 20 }, { cp: 400 }, { cp: 50 }];
  const moves = ["e2e4", "e7e5", "g1f3"];
  assert.deepEqual(classifyGame({ evals }), ["good", "blunder", "blunder"]);
  assert.deepEqual(classifyGame({ evals, moves, best: ["e2e4", "d7d5", "g1f3"] }), ["best", "blunder", "best"]);
  // No best move known for a ply (null) falls back to the formula.
  assert.deepEqual(classifyGame({ evals, moves, best: [null, null, null] }), ["good", "blunder", "blunder"]);
});

test("classifyGame with Lichess judgements uses them as is", () => {
  assert.deepEqual(classifyGame({ evals: [{ cp: 20 }, { cp: 400 }], judgments: [null, "mistake"] }), ["good", "mistake"]);
});

// Real games analysed by Lichess (see fixtures/lichess-analysed.json; trimmed exports of the
// three games, fetched once on 31 Oct 2026). Our formula must agree with every judgement Lichess
// made. It may add judgements Lichess skipped, but only small ones, which is why imported games
// use Lichess's own labels (see ClassifyInput.judgments).
interface FixtureGame {
  id: string;
  analysis: { eval?: number; mate?: number; judgment?: "Inaccuracy" | "Mistake" | "Blunder" }[];
}

test("our formula reproduces every judgement Lichess made on 3 real games", () => {
  let lichessJudged = 0;
  let extra = 0;
  for (const game of fixtures as FixtureGame[]) {
    const evals = game.analysis.map((a): Eval => (a.mate !== undefined ? { mate: a.mate } : { cp: a.eval }));
    const ours = classifyGame({ evals });
    game.analysis.forEach((a, i) => {
      const theirs = a.judgment?.toLowerCase();
      if (theirs) {
        lichessJudged++;
        assert.equal(ours[i], theirs, `${game.id} ply ${i + 1}`);
      } else if (ours[i] !== "good") {
        extra++;
        assert.equal(ours[i], "inaccuracy", `${game.id} ply ${i + 1}: only small extras allowed`);
      }
    });
  }
  assert.equal(lichessJudged, 50);
  assert.equal(extra, 3);
});

test("the checkmate fixture ends in { mate: 0 }, Lichess's convention we rely on", () => {
  const game = (fixtures as FixtureGame[]).find((g) => g.id === "OrcHj6YF")!;
  assert.deepEqual(game.analysis.at(-1), { mate: 0 });
});

test("moveAccuracy: Lichess's curve, 100 when nothing was lost, clamped to 0–100", () => {
  assert.equal(moveAccuracy(50, 50), 100);
  assert.equal(moveAccuracy(50, 70), 100);
  // 0 win% lost would give 103.17 − 3.17 + 1 = 101, capped at 100.
  assert.equal(moveAccuracy(50, 49.999), 100);
  const tenPoints = moveAccuracy(60, 50);
  assert.ok(Math.abs(tenPoints - (103.1668100711649 * Math.exp(-0.4354415386753951) - 3.166924740191411 + 1)) < 1e-9);
  assert.equal(moveAccuracy(100, 0), 0);
});

test("averageAccuracy: only the given side's moves count", () => {
  // White keeps its eval, Black throws the game away.
  const evals: Eval[] = [{ cp: 15 }, { cp: 600 }, { cp: 600 }, { cp: 1200 }];
  assert.equal(averageAccuracy(evals, "white"), 100);
  assert.ok(averageAccuracy(evals, "black")! < 50);
  assert.equal(averageAccuracy([{ cp: 20 }], "black"), undefined);
});
