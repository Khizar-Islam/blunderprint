import { z } from "zod";
import type { PipelineStage } from "mongoose";
import { Game } from "../../db/models/game.js";
import { computeSummary, HAS_FEATURES } from "../../stats/summary.js";
import type { AgentContext } from "../context.js";
import { cleanOpeningName, colorArg, round1, setFilters, speedArg, strictArgs } from "./format.js";

export const openingArgs = strictArgs({
  color: colorArg,
  speed: speedArg,
  minGames: z.number().int().min(1).max(50).default(3),
  // Stage 6 chunk B: an opening family by name ("Sicilian", "Queen's Gambit"): every ECO code
  // whose opening FAMILY (the name before ":") contains it (case-insensitive), added up. Not the
  // variation part: "Zukertort Opening: Sicilian Invitation" is White's own opening, not the
  // Sicilian Defense. Letters, digits, spaces and a
  // little punctuation only.
  name: z
    .string()
    .trim()
    .min(2)
    .max(40)
    .regex(/^[\p{L}\p{N} '\-:,.]+$/u)
    .optional(),
});
export type OpeningArgs = z.infer<typeof openingArgs>;

const SHOWN = 12;
const round2 = (n: number) => Math.round(n * 100) / 100;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Row {
  eco: string | null;
  name: string | null;
  games: number;
  wins: number;
  draws: number;
  analysed: number;
  mistakes: number;
}

// The public row (and the `matching` total): results from every game, errors per analysed game.
const toRow = (o: Row) => ({
  games: o.games,
  win: o.wins,
  draw: o.draws,
  loss: o.games - o.wins - o.draws,
  scorePct: o.games > 0 ? round1(((o.wins + o.draws / 2) / o.games) * 100) : null,
  analysedGames: o.analysed,
  errorsPerGame: o.analysed > 0 ? round2(o.mistakes / o.analysed) : null,
});

// Per opening (by ECO code, as on the dashboard): how often, how well, how error-prone. The
// numbers are the dashboard's own (stats/summary.ts), so the coach and the page always agree.
// With `name`, a family across codes instead (byName below).
export async function getOpeningBreakdown(ctx: AgentContext, args: OpeningArgs) {
  if (args.name) return byName(ctx, args, args.name);
  const summary = await computeSummary(ctx.playerId, { color: args.color, speed: args.speed });
  const eligible = summary.openings.filter((o) => o.eco && o.games >= args.minGames);
  return {
    filters: { ...setFilters({ color: args.color, speed: args.speed }), minGames: args.minGames },
    games: summary.totals.games,
    // Openings with fewer games than minGames are left out, and at most 12 rows are shown
    // (the pool is the dashboard's 25 most-played).
    openings: eligible.slice(0, SHOWN).map((o) => ({
      eco: o.eco,
      name: cleanOpeningName(o.name),
      games: o.games,
      win: o.wins,
      draw: o.draws,
      loss: o.losses,
      scorePct: o.score,
      analysedGames: o.analysed,
      errorsPerGame: o.mistakesPerGame,
    })),
  };
}

// An opening family over ALL the player's games (not just the 25 most-played codes): one row per
// matching ECO code, and `matching`, the codes added up. A family is often spread over many codes
// with a game or two each (the 6 Sicilians of the first live test had 6 different codes), so the
// total is what answers "how do I do against the Sicilian?".
async function byName(ctx: AgentContext, args: OpeningArgs, name: string) {
  const match = {
    playerId: ctx.playerId,
    ...(args.color ? { color: args.color } : {}),
    ...(args.speed ? { speed: args.speed } : {}),
  };
  const pipeline: PipelineStage[] = [
    // ^[^:]* keeps the match inside the family part of the name, before any ":".
    { $match: { ...match, "opening.name": { $regex: `^[^:]*${escapeRegex(name)}`, $options: "i" } } },
    {
      $group: {
        _id: "$opening.eco",
        name: { $first: "$opening.name" },
        games: { $sum: 1 },
        wins: { $sum: { $cond: [{ $eq: ["$result", "win"] }, 1, 0] } },
        draws: { $sum: { $cond: [{ $eq: ["$result", "draw"] }, 1, 0] } },
        analysed: { $sum: { $cond: [{ $and: [{ $eq: ["$features.version", HAS_FEATURES["features.version"]] }, { $not: ["$features.error"] }] }, 1, 0] } },
        mistakes: { $sum: { $size: { $ifNull: ["$features.mistakes", []] } } },
      },
    },
    { $sort: { games: -1, _id: 1 } },
  ];
  const [rows, games] = await Promise.all([
    Game.aggregate<Omit<Row, "eco"> & { _id: string | null }>(pipeline),
    Game.countDocuments(match),
  ]);
  const total = rows.reduce<Row>(
    (t, r) => ({ ...t, games: t.games + r.games, wins: t.wins + r.wins, draws: t.draws + r.draws, analysed: t.analysed + r.analysed, mistakes: t.mistakes + r.mistakes }),
    { eco: null, name: null, games: 0, wins: 0, draws: 0, analysed: 0, mistakes: 0 },
  );
  return {
    filters: { ...setFilters({ color: args.color, speed: args.speed }), name, minGames: args.minGames },
    games,
    // Every matching code added up; games: 0 means the player has no game in that opening.
    matching: { ...toRow(total), ecoCodes: rows.length },
    openings: rows
      .filter((r) => r.games >= args.minGames)
      .slice(0, SHOWN)
      .map((r) => ({ eco: r._id, name: cleanOpeningName(r.name), ...toRow({ ...r, eco: r._id }) })),
  };
}
