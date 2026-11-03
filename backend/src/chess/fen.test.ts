import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { board64, normalizedFenOf, normalizeFen } from "./fen.js";

describe("normalizeFen", () => {
  it("drops the halfmove clock and fullmove number", () => {
    assert.equal(
      normalizeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"),
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
    );
    // Same position reached later in the game: same key.
    assert.equal(
      normalizeFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 12 40"),
      "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -",
    );
  });

  it("drops an en-passant square no pawn can capture on (written after every double push by some sites)", () => {
    assert.equal(
      normalizeFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1"),
      "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -",
    );
  });

  it("keeps the en-passant square when the capture is legal", () => {
    // 1.e4 a6 2.e5 d5: exd6 e.p. is legal.
    assert.equal(
      normalizeFen("rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6 0 3"),
      "rnbqkbnr/1pp1pppp/p7/3pP3/8/8/PPPP1PPP/RNBQKBNR w KQkq d6",
    );
    // Black capturing: 1.a3 e5 2.a4 e4 3.d4, and now exd3 e.p. is legal.
    assert.equal(
      normalizeFen("rnbqkbnr/pppp1ppp/8/8/P2Pp3/8/1PP1PPPP/RNBQKBNR b KQkq d3 0 3"),
      "rnbqkbnr/pppp1ppp/8/8/P2Pp3/8/1PP1PPPP/RNBQKBNR b KQkq d3",
    );
  });

  it("drops it when the capturing pawn is pinned to its king on a diagonal", () => {
    // Bishop g7, pawn e5, king c3 on one diagonal: exd6 would leave the king in check.
    assert.equal(normalizeFen("8/6b1/8/3pP3/8/2K5/8/7k w - d6 0 1"), "8/6b1/8/3pP3/8/2K5/8/7k w - -");
  });

  it("drops it when the capture would empty the rank between king and rook", () => {
    // King a5, pawns d5 + e5, rook h5: exd6 removes both pawns from rank 5 at once.
    assert.equal(normalizeFen("8/8/8/K2pP2r/8/8/8/4k3 w - d6 0 1"), "8/8/8/K2pP2r/8/8/8/4k3 w - -");
  });

  it("accepts a 4-field FEN (EPD style) and gives the same key", () => {
    assert.equal(
      normalizeFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3"),
      normalizeFen("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1"),
    );
  });

  it("throws on something that isn't a FEN", () => {
    assert.throws(() => normalizeFen("hello"));
    assert.throws(() => normalizeFen("rnbqkbnr/pppppppp/8/8 w KQkq e9 0 1"));
    assert.throws(() => normalizeFen("rnbqkbnr/pppppppp/8/8 w KQkq - 0 1")); // no e.p. square to check, still validated
  });
});

describe("normalizedFenOf", () => {
  it("gives the same key as normalizeFen while replaying", () => {
    const chess = new Chess();
    for (const san of ["e4", "a6", "e5", "d5", "exd6", "Nf6", "dxc7", "Nc6", "cxd8=Q"]) {
      chess.move(san);
      assert.equal(normalizedFenOf(chess), normalizeFen(chess.fen()), `after ${san}`);
    }
  });

  it("keeps the en-passant square exactly when the capture is legal", () => {
    const chess = new Chess();
    for (const san of ["e4", "a6", "e5", "d5"]) chess.move(san);
    assert.match(normalizedFenOf(chess), / d6$/);
    chess.move("a3");
    assert.match(normalizedFenOf(chess), / -$/);
  });
});

describe("board64", () => {
  it("puts a1 at 0 and h8 at 63", () => {
    const b = board64(new Chess());
    assert.deepEqual(b[0], { color: "w", type: "r" }); // a1
    assert.deepEqual(b[4], { color: "w", type: "k" }); // e1
    assert.deepEqual(b[60], { color: "b", type: "k" }); // e8
    assert.deepEqual(b[63], { color: "b", type: "r" }); // h8
    assert.equal(b[27], null); // d4
    assert.equal(b.filter((s) => s !== null).length, 32);
  });
});
