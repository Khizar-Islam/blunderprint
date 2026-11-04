import { z } from "zod";
import { logger } from "../../lib/logger.js";
import type { AgentContext } from "../context.js";
import { findExampleMistakes, exampleArgs } from "./examples.js";
import { getGameSummary, gameSummaryArgs } from "./gameSummary.js";
import { getMistakeBreakdown, mistakeArgs } from "./mistakes.js";
import { getOpeningBreakdown, openingArgs } from "./openings.js";
import { getPlayerProfile, profileArgs } from "./profile.js";
import { getPositionStats, positionStatsArgs } from "./positionStats.js";

// The coach's tools (CLAUDE.md §10): read-only queries over one player's data, each returning
// compact JSON (≤ ~2k tokens). The agent loop (Stage 5 chunk B) declares them to the model and
// runs the calls it makes through runTool().
//
// Number conventions, stated once here and in the descriptions so the model reads them right:
// *Pct fields are percentages 0–100 (1 decimal), per100Moves = errors per 100 of the player's
// moves, perGame = errors per analysed game, winPctLost = win-chance points the move cost.

export interface ToolDef {
  name: string;
  description: string;
  args: z.ZodType;
  // false = implemented but not offered to the model (get_position_stats until Stage 4).
  declared: boolean;
  run(ctx: AgentContext, args: never): Promise<unknown>;
}

const tool = <S extends z.ZodType>(def: {
  name: string;
  description: string;
  args: S;
  declared?: boolean;
  run(ctx: AgentContext, args: z.output<S>): Promise<unknown>;
}): ToolDef => ({ declared: true, ...def }) as ToolDef;

export const TOOLS: ToolDef[] = [
  tool({
    name: "get_player_profile",
    description:
      "The player's overview: current ratings, games and analysed games, results (W/D/L, score %) overall, by colour and by speed, average move accuracy, and error counts with errors per 100 moves and per game. Call this first.",
    args: profileArgs,
    run: (ctx) => getPlayerProfile(ctx),
  }),
  tool({
    name: "get_opening_breakdown",
    description:
      "Per opening (ECO code): games, W/D/L, score %, and errors per analysed game. Up to 12 openings with at least minGames games (default 3), most played first. Optional colour and speed filters.",
    args: openingArgs,
    run: (ctx, args) => getOpeningBreakdown(ctx, args),
  }),
  tool({
    name: "get_mistake_breakdown",
    description:
      "The player's inaccuracies, mistakes and blunders grouped one way: phase (opening/middlegame/endgame), speed, clockBucket (share of the starting clock left), moveNumberBucket, pieceLost (piece lost within 2 plies, or none), or square (destination square, worst 12). Each row has counts by kind and, where moves are counted, per100Moves. Optional colour and speed filters.",
    args: mistakeArgs,
    run: (ctx, args) => getMistakeBreakdown(ctx, args),
  }),
  tool({
    name: "find_example_mistakes",
    description:
      "Real examples from the player's games for a pattern: the costliest errors matching the filters, one per game, worst first (limit 1-5, default 3), with the total number of matching errors and games. Each example has gameId and ply (use them as evidence), the move played, the better move when known, win % lost, clock left and the position (FEN) before the move.",
    args: exampleArgs,
    run: (ctx, args) => findExampleMistakes(ctx, args),
  }),
  tool({
    name: "get_game_summary",
    description:
      "One of the player's games in brief: result, opening, ratings, accuracy, where the middlegame and endgame start, error counts and its 3 costliest moments. Takes a gameId from another tool's result.",
    args: gameSummaryArgs,
    run: (ctx, args) => getGameSummary(ctx, args),
  }),
  tool({
    name: "get_position_stats",
    description: "What players at a rating band play from a position (FEN), with results. Not available yet.",
    args: positionStatsArgs,
    declared: false,
    run: (_ctx, args) => getPositionStats(args),
  }),
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

// A tool's argument schema as JSON Schema for the model's function declaration. zod writes
// "$schema" and additionalProperties, which the model doesn't need; the rest is plain JSON Schema.
function parametersOf(args: z.ZodType): Record<string, unknown> {
  const { $schema: _schema, ...schema } = z.toJSONSchema(args, { io: "input" }) as Record<string, unknown>;
  return schema;
}

// The function declarations for the model: only declared tools (Interactions API shape:
// { type: "function", name, description, parameters }).
export function declaredTools() {
  return TOOLS.filter((t) => t.declared).map((t) => ({
    type: "function" as const,
    name: t.name,
    description: t.description,
    parameters: parametersOf(t.args),
  }));
}

// Results above this are a bug in a tool (they should stay ≤ ~2k tokens ≈ 8,000 characters);
// logged, not cut, because cutting JSON would break it.
export const MAX_RESULT_CHARS = 8_000;

export type ToolResult = { ok: true; data: unknown; chars: number } | { ok: false; error: string };

// Runs one call the model made. Never throws: every failure becomes a short error the model can
// read and react to (wrong arguments, an unknown or undeclared tool), and an internal failure is
// logged here and reported to the model without its details.
export async function runTool(ctx: AgentContext, name: string, rawArgs: unknown): Promise<ToolResult> {
  const def = byName.get(name);
  if (!def || !def.declared) return { ok: false, error: `Unknown tool "${String(name).slice(0, 40)}".` };

  const parsed = def.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "arguments"}: ${i.message}`);
    return { ok: false, error: `Invalid arguments. ${issues.join("; ")}` };
  }

  try {
    const data = await def.run(ctx, parsed.data as never);
    const chars = JSON.stringify(data).length;
    if (chars > MAX_RESULT_CHARS) logger.warn("Coach tool result over budget", { tool: name, chars });
    return { ok: true, data, chars };
  } catch (err) {
    logger.error("Coach tool failed", { tool: name, error: String(err) });
    return { ok: false, error: "The tool failed on the server. Try a different query." };
  }
}
