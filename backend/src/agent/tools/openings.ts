import { z } from "zod";
import { COLORS, SPEEDS } from "../../db/models/game.js";
import { computeSummary } from "../../stats/summary.js";
import type { AgentContext } from "../context.js";
import { cleanOpeningName } from "./format.js";

export const openingArgs = z.object({
  color: z.enum(COLORS).optional(),
  speed: z.enum(SPEEDS).optional(),
  minGames: z.number().int().min(1).max(50).default(3),
});
export type OpeningArgs = z.infer<typeof openingArgs>;

const SHOWN = 12;

// Per opening (by ECO code, as on the dashboard): how often, how well, how error-prone. The
// numbers are the dashboard's own (stats/summary.ts), so the coach and the page always agree.
export async function getOpeningBreakdown(ctx: AgentContext, args: OpeningArgs) {
  const summary = await computeSummary(ctx.playerId, { color: args.color, speed: args.speed });
  const eligible = summary.openings.filter((o) => o.eco && o.games >= args.minGames);
  return {
    filters: { color: args.color ?? "both", speed: args.speed ?? "all", minGames: args.minGames },
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
