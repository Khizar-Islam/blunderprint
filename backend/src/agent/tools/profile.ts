import { z } from "zod";
import { Game, type Color, type Speed } from "../../db/models/game.js";
import { Player } from "../../db/models/player.js";
import { computeSummary } from "../../stats/summary.js";
import type { AgentContext } from "../context.js";
import { day, pct, round1 } from "./format.js";

export const profileArgs = z.object({});

interface ResultRow {
  _id: { speed: Speed; color: Color; result: "win" | "draw" | "loss" };
  n: number;
}
interface AccuracyRow {
  _id: Color;
  avg: number;
  games: number;
}

// The player at a glance: who they are as a chess player, never who they are by name (no
// username: the model doesn't need it, see format.ts).
export async function getPlayerProfile(ctx: AgentContext) {
  const [player, summary, [facets]] = await Promise.all([
    Player.findById(ctx.playerId, { profile: 1 }).lean(),
    computeSummary(ctx.playerId),
    // Results come from every game (a result needs no engine), accuracy from analysed ones.
    Game.aggregate<{ results: ResultRow[]; accuracy: AccuracyRow[] }>([
      { $match: { playerId: ctx.playerId } },
      { $project: { speed: 1, color: 1, result: 1, accuracy: "$analysis.accuracy", status: "$analysis.status" } },
      {
        $facet: {
          results: [{ $group: { _id: { speed: "$speed", color: "$color", result: "$result" }, n: { $sum: 1 } } }],
          accuracy: [
            { $match: { status: { $in: ["done", "imported"] }, accuracy: { $type: "number" } } },
            { $group: { _id: "$color", avg: { $avg: "$accuracy" }, games: { $sum: 1 } } },
          ],
        },
      },
    ]),
  ]);

  // W/D/L per (speed, colour) → totals per speed and per colour.
  type Tally = { games: number; win: number; draw: number; loss: number };
  const empty = (): Tally => ({ games: 0, win: 0, draw: 0, loss: 0 });
  const all = empty();
  const bySpeed = new Map<Speed, Tally>();
  const byColor: Record<Color, Tally> = { white: empty(), black: empty() };
  for (const row of facets?.results ?? []) {
    const { speed, color, result } = row._id;
    if (!bySpeed.has(speed)) bySpeed.set(speed, empty());
    // The same games count towards the overall, the colour and the speed tally.
    for (const t of [all, byColor[color], bySpeed.get(speed)!]) {
      t.games += row.n;
      t[result] += row.n;
    }
  }
  const score = (t: Tally) => pct(t.win + t.draw / 2, t.games);

  const accuracy = new Map((facets?.accuracy ?? []).map((a) => [a._id, a]));
  const accGames = (accuracy.get("white")?.games ?? 0) + (accuracy.get("black")?.games ?? 0);
  const accAll =
    accGames > 0
      ? round1(((accuracy.get("white")?.avg ?? 0) * (accuracy.get("white")?.games ?? 0) + (accuracy.get("black")?.avg ?? 0) * (accuracy.get("black")?.games ?? 0)) / accGames)
      : null;

  const errorRates = new Map(summary.bySpeed.map((s) => [s.speed, s]));
  const m = summary.totals.mistakes;

  return {
    platform: ctx.platform,
    // The platform's current ratings (Chess.com and Lichess ratings aren't comparable).
    currentRatings: player?.profile?.ratings ?? {},
    games: all.games,
    analysedGames: summary.totals.analysed,
    firstGame: day(summary.totals.firstPlayedAt),
    lastGame: day(summary.totals.lastPlayedAt),
    results: { win: all.win, draw: all.draw, loss: all.loss, scorePct: score(all) },
    byColor: Object.fromEntries((["white", "black"] as const).map((c) => [c, { games: byColor[c].games, scorePct: score(byColor[c]) }])),
    bySpeed: [...bySpeed.entries()]
      .sort((a, b) => b[1].games - a[1].games)
      .map(([speed, t]) => ({
        speed,
        games: t.games,
        scorePct: score(t),
        analysedGames: errorRates.get(speed)?.games ?? 0,
        errorsPer100Moves: errorRates.get(speed)?.per100 ?? null,
      })),
    accuracyPct: {
      all: accAll,
      white: accuracy.has("white") ? round1(accuracy.get("white")!.avg) : null,
      black: accuracy.has("black") ? round1(accuracy.get("black")!.avg) : null,
    },
    // Errors in the analysed games: counts by kind, and the two rates the dashboard shows.
    errors: {
      inaccuracy: m.inaccuracy,
      mistake: m.mistake,
      blunder: m.blunder,
      total: m.total,
      playerMoves: summary.totals.moves,
      per100Moves: pct(m.total, summary.totals.moves),
      perGame: summary.totals.analysed > 0 ? Math.round((m.total / summary.totals.analysed) * 100) / 100 : null,
    },
  };
}
