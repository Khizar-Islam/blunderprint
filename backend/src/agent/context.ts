import type { Types } from "mongoose";
import type { Platform } from "../db/models/player.js";

// What every coach tool runs against. Built by the server from the URL's player
// (/api/players/:platform/:username/report), never from anything the model says: no tool takes
// a player argument, so the model can only ever read the player the run was started for.
export interface AgentContext {
  playerId: Types.ObjectId;
  platform: Platform;
  // What counts as a weakness (get_weakness_candidates); defaults when absent (tests, scripts).
  rules?: Partial<WeaknessRules>;
}

// A weakness = a group of the player's moves (or games) that is clearly worse than the player's
// own overall figure for the same measure, on a sample big enough to call it a habit.
// From env: COACH_MIN_BASELINE_GAP, COACH_MIN_CANDIDATE_GAMES, COACH_MIN_CANDIDATE_MOVES.
export interface WeaknessRules {
  minGap: number; // relative: 0.15 = at least 15% worse than the player's own figure
  minGames: number; // games in the group (openings: the only minimum)
  minMoves: number; // the player's moves in the group (rates per 100 moves)
}

export const DEFAULT_RULES: WeaknessRules = { minGap: 0.15, minGames: 5, minMoves: 100 };

export const rulesOf = (ctx: AgentContext): WeaknessRules => ({ ...DEFAULT_RULES, ...ctx.rules });
