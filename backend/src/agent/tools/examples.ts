import { z } from "zod";
import type { PipelineStage, Types } from "mongoose";
import { COLORS, Game, SPEEDS, type Color, type Speed } from "../../db/models/game.js";
import { CLOCK_BUCKETS, clockBucketSwitch, clockShare, HAS_FEATURES, MOVE_BUCKETS, moveBucketSwitch } from "../../stats/summary.js";
import type { AgentContext } from "../context.js";
import { cleanOpeningName, day, moveNumberOf, pieceName, round1, uciToSan } from "./format.js";

const PIECES = ["queen", "rook", "bishop", "knight", "pawn"] as const;
const PIECE_LETTER: Record<(typeof PIECES)[number], string> = { queen: "q", rook: "r", bishop: "b", knight: "n", pawn: "p" };

export const exampleArgs = z.object({
  filters: z
    .object({
      color: z.enum(COLORS).optional(),
      speed: z.enum(SPEEDS).optional(),
      phase: z.enum(["opening", "middlegame", "endgame"]).optional(),
      kind: z.enum(["inaccuracy", "mistake", "blunder"]).optional(),
      clockBucket: z.enum(CLOCK_BUCKETS).optional(),
      moveNumberBucket: z.enum(MOVE_BUCKETS.map((b) => b.label) as [string, ...string[]]).optional(),
      pieceLost: z.enum(PIECES).optional(),
      square: z.string().regex(/^[a-h][1-8]$/).optional(),
      eco: z.string().regex(/^[A-E]\d\d$/).optional(),
    })
    .default({}),
  limit: z.number().int().min(1).max(5).default(3),
});
export type ExampleArgs = z.infer<typeof exampleArgs>;

interface Row {
  _id: Types.ObjectId;
  playedAt: Date;
  color: Color;
  speed: Speed;
  opening?: { eco?: string; name?: string };
  m: { ply: number; kind: string; phase: string; san: string; best?: string; winDrop: number; clockLeft?: number; square: string; pieceLost?: string; fen: string };
  clockBucket?: string;
}

// Real positions for the patterns: the player's costliest errors matching the filters, at most
// one per game (five blunders from one game aren't a habit), worst first. Also counts every
// matching error, so the model can say "12 of these in 9 games" from a number it was given.
export async function findExampleMistakes(ctx: AgentContext, args: ExampleArgs) {
  const f = args.filters;
  const mistakeMatch: Record<string, unknown> = {
    ...(f.phase ? { "m.phase": f.phase } : {}),
    ...(f.kind ? { "m.kind": f.kind } : {}),
    ...(f.square ? { "m.square": f.square } : {}),
    ...(f.pieceLost ? { "m.pieceLost": PIECE_LETTER[f.pieceLost] } : {}),
    ...(f.clockBucket ? { clockBucket: f.clockBucket } : {}),
    ...(f.moveNumberBucket ? { moveBucket: f.moveNumberBucket } : {}),
  };

  const pipeline: PipelineStage[] = [
    {
      $match: {
        playerId: ctx.playerId,
        ...HAS_FEATURES,
        ...(f.color ? { color: f.color } : {}),
        ...(f.speed ? { speed: f.speed } : {}),
        ...(f.eco ? { "opening.eco": f.eco } : {}),
      },
    },
    // Only what an example needs: no PGN, evals or opponent.
    { $project: { playedAt: 1, color: 1, speed: 1, timeControl: 1, opening: 1, mistakes: "$features.mistakes" } },
    { $unwind: "$mistakes" },
    { $set: { m: "$mistakes" } },
    // Move number and clock bucket with the dashboard's edges (stats/summary.ts).
    { $set: { moveBucket: moveBucketSwitch({ $ceil: { $divide: ["$m.ply", 2] } }) } },
    {
      $set: {
        clockBucket: {
          $cond: [{ $ifNull: ["$m.clockLeft", false] }, clockBucketSwitch(clockShare("$m.clockLeft", "$timeControl")), null],
        },
      },
    },
    { $match: mistakeMatch },
    {
      $facet: {
        count: [{ $group: { _id: null, errors: { $sum: 1 }, games: { $addToSet: "$_id" } } }, { $project: { errors: 1, games: { $size: "$games" } } }],
        examples: [
          // Worst first; the newest game breaks ties.
          { $sort: { "m.winDrop": -1, playedAt: -1, "m.ply": 1 } },
          // One per game: the first (worst) of each.
          { $group: { _id: "$_id", doc: { $first: "$$ROOT" } } },
          { $replaceWith: "$doc" },
          { $sort: { "m.winDrop": -1, playedAt: -1 } },
          { $limit: args.limit },
          { $project: { playedAt: 1, color: 1, speed: 1, opening: 1, m: 1, clockBucket: 1 } },
        ],
      },
    },
  ];

  const [result] = await Game.aggregate<{ count: { errors: number; games: number }[]; examples: Row[] }>(pipeline);
  const count = result?.count[0] ?? { errors: 0, games: 0 };
  return {
    filters: f,
    matchingErrors: count.errors,
    matchingGames: count.games,
    examples: (result?.examples ?? []).map((r) => ({
      gameId: String(r._id),
      ply: r.m.ply,
      moveNumber: moveNumberOf(r.m.ply),
      playerColor: r.color,
      speed: r.speed,
      playedOn: day(r.playedAt),
      opening: r.opening?.eco ? { eco: r.opening.eco, name: cleanOpeningName(r.opening.name) } : null,
      phase: r.m.phase,
      kind: r.m.kind,
      played: r.m.san,
      betterMove: uciToSan(r.m.fen, r.m.best),
      winPctLost: round1(r.m.winDrop),
      clockLeftSeconds: r.m.clockLeft ?? null,
      clockBucket: r.clockBucket ?? null,
      pieceLost: pieceName(r.m.pieceLost),
      square: r.m.square,
      // The position before the move (normalized FEN: no move counters).
      fen: r.m.fen,
    })),
  };
}
