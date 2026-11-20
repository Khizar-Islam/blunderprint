import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Chess } from "chess.js";
import { sanFrom } from "./sanFrom.js";

describe("sanFrom: the square a move started from, from the FEN and the SAN alone", () => {
  it("pieces, pawns, captures, checks and promotions", () => {
    // The landing page's own example: 47. Nd4 from f3.
    assert.equal(sanFrom("6k1/7p/8/8/1B2r3/P3pN1P/4K3/8 w - -", "Nd4"), "f3");
    assert.equal(sanFrom("6k1/7p/8/8/1B2r3/P3pN1P/4K3/8 w - -", "Kd3"), "e2");
    assert.equal(sanFrom("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -", "e4"), "e2");
    assert.equal(sanFrom("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -", "e3"), "e2");
    assert.equal(sanFrom("rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -", "Nf6"), "g8");
    assert.equal(sanFrom("rnbqkbnr/ppp1pppp/8/3p4/4P3/8/PPPP1PPP/RNBQKBNR w KQkq -", "exd5"), "e4");
    assert.equal(sanFrom("4k3/P7/8/8/8/8/8/4K3 w - -", "a8=Q+"), "a7");
    assert.equal(sanFrom("1r2k3/P7/8/8/8/8/8/4K3 w - -", "axb8=N"), "a7");
    assert.equal(sanFrom("4k3/8/8/8/8/8/5q2/4K3 b - -", "Qe2#"), "f2");
  });

  it("en passant: the pawn comes from the file SAN names, one rank back", () => {
    assert.equal(sanFrom("4k3/8/8/3pP3/8/8/8/4K3 w - d6", "exd6"), "e5");
    assert.equal(sanFrom("4k3/8/8/8/3pP3/8/8/4K3 b - e3", "dxe3"), "d4");
  });

  it("castling starts on the king's square", () => {
    assert.equal(sanFrom("r3k2r/8/8/8/8/8/8/R3K2R w KQkq -", "O-O"), "e1");
    assert.equal(sanFrom("r3k2r/8/8/8/8/8/8/R3K2R b KQkq -", "O-O-O"), "e8");
  });

  it("SAN's own disambiguation picks the piece: by file, by rank, by both", () => {
    assert.equal(sanFrom("4k3/8/8/8/8/8/8/R3K2R w - -", "Rad1"), "a1");
    assert.equal(sanFrom("4k3/8/8/8/8/8/8/R3K2R w - -", "Rhf1"), "h1");
    assert.equal(sanFrom("R3k3/8/8/8/8/8/8/R3K3 w - -", "R1a4"), "a1");
    assert.equal(sanFrom("4k3/8/8/8/Q6Q/8/8/Q3K3 w - -", "Qa4d1"), "a4");
  });

  it("a piece that is blocked doesn't count: the other rook is the one", () => {
    // Both rooks are on the d-file's lines, but the a1 rook's way to d1 is blocked by the knight.
    assert.equal(sanFrom("3rk3/8/8/8/8/8/8/RN2K2R w - -", "Rd1"), null, "no white rook reaches d1");
    assert.equal(sanFrom("4k3/8/8/8/8/8/8/RN1K3R w - -", "Re1"), "h1");
  });

  it("not certain without checking pins → null, never a guess", () => {
    // Two knights reach d4; the c2 knight is pinned to the king on c1 by the rook on c8, so
    // SAN says plain Nd4. Geometry alone can't tell which: null.
    assert.equal(sanFrom("2r1k3/8/8/8/8/5N2/2N5/2K5 w - -", "Nd4"), null);
  });

  it("nonsense is null", () => {
    assert.equal(sanFrom("8/8/8/8/8/8/8/8 w - -", "e4"), null);
    assert.equal(sanFrom("not a fen", "e4"), null);
    assert.equal(sanFrom("4k3/8/8/8/8/8/8/4K3 w - -", "Zz9"), null);
  });

  it("agrees with chess.js on every legal move of 12 random games' positions (or says null)", () => {
    // A fixed pseudo-random sequence, so the test is the same every run.
    let seed = 20261120;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    let checked = 0;
    let unknown = 0;
    for (let g = 0; g < 12; g++) {
      const chess = new Chess();
      for (let ply = 0; ply < 80 && !chess.isGameOver(); ply++) {
        const fen = chess.fen();
        const moves = chess.moves({ verbose: true });
        for (const mv of moves) {
          const from = sanFrom(fen, mv.san);
          checked++;
          if (from === null) unknown++;
          else assert.equal(from, mv.from, `${fen} ${mv.san}`);
        }
        chess.move(moves[rand(moves.length)]!.san);
      }
    }
    assert.ok(checked > 8_000, `checked ${checked}`);
    // Null only in the pinned-twin case, which is rare.
    assert.ok(unknown / checked < 0.005, `${unknown} of ${checked} unknown`);
  });
});
