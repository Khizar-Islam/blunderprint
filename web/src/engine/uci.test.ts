import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseBestMove, parseInfo, SearchCollector, toWhitePov } from "./uci";

// Line shapes as Stockfish prints them (see the UCI spec and a real session in step 2).
describe("parseInfo", () => {
  test("reads depth, nodes, a cp score and the pv", () => {
    const info = parseInfo(
      "info depth 14 seldepth 19 multipv 1 score cp -34 nodes 101234 nps 812000 hashfull 40 tbhits 0 time 124 pv e7e5 g1f3 b8c6",
    );
    assert.deepEqual(info, { bound: false, depth: 14, nodes: 101234, score: { cp: -34 }, pv: ["e7e5", "g1f3", "b8c6"] });
  });

  test("reads a mate score", () => {
    assert.deepEqual(parseInfo("info depth 9 score mate -3 nodes 5000 pv h7h6")?.score, { mate: -3 });
  });

  test("reads the checkmated position's 'mate 0' (no pv)", () => {
    assert.deepEqual(parseInfo("info depth 0 score mate 0"), { bound: false, depth: 0, score: { mate: 0 } });
  });

  test("flags lowerbound / upperbound scores", () => {
    assert.equal(parseInfo("info depth 10 score cp 50 lowerbound nodes 9000 pv e2e4")?.bound, true);
    assert.equal(parseInfo("info depth 10 score cp 50 upperbound nodes 9000 pv e2e4")?.bound, true);
  });

  test("ignores info strings and non-info lines", () => {
    assert.equal(parseInfo("info string NNUE evaluation using nn-37f18f62d772.nnue enabled"), null);
    assert.equal(parseInfo("readyok"), null);
    assert.equal(parseInfo("bestmove e2e4"), null);
  });

  test("an info line without a score has no score", () => {
    assert.equal(parseInfo("info depth 3 currmove e2e4 currmovenumber 1")?.score, undefined);
  });

  test("rejects a garbled score", () => {
    assert.equal(parseInfo("info depth 3 score cp abc"), null);
    assert.equal(parseInfo("info depth 3 score wdl 500 400 100"), null);
  });
});

describe("parseBestMove", () => {
  test("reads the move, with or without ponder", () => {
    assert.equal(parseBestMove("bestmove e2e4 ponder e7e5"), "e2e4");
    assert.equal(parseBestMove("bestmove e7e8q"), "e7e8q");
  });

  test("(none) means there is no legal move", () => {
    assert.equal(parseBestMove("bestmove (none)"), null);
  });

  test("other lines aren't bestmove lines", () => {
    assert.equal(parseBestMove("info depth 1 score cp 10"), undefined);
  });
});

describe("toWhitePov", () => {
  test("White to move: unchanged", () => {
    assert.deepEqual(toWhitePov({ cp: 40 }, true), { cp: 40 });
    assert.deepEqual(toWhitePov({ mate: 2 }, true), { mate: 2 });
  });

  test("Black to move: flipped", () => {
    assert.deepEqual(toWhitePov({ cp: 40 }, false), { cp: -40 });
    assert.deepEqual(toWhitePov({ mate: 2 }, false), { mate: -2 }); // Black mates in 2
    assert.deepEqual(toWhitePov({ mate: -1 }, false), { mate: 1 }); // White mates in 1
  });

  test("mate 0 and cp 0 stay 0 (no -0)", () => {
    assert.ok(Object.is((toWhitePov({ mate: 0 }, false) as { mate: number }).mate, 0));
    assert.ok(Object.is((toWhitePov({ cp: 0 }, false) as { cp: number }).cp, 0));
  });
});

describe("SearchCollector", () => {
  test("keeps the last exact score, even after a later bound", () => {
    const c = new SearchCollector();
    c.push("info depth 10 score cp 20 nodes 1 pv e2e4");
    c.push("info depth 11 score cp 25 nodes 2 pv e2e4");
    c.push("info depth 12 score cp 60 lowerbound nodes 3 pv e2e4");
    assert.deepEqual(c.score, { cp: 25 });
  });

  test("falls back to a bound when no exact score came", () => {
    const c = new SearchCollector();
    c.push("info depth 1 score cp 60 upperbound nodes 3 pv e2e4");
    assert.deepEqual(c.score, { cp: 60 });
  });

  test("no score at all → undefined", () => {
    const c = new SearchCollector();
    c.push("info string hello");
    assert.equal(c.score, undefined);
  });
});
