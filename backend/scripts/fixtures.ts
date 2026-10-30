// Small games shaped like real API responses (checked against live Chess.com and Lichess
// data on 30 Oct 2026), trimmed to what the importers read.
import type { ChessComGame } from "../src/importers/chesscom.js";
import type { LichessGame } from "../src/importers/lichess.js";

// Scholar's mate: 7 plies.
const MOVES_CLK =
  "1. e4 {[%clk 0:02:59.9]} 1... e5 {[%clk 0:02:58.1]} 2. Qh5 {[%clk 0:02:57]} 2... Nc6 {[%clk 0:02:55]} " +
  "3. Bc4 {[%clk 0:02:50]} 3... Nf6 {[%clk 0:02:40]} 4. Qxf7# {[%clk 0:02:45]} 1-0";

export function chessComPgn(white: string, black: string, extraHeaders: string[] = []): string {
  const headers = [
    `[Event "Live Chess"]`,
    `[Site "Chess.com"]`,
    `[White "${white}"]`,
    `[Black "${black}"]`,
    `[Result "1-0"]`,
    `[ECO "C20"]`,
    `[ECOUrl "https://www.chess.com/openings/Kings-Pawn-Opening-Wayward-Queen-Attack"]`,
    `[TimeControl "180"]`,
    ...extraHeaders,
  ];
  return `${headers.join("\n")}\n\n${MOVES_CLK}`;
}

let nextId = 1000;

export function chessComGame(overrides: Partial<ChessComGame> & { endTime?: Date } = {}): ChessComGame {
  const { endTime = new Date("2026-10-15T12:00:00Z"), ...rest } = overrides;
  const id = nextId++;
  return {
    url: `https://www.chess.com/game/live/${id}`,
    pgn: chessComPgn("Alice", "bob"),
    time_control: "180",
    end_time: Math.floor(endTime.getTime() / 1000),
    rules: "chess",
    time_class: "blitz",
    initial_setup: "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
    white: { username: "Alice", rating: 1500, result: "win" },
    black: { username: "bob", rating: 1480, result: "checkmated" },
    ...rest,
  };
}

const LICHESS_PGN =
  `[Event "Rated blitz game"]\n[Site "https://lichess.org/abcd1234"]\n[White "alice"]\n[Black "Bob"]\n[Result "1-0"]\n\n` +
  "1. e4 { [%eval 0.3] [%clk 0:03:00] } 1... e5 { [%eval 0.3] [%clk 0:03:00] } 2. Qh5 { [%eval 0.1] [%clk 0:02:58] } " +
  "2... Nc6 { [%eval 0.2] [%clk 0:02:57] } 3. Bc4 { [%eval 0.1] [%clk 0:02:55] } 3... Nf6 { [%eval #1] [%clk 0:02:50] } " +
  "4. Qxf7# { [%clk 0:02:54] } 1-0";

export function lichessGame(overrides: Partial<LichessGame> = {}): LichessGame {
  const id = `g${nextId++}`;
  return {
    id,
    variant: "standard",
    speed: "blitz",
    createdAt: Date.parse("2026-10-15T12:00:00Z"),
    lastMoveAt: Date.parse("2026-10-15T12:05:00Z"),
    status: "mate",
    players: {
      white: { user: { name: "alice", id: "alice" }, rating: 1600 },
      black: { user: { name: "Bob", id: "bob" }, rating: 1550 },
    },
    winner: "white",
    moves: "e4 e5 Qh5 Nc6 Bc4 Nf6 Qxf7#",
    pgn: LICHESS_PGN,
    clock: { initial: 180, increment: 0 },
    // Centiseconds, one more entry than plies, as Lichess sends them.
    clocks: [18003, 18003, 17800, 17700, 17500, 17000, 17400, 17400],
    opening: { eco: "C20", name: "King's Pawn Game: Wayward Queen Attack", ply: 3 },
    ...overrides,
  };
}

// One eval per ply (7), White's point of view, ending in mate.
export const LICHESS_ANALYSIS = [{ eval: 30 }, { eval: 30 }, { eval: 10 }, { eval: 20 }, { eval: 10 }, { mate: 1 }, { mate: 0 }];
