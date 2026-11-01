import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildTimeline, uciToSan } from "./timeline";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("buildTimeline", () => {
  test("an illegal move → null", () => {
    // 3. O-O is illegal: the bishop is still on f1.
    assert.equal(buildTimeline('[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. O-O *'), null);
  });

  test("one more position than plies; SAN, UCI and who moved", () => {
    const t = buildTimeline("1. e4 e5 2. Nf3 Nc6 3. Bc4 Nf6 4. O-O *")!;
    assert.equal(t.fens.length, 8);
    assert.equal(t.fens[0], START);
    assert.equal(t.plies.length, 7);
    assert.deepEqual(t.plies[0], { san: "e4", uci: "e2e4", from: "e2", to: "e4", color: "white" });
    assert.deepEqual(t.plies[1]!.color, "black");
    assert.deepEqual(t.plies[6], { san: "O-O", uci: "e1g1", from: "e1", to: "g1", color: "white" });
    assert.match(t.fens[7]!, /^r1bqkb1r\/pppp1ppp\/2n2n2\/4p3\/2B1P3\/5N2\/PPPP1PPP\/RNBQ1RK1 b kq/);
  });

  test("no moves: just the start position", () => {
    assert.deepEqual(buildTimeline('[Result "1-0"]\n\n1-0'), { fens: [START], plies: [] });
  });
});

describe("uciToSan", () => {
  test("turns an engine move into SAN in that position", () => {
    assert.equal(uciToSan(START, "g1f3"), "Nf3");
    assert.equal(uciToSan("8/P6k/8/8/8/8/8/K7 w - - 0 1", "a7a8q"), "a8=Q");
  });

  test("an illegal move → null", () => {
    assert.equal(uciToSan(START, "e2e5"), null);
  });
});
