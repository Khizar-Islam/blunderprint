import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replayPgn } from "./replay";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

describe("replayPgn", () => {
  test("a normal game becomes UCI moves, castling as the king's move", () => {
    const pgn = '[Event "Test"]\n[Result "*"]\n\n1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O Nf6 *';
    const r = replayPgn(pgn, 8);
    assert.deepEqual(r, {
      ok: true,
      startFen: START,
      moves: ["e2e4", "e7e5", "g1f3", "b8c6", "f1c4", "f8c5", "e1g1", "g8f6"],
    });
  });

  test("clock comments and a result are fine (Chess.com style)", () => {
    const pgn = '[Result "1-0"]\n\n1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:58.1]} 2. Qh5 Nc6 3. Bc4 Nf6 4. Qxf7# 1-0';
    const r = replayPgn(pgn, 7);
    assert.ok(r.ok);
    assert.equal(r.moves.at(-1), "h5f7");
  });

  test("promotion keeps the piece letter", () => {
    const pgn = '[SetUp "1"]\n[FEN "8/P6k/8/8/8/8/8/K7 w - - 0 1"]\n\n1. a8=Q *';
    const r = replayPgn(pgn, 1);
    assert.deepEqual(r, { ok: true, startFen: "8/P6k/8/8/8/8/8/K7 w - - 0 1", moves: ["a7a8q"] });
  });

  test("an illegal move → illegal_pgn", () => {
    assert.deepEqual(replayPgn("1. e4 e5 2. Ke3 *", 4), { ok: false, error: "illegal_pgn" });
  });

  test("a different move count than the server counted → ply_mismatch with the real count", () => {
    assert.deepEqual(replayPgn("1. e4 e5 2. Nf3 *", 4), { ok: false, error: "ply_mismatch", atPly: 3 });
  });

  test("a game with no moves", () => {
    assert.deepEqual(replayPgn('[Result "1-0"]\n\n1-0', 0), { ok: true, startFen: START, moves: [] });
  });
});
