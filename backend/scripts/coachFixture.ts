import type { Types } from "mongoose";
import { moverOfPly } from "../src/chess/classify.js";
import { clockBucket, FEATURES_VERSION, initialSeconds, type MoveCounts } from "../src/chess/features.js";
import { phaseOfPly, type Division } from "../src/chess/phase.js";

// Games for the coach tests whose features agree with each other the way the extract job's do
// (chess/features.ts): each mistake's phase comes from the division, its clock from the clocks,
// and moveCounts count the player's moves per phase and clock bucket. The candidate scan
// recounts moves from the division and clocks, so inconsistent fixtures would test nothing.

export const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -";

export interface CoachGameOptions {
  playerId: Types.ObjectId;
  sourceId: string;
  day: number; // October 2026, for playedAt
  color?: "white" | "black";
  speed?: "bullet" | "blitz" | "rapid" | "classical";
  result?: "win" | "draw" | "loss";
  eco?: string;
  openingName?: string;
  plies?: number;
  division?: Division;
  timeControl?: string;
  // Seconds left after each ply; leave out for a game without clocks.
  clockAt?: (ply: number) => number;
  mistakes: { ply: number; kind: "inaccuracy" | "mistake" | "blunder"; winDrop?: number }[];
}

export function coachGame(o: CoachGameOptions) {
  const color = o.color ?? "white";
  const plies = o.plies ?? 60;
  const division = o.division ?? { middle: 20, end: 40 };
  const timeControl = o.timeControl ?? "180+0";
  const initial = initialSeconds(timeControl);
  const clocks = o.clockAt ? Array.from({ length: plies }, (_, i) => o.clockAt!(i + 1)) : undefined;

  const moveCounts: MoveCounts = { opening: 0, middlegame: 0, endgame: 0 };
  if (clocks && initial) moveCounts.clock = { over50: 0, from25to50: 0, from10to25: 0, under10: 0 };
  for (let ply = 1; ply <= plies; ply++) {
    if (moverOfPly(ply) !== color) continue;
    moveCounts[phaseOfPly(division, ply)]++;
    if (clocks && initial) moveCounts.clock![clockBucket(clocks[ply - 1]!, initial)]++;
  }

  return {
    playerId: o.playerId,
    platform: "lichess",
    sourceId: o.sourceId,
    pgn: "1. e4 *",
    playedAt: new Date(Date.UTC(2026, 9, o.day)),
    color,
    result: o.result ?? "loss",
    speed: o.speed ?? "blitz",
    timeControl,
    plies,
    ...(clocks ? { clocks } : {}),
    opening: { eco: o.eco ?? "C50", name: o.openingName ?? "Italian Game" },
    // Classifications agree with the mistakes (the coach report stores them as the lens ribbon).
    analysis: {
      status: "done",
      accuracy: 80,
      classifications: Array.from({ length: plies }, (_, i) => o.mistakes.find((m) => m.ply === i + 1)?.kind ?? "good"),
    },
    features: {
      version: FEATURES_VERSION,
      division,
      mistakes: o.mistakes.map((m) => {
        if (moverOfPly(m.ply) !== color) throw new Error(`fixture: ply ${m.ply} isn't a ${color} move`);
        const clockLeft = clocks?.[m.ply - 1];
        return {
          ply: m.ply,
          kind: m.kind,
          phase: phaseOfPly(division, m.ply),
          san: "Nf3",
          best: "g1f3",
          winDrop: m.winDrop ?? 30,
          ...(clockLeft !== undefined && initial ? { clockLeft, timeTrouble: clockLeft < initial * 0.1 } : {}),
          square: "f3",
          fen: START,
        };
      }),
      moveCounts,
    },
  };
}

// The standard coach player: 10 blitz games with White, 60 plies each (30 of the player's
// moves: 10 per phase, since the middlegame starts at ply 20 and the endgame at 40), 180 s
// clocks with more than half left until ply 40 and under 10% after.
//
//   g1-g3   an inaccuracy in the opening (ply 5)
//   g1-g6   an inaccuracy in the middlegame (ply 25) and a blunder in the endgame (ply 45)
//   g7-g9   an inaccuracy in the endgame (ply 51)
//   g10     3 mistakes in the endgame (plies 43, 47, 53): one game only
//   g1-g5 play the B06 (Modern Defense), g6-g10 the C50 (Italian Game); in each, the results
//   go win, loss, win, loss, draw (a 50% score everywhere).
//
// Overall: 300 moves; 12 inaccuracies, 3 mistakes, 6 blunders = 21 errors = 7.0 per 100
// (inaccuracies 4.0, mistakes 1.0, blunders 2.0), 2.1 per game. Endgame: 12.0 per 100,
// blunders 6.0. Middlegame: 6.0 per 100 (average or better), inaccuracies 6.0.
export function standardCoachGames(playerId: Types.ObjectId, { openingName = "Modern Defense" }: { openingName?: string } = {}) {
  const results = ["win", "loss", "win", "loss", "draw"] as const;
  return Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    const mistakes: CoachGameOptions["mistakes"] = [];
    if (n <= 3) mistakes.push({ ply: 5, kind: "inaccuracy", winDrop: 12 });
    if (n <= 6) mistakes.push({ ply: 25, kind: "inaccuracy", winDrop: 14 + n }, { ply: 45, kind: "blunder", winDrop: 30 + n * 5 });
    if (n >= 7 && n <= 9) mistakes.push({ ply: 51, kind: "inaccuracy", winDrop: 11 });
    if (n === 10) mistakes.push({ ply: 43, kind: "mistake", winDrop: 22 }, { ply: 47, kind: "mistake", winDrop: 21 }, { ply: 53, kind: "mistake", winDrop: 20 });
    return coachGame({
      playerId,
      sourceId: `g${n}`,
      day: n,
      result: results[i % 5],
      eco: n <= 5 ? "B06" : "C50",
      openingName: n <= 5 ? openingName : "Italian Game",
      clockAt: (ply) => (ply <= 40 ? 150 : 10),
      mistakes,
    });
  });
}
