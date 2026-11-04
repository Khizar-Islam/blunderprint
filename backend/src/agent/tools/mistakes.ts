import { z } from "zod";
import { Game } from "../../db/models/game.js";
import { computeSummary, HAS_FEATURES, type Rate } from "../../stats/summary.js";
import type { AgentContext } from "../context.js";
import { colorArg, pct, pieceName, setFilters, speedArg, strictArgs } from "./format.js";

export const GROUP_BY = ["phase", "speed", "clockBucket", "moveNumberBucket", "pieceLost", "square"] as const;

export const mistakeArgs = strictArgs({
  groupBy: z.enum(GROUP_BY),
  filters: strictArgs({ color: colorArg, speed: speedArg }).prefault({}),
});
export type MistakeArgs = z.infer<typeof mistakeArgs>;

const SQUARES_SHOWN = 12;
// The heat board's weights: what an error costs, so the worst squares come first.
const SEVERITY = { inaccuracy: 1, mistake: 2, blunder: 3 } as const;

const round2 = (n: number) => Math.round(n * 100) / 100;

// Each kind per 100 of the player's moves (1 decimal); null when no moves were counted.
export const perKindRates = (k: { inaccuracy: number; mistake: number; blunder: number }, moves: number) => ({
  inaccuracyPer100: pct(k.inaccuracy, moves),
  mistakePer100: pct(k.mistake, moves),
  blunderPer100: pct(k.blunder, moves),
});

// One row of a rate breakdown, in the tool's words. per100Moves = errors per 100 of the
// player's moves in that group (fair between groups of different sizes); perGame = errors per
// analysed game. The per-kind rates show when one kind stands out: a phase can have an average
// error rate overall but far more blunders.
const rateRow = (r: Rate) => ({
  inaccuracy: r.inaccuracy,
  mistake: r.mistake,
  blunder: r.blunder,
  total: r.total,
  playerMoves: r.moves,
  per100Moves: r.per100,
  ...perKindRates(r, r.moves),
  perGame: r.perGame,
});

// Where and when the player's errors happen, grouped one way at a time. phase, speed, clock and
// move number reuse the dashboard's summary; pieceLost has its own small aggregation.
export async function getMistakeBreakdown(ctx: AgentContext, args: MistakeArgs) {
  const { color, speed } = args.filters;
  const summary = await computeSummary(ctx.playerId, { color, speed });
  const head = {
    groupBy: args.groupBy,
    filters: setFilters({ color, speed }),
    analysedGames: summary.totals.analysed,
    playerMoves: summary.totals.moves,
  };

  switch (args.groupBy) {
    case "phase":
      return { ...head, rows: summary.byPhase.map((r) => ({ phase: r.phase, ...rateRow(r) })) };
    case "speed":
      return { ...head, rows: summary.bySpeed.map((r) => ({ speed: r.speed, analysedGames: r.games, ...rateRow(r) })) };
    case "clockBucket":
      // Share of the starting clock left after the move. Games without clocks aren't counted.
      return {
        ...head,
        buckets: "over50 = more than 50% of the starting time left; from25to50; from10to25; under10 = time trouble",
        rows: summary.byClock.map((r) => ({ clockBucket: r.bucket, ...rateRow(r) })),
      };
    case "moveNumberBucket":
      return { ...head, rows: summary.byMoveNumber.map((r) => ({ moveNumbers: r.bucket, ...rateRow(r) })) };
    case "square": {
      // Destination squares of the errors, as real board squares (a1 = White's queenside
      // corner), worst first by severity. No per-100-moves rate: moves aren't counted per square.
      const rows = (["white", "black"] as const)
        .flatMap((c) => summary.squares[c].map((s) => ({ ...s, playerColor: c })))
        .filter((s) => s.total > 0)
        .map((s) => ({ ...s, weight: s.inaccuracy * SEVERITY.inaccuracy + s.mistake * SEVERITY.mistake + s.blunder * SEVERITY.blunder }))
        .sort((a, b) => b.weight - a.weight || b.total - a.total || a.square.localeCompare(b.square));
      return {
        ...head,
        squaresWithErrors: rows.length,
        rows: rows.slice(0, SQUARES_SHOWN).map((s) => ({
          square: s.square,
          playerColor: s.playerColor,
          inaccuracy: s.inaccuracy,
          mistake: s.mistake,
          blunder: s.blunder,
          total: s.total,
          perGame: summary.totals.analysed > 0 ? round2(s.total / summary.totals.analysed) : null,
        })),
      };
    }
    case "pieceLost":
      return { ...head, ...(await pieceLostRows(ctx, color, speed, summary.totals.analysed)) };
  }
}

// Errors grouped by the piece the player lost to them within 2 plies (features.ts lostPiece),
// plus the errors that lost no piece (positional or tactical, but no material yet).
async function pieceLostRows(ctx: AgentContext, color: string | undefined, speed: string | undefined, analysed: number) {
  const rows = await Game.aggregate<{ _id: string | null; inaccuracy: number; mistake: number; blunder: number }>([
    { $match: { playerId: ctx.playerId, ...HAS_FEATURES, ...(color ? { color } : {}), ...(speed ? { speed } : {}) } },
    { $project: { mistakes: "$features.mistakes" } },
    { $unwind: "$mistakes" },
    {
      $group: {
        _id: { $ifNull: ["$mistakes.pieceLost", null] },
        inaccuracy: { $sum: { $cond: [{ $eq: ["$mistakes.kind", "inaccuracy"] }, 1, 0] } },
        mistake: { $sum: { $cond: [{ $eq: ["$mistakes.kind", "mistake"] }, 1, 0] } },
        blunder: { $sum: { $cond: [{ $eq: ["$mistakes.kind", "blunder"] }, 1, 0] } },
      },
    },
  ]);
  const totalErrors = rows.reduce((n, r) => n + r.inaccuracy + r.mistake + r.blunder, 0);
  const order = ["q", "r", "b", "n", "p", null];
  return {
    totalErrors,
    rows: rows
      .sort((a, b) => order.indexOf(a._id) - order.indexOf(b._id))
      .map((r) => {
        const total = r.inaccuracy + r.mistake + r.blunder;
        return {
          pieceLost: pieceName(r._id) ?? "none",
          inaccuracy: r.inaccuracy,
          mistake: r.mistake,
          blunder: r.blunder,
          total,
          shareOfErrorsPct: pct(total, totalErrors),
          perGame: analysed > 0 ? round2(total / analysed) : null,
        };
      }),
  };
}
