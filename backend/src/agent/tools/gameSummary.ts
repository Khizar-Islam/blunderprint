import { z } from "zod";
import { FEATURES_VERSION } from "../../chess/features.js";
import { Game } from "../../db/models/game.js";
import type { AgentContext } from "../context.js";
import { cleanOpeningName, cleanTermination, day, moveNumberOf, pieceName, round1, strictArgs, uciToSan } from "./format.js";

export const gameSummaryArgs = strictArgs({ gameId: z.string().regex(/^[0-9a-f]{24}$/i, "gameId must be a 24-character id") });
export type GameSummaryArgs = z.infer<typeof gameSummaryArgs>;

const KEY_MOMENTS = 3;

// One game in brief: the result, the opening, the phases and its three costliest moments.
// Only this player's games: an id that belongs to someone else is "not found", the same as an
// id that doesn't exist, so the tool can't be used to find out what exists. No opponent name
// (see format.ts); the opponent's rating is a number and safe to show.
export async function getGameSummary(ctx: AgentContext, args: GameSummaryArgs) {
  const game = await Game.findOne(
    { _id: args.gameId, playerId: ctx.playerId },
    {
      playedAt: 1,
      color: 1,
      result: 1,
      termination: 1,
      speed: 1,
      timeControl: 1,
      playerRating: 1,
      opponentRating: 1,
      plies: 1,
      opening: 1,
      "analysis.status": 1,
      "analysis.accuracy": 1,
      features: 1,
    },
  ).lean();
  if (!game) return { found: false as const, gameId: args.gameId };

  // Projected as "analysis.accuracy" (not all of analysis, which holds the evals); Mongoose's
  // inferred type doesn't follow dotted projections, so it's read through this shape.
  const accuracy = (game as { analysis?: { accuracy?: number } }).analysis?.accuracy;
  const f = game.features;
  const analysed = !!f && f.version === FEATURES_VERSION && !f.error;
  const mistakes = analysed ? (f.mistakes ?? []) : [];
  const count = (kind: string) => mistakes.filter((m) => m.kind === kind).length;
  const mc = f?.moveCounts;

  return {
    found: true as const,
    gameId: String(game._id),
    playedOn: day(game.playedAt),
    playerColor: game.color,
    result: game.result,
    termination: cleanTermination(game.termination),
    speed: game.speed,
    timeControl: game.timeControl ?? null,
    playerRating: game.playerRating ?? null,
    opponentRating: game.opponentRating ?? null,
    plies: game.plies,
    opening: game.opening?.eco ? { eco: game.opening.eco, name: cleanOpeningName(game.opening.name) } : null,
    analysed,
    ...(analysed
      ? {
          accuracyPct: typeof accuracy === "number" ? round1(accuracy) : null,
          // Plies where the middlegame and endgame start (absent = the game never got there).
          middlegameFromPly: f.division?.middle ?? null,
          endgameFromPly: f.division?.end ?? null,
          playerMoves: mc ? (mc.opening ?? 0) + (mc.middlegame ?? 0) + (mc.endgame ?? 0) : null,
          errors: { inaccuracy: count("inaccuracy"), mistake: count("mistake"), blunder: count("blunder") },
          keyMoments: [...mistakes]
            .sort((a, b) => b.winDrop - a.winDrop || a.ply - b.ply)
            .slice(0, KEY_MOMENTS)
            .map((m) => ({
              ply: m.ply,
              moveNumber: moveNumberOf(m.ply),
              phase: m.phase,
              kind: m.kind,
              played: m.san,
              betterMove: uciToSan(m.fen, m.best),
              winPctLost: round1(m.winDrop),
              clockLeftSeconds: m.clockLeft ?? null,
              pieceLost: pieceName(m.pieceLost),
            })),
        }
      : {}),
  };
}
