import { z } from "zod";
import { logger } from "../../lib/logger.js";
import type { AgentContext } from "../context.js";
import { candidateArgs, getWeaknessCandidates } from "./candidates.js";
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
    name: "get_weakness_candidates",
    description:
      "The player's possible weaknesses, found by code: every group (phase, clock bucket, move numbers, speed, colour, opening, phase x clock) whose error rate per 100 moves (all errors, or one kind), or for an opening errors per game or score %, is clearly worse than the player's own overall figure, on enough games and moves. Up to 12, strongest first. Each has an id, a label, value vs baseline, gapPct, the sample, parentIds (broader candidates it sits inside) and the exampleFilter to pass to find_example_mistakes. Call it right after get_player_profile.",
    args: candidateArgs,
    run: (ctx) => getWeaknessCandidates(ctx),
  }),
  tool({
    name: "get_opening_breakdown",
    description:
      "Per opening (ECO code): games, W/D/L, score %, and errors per analysed game. Up to 12 openings with at least minGames games (default 3), most played first. Optional colour and speed filters. With name (e.g. \"Sicilian\"): every ECO code whose opening family (the name before the colon) contains it, from ALL the player's games, and `matching`, those codes added up (games: 0 = no game in that opening).",
    args: openingArgs,
    run: (ctx, args) => getOpeningBreakdown(ctx, args),
  }),
  tool({
    name: "get_mistake_breakdown",
    description:
      "The player's inaccuracies, mistakes and blunders grouped one way: phase (opening/middlegame/endgame), speed, clockBucket (share of the starting clock left), moveNumberBucket, pieceLost (piece lost within 2 plies, or none), or square (destination square, worst 12). Each row has counts by kind and, where moves are counted, per100Moves, plus each row's share of every kind (blunderSharePct, mistakeSharePct, inaccuracySharePct: share within that kind). Optional colour and speed filters.",
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
  return withoutAdditionalProperties(schema) as Record<string, unknown>;
}

// The argument objects are strict (format.ts strictArgs), so zod writes additionalProperties:
// false everywhere. It's left out of the declaration (function-declaration schemas are a subset
// of JSON Schema, and an unsupported keyword could fail the request); runTool still rejects
// unknown keys with a readable error.
function withoutAdditionalProperties(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAdditionalProperties);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "additionalProperties")
      .map(([k, v]) => [k, withoutAdditionalProperties(v)]),
  );
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

// One short line about a result, for the live agent trace: what came back, not the data.
export function summarizeResult(name: string, data: unknown): string {
  const d = (data ?? {}) as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  switch (name) {
    case "get_player_profile":
      return `${d.games} games, ${d.analysedGames} analysed`;
    case "get_weakness_candidates":
      return `${len(d.candidates)} of ${d.qualifying} candidates`;
    case "get_opening_breakdown":
      return d.matching ? `${(d.matching as { games: number }).games} games in ${(d.matching as { ecoCodes: number }).ecoCodes} codes matching "${(d.filters as { name: string }).name}"` : `${len(d.openings)} openings`;
    case "get_mistake_breakdown":
      return `${len(d.rows)} rows by ${d.groupBy}`;
    case "find_example_mistakes":
      return `${len(d.examples)} examples of ${d.matchingErrors} errors in ${d.matchingGames} games`;
    case "get_game_summary":
      return d.found ? `${d.result}, ${len(d.keyMoments)} key moments` : "game not found";
    default:
      return `${JSON.stringify(data).length} chars`;
  }
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
