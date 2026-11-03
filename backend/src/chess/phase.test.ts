import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Chess } from "chess.js";
import { board64 } from "./fen.js";
import { divide, phaseOfPly, type Board64, type Division } from "./phase.js";

// 200 real Lichess games (100 EricRosen, 100 DrNykterstein) with Lichess's own `division`,
// fetched by scripts/fetchDivisionFixture.ts. Lichess computes it with the Divider we port.
const fixture = JSON.parse(readFileSync(new URL("./fixtures/lichess-division.json", import.meta.url), "utf8")) as {
  games: { id: string; moves: string; division: Division }[];
};

function boardsOf(moves: string): Board64[] {
  const chess = new Chess();
  const boards = [board64(chess)];
  for (const san of moves.split(" ")) {
    chess.move(san);
    boards.push(board64(chess));
  }
  return boards;
}

const fromFen = (fen: string) => board64(new Chess(fen));

describe("divide: against Lichess's own division", () => {
  it("matches every one of the 200 real games exactly", () => {
    const mismatches: string[] = [];
    for (const g of fixture.games) {
      const ours = divide(boardsOf(g.moves));
      if (ours.middle !== g.division.middle || ours.end !== g.division.end) {
        mismatches.push(`${g.id}: lichess ${JSON.stringify(g.division)} ours ${JSON.stringify(ours)}`);
      }
    }
    assert.equal(fixture.games.length, 200);
    assert.deepEqual(mismatches, []);
  });

  // So the match above means something: 148 games reach an endgame, 48 stop in the
  // middlegame, 4 end in the opening (short games).
  it("covers every shape: opening only, middlegame only, middlegame + endgame", () => {
    const count = (middle: boolean, end: boolean) =>
      fixture.games.filter((g) => (g.division.middle !== undefined) === middle && (g.division.end !== undefined) === end)
        .length;
    assert.equal(count(true, true), 148);
    assert.equal(count(true, false), 48);
    assert.equal(count(false, false), 4);
  });
});

describe("divide: the rules one by one", () => {
  it("the start position is the opening", () => {
    assert.deepEqual(divide([fromFen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")]), {});
  });

  it("a sparse back rank (3 white pieces on rank 1) starts the middlegame", () => {
    // White has developed: only Ra1, Ke1, Rh1 left on rank 1. Nothing else qualifies.
    const b = fromFen("rnbqkbnr/pppppppp/8/8/8/2NBBN2/PPPPQPPP/R3K2R w KQkq - 0 1");
    assert.deepEqual(divide([b]), { middle: 0 });
  });

  it("≤ 6 majors + minors after a middlegame is the endgame", () => {
    const middle = fromFen("r3k2r/pppq1ppp/2n1bn2/8/8/2N1BN2/PPPQ1PPP/R3K2R w KQkq - 0 1");
    const end = fromFen("4k2r/ppp2ppp/2n5/8/8/5N2/PPP2PPP/R3K3 w - - 0 1");
    assert.deepEqual(divide([middle, end]), { middle: 0, end: 1 });
  });

  it("when the middlegame and endgame start on the same position, only the endgame counts", () => {
    // ≤ 6 majors + minors is also ≤ 10, so this position starts both phases at once.
    const b = fromFen("4k3/pppppppp/8/8/8/8/PPPPPPPP/4K3 w - - 0 1");
    assert.deepEqual(divide([b]), { end: 0 });
  });

  it("mixedness alone can start the middlegame", () => {
    // Real game vTuFsuY9 (fixture), plies 21 and 22: 12 majors + minors and 4+ pieces on each
    // back rank both times, so only mixedness can tell them apart. 11...Nxg4 puts a black
    // knight among White's pieces, and Lichess's middlegame starts right there (ply 22).
    const before = fromFen("r1bqk1r1/ppp2p2/1bnp1n1p/4p3/4P1P1/2PPB3/PPQ1BPPN/RN3RK1 b q - 0 11");
    const after = fromFen("r1bqk1r1/ppp2p2/1bnp3p/4p3/4P1n1/2PPB3/PPQ1BPPN/RN3RK1 w q - 0 12");
    assert.deepEqual(divide([before, after]), { middle: 1 });
  });
});

describe("phaseOfPly", () => {
  const d: Division = { middle: 20, end: 60 };
  it("uses the position the move was played from", () => {
    assert.equal(phaseOfPly(d, 20), "opening"); // played from the position after 19 plies
    assert.equal(phaseOfPly(d, 21), "middlegame"); // from the position after 20 plies
    assert.equal(phaseOfPly(d, 60), "middlegame");
    assert.equal(phaseOfPly(d, 61), "endgame");
  });
  it("no division at all: everything is the opening", () => {
    assert.equal(phaseOfPly({}, 80), "opening");
  });
  it("endgame without a middlegame", () => {
    assert.equal(phaseOfPly({ end: 30 }, 30), "opening");
    assert.equal(phaseOfPly({ end: 30 }, 31), "endgame");
  });
});
