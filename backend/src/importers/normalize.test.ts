import { test } from "node:test";
import assert from "node:assert/strict";
import { chessComPgn } from "../../scripts/fixtures.js";
import { countPlies, countPliesFromText } from "./normalize.js";

const headers = '[Event "Live Chess"]\n[White "alice"]\n[Black "bob"]\n[Result "*"]\n\n';

// Each case is a legal game, so chess.js (countPlies) is the reference: the cheap count must
// agree with it exactly, not just with the number written here.
const cases: [name: string, movetext: string, plies: number][] = [
  [
    "castling on both sides, with a check",
    "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. O-O d6 5. c3 Bg4 6. d4 Qd7 7. Bb5 O-O-O 8. Bxc6 Qxc6 9. Nxe5+ *",
    17,
  ],
  ["promotion with a capture", "1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Nbd7 5. bxa8=Q Qc7 *", 10],
  ["underpromotion with check", "1. e4 d5 2. exd5 c6 3. dxc6 Nf6 4. cxb7 Kd7?? 5. bxc8=N+ Ke8 *", 10],
  ["checkmate, ending mid-pair after White's move", "1. e4 e5 2. Bc4 Nc6 3. Qh5 Nf6?? 4. Qxf7# 1-0", 7],
  ["checkmate, ending on Black's move", "1. f3 e5 2. g4 Qh4# 0-1", 4],
  [
    "Chess.com clocks in comments and Black move numbers",
    "1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:59]} 2. Nf3 {[%clk 0:02:58.1]} 2... Nc6 {[%clk 0:02:57]} 3. Bb5 {[%clk 0:02:55.5]} 1/2-1/2",
    5,
  ],
  [
    "nested variations, NAGs, a rest-of-line comment and glued move numbers",
    "1.e4 $1 e5 (1...c5 2.Nf3 (2.c3 d5) d6) 2.Nf3 $14 ; a comment (with brackets\n2...Nc6 {a comment (with brackets)} 3.Bb5 a6 *",
    6,
  ],
  ["disambiguated moves", "1. Nf3 Nf6 2. Nc3 Nc6 3. Ne4 Ne5 4. Nfg5 Nfg4 5. Nf3 Nxf3+ 6. exf3 *", 11],
  ["no moves at all (an aborted game)", "*", 0],
];

for (const [name, movetext, plies] of cases) {
  test(`countPliesFromText: ${name}`, () => {
    const pgn = headers + movetext;
    assert.equal(countPlies(pgn), plies, "chess.js reference");
    assert.equal(countPliesFromText(pgn), plies);
  });
}

test("countPliesFromText: a real Chess.com PGN, header values with brackets ignored", () => {
  const pgn = chessComPgn("alice", "bob").replace('[Event "', '[Event "Titled {Arena} (round 1) ');
  assert.equal(countPliesFromText(pgn), countPlies(pgn));
});

test("countPliesFromText: movetext that isn't SAN gives null", () => {
  for (const movetext of ["1. e4 e5 2. hello *", "1. e4 ( e5 *", "1. e4 { unclosed *", "1. e4 e5 2. Zz9 *", "1. e9 *"]) {
    assert.equal(countPliesFromText(headers + movetext), null, movetext);
  }
});

test("countPliesFromText: an illegal but SAN-shaped move still counts (the engine catches it in Stage 2)", () => {
  const pgn = headers + "1. e4 e5 2. Ke3 Qh4 *";
  assert.equal(countPlies(pgn), null);
  assert.equal(countPliesFromText(pgn), 4);
});
