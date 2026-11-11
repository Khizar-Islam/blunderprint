import type { Response } from "express";
import type { AgentError } from "./loop.js";

// Every coach failure a visitor can see, as a fixed code (the page can switch on it) and a
// fixed message. The real error (an upstream message, a stack, loop.ts's "Unexpected error:
// ...") only ever goes to the logs. Nothing else in the coach API sends error text to a visitor.
// Stage 6 adds the guards' refusals (limits, storage, a full queue), used by the import route too.

export type FriendlyCode =
  | "player_not_found"
  | "not_enough_games"
  | "ai_disabled"
  | "ai_budget_exhausted"
  | "ai_busy"
  | "ai_unavailable"
  | "coach_timeout"
  | "coach_too_long"
  | "coach_no_answer"
  | "coach_interrupted"
  | "coach_config"
  | "run_not_found"
  | "internal"
  // Stage 6 guards
  | "limit_imports"
  | "limit_reports"
  | "limit_questions"
  | "limit_requests"
  | "limit_new_players"
  | "storage_full"
  | "busy";

export interface FriendlyError {
  code: FriendlyCode;
  message: string;
}

export interface FriendlyVars {
  analysed?: number;
  needed?: number;
  resetsInMs?: number;
  // How long until a limit's window ends (also sent as Retry-After).
  retryAfterMs?: number;
  // busy: which queue is full (the import route's by default).
  queue?: "imports" | "coach";
}

const hoursText = (ms: number | undefined) => {
  if (ms === undefined) return "";
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return ` (about ${hours} hour${hours === 1 ? "" : "s"} from now)`;
};

// "in about 40 minutes" / "in about 3 hours" / "in a minute".
export function waitText(ms: number | undefined): string {
  if (ms === undefined) return "later";
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "in a minute";
  if (minutes < 90) return `in about ${minutes} minutes`;
  const hours = Math.round(ms / 3_600_000);
  return `in about ${hours} hours`;
}

export function friendly(code: FriendlyCode, vars: FriendlyVars = {}): FriendlyError {
  const messages: Record<FriendlyCode, () => string> = {
    player_not_found: () => "We haven't imported this player yet. Import them first.",
    not_enough_games: () =>
      `The coach needs at least ${vars.needed ?? 20} analysed games. ${vars.analysed ?? 0} ${vars.analysed === 1 ? "is" : "are"} ready, so keep this page open while the engine analyses more.`,
    ai_disabled: () => "The coach is switched off right now. Your dashboard and game reviews still work.",
    ai_budget_exhausted: () =>
      `The coach has used up today's AI allowance. It resets at midnight Pacific time${hoursText(vars.resetsInMs)}. Reports already written are still shown.`,
    ai_busy: () => "The AI service is busy right now. Try again in a minute.",
    ai_unavailable: () => "The AI service didn't respond. Try again in a few minutes.",
    coach_timeout: () => "The coach ran out of time on this one. Try again in a few minutes.",
    coach_too_long: () => "The coach's investigation ran past its limits. Try again; it usually finishes on a second go.",
    coach_no_answer: () => "The coach couldn't put a report together this time. Try again.",
    coach_interrupted: () => "The server restarted while the coach was working. Start it again.",
    coach_config: () => "The coach hit a problem on our side. It's been logged.",
    run_not_found: () => "That coach run has expired or doesn't exist.",
    internal: () => "Something went wrong on our side.",
    limit_imports: () =>
      `You've started a lot of imports in a short time. You can start another ${waitText(vars.retryAfterMs)}. Players already imported can still be opened.`,
    limit_reports: () =>
      `You've started today's coach reports. You can start another ${waitText(vars.retryAfterMs)}. Reports already written are still shown.`,
    limit_questions: () =>
      `You've asked the coach a lot of questions. You can ask another ${waitText(vars.retryAfterMs)}. Answers already given are still shown.`,
    limit_requests: () => `Too many requests from your connection. Wait a minute and try again.`,
    limit_new_players: () =>
      `Blunderprint has taken in all the new players it can today. Try again ${waitText(vars.retryAfterMs)}, or explore a player who's already here.`,
    storage_full: () =>
      "Blunderprint's free database is full, so new players can't be imported right now. Players already imported still work.",
    busy: () =>
      vars.queue === "coach"
        ? "The coach has a lot of questions waiting right now. Try again in a minute."
        : "A lot of imports are waiting right now. Try again in a minute.",
  };
  return { code, message: messages[code]() };
}

// A failed run's error → what the visitor sees.
export function friendlyFromAgent(error: AgentError | undefined, vars: FriendlyVars = {}): FriendlyError {
  if (!error || error.unexpected) return friendly("internal");
  switch (error.code) {
    case "ai_disabled":
    case "ai_budget_exhausted":
      return friendly(error.code, vars);
    case "time_limit":
      return friendly("coach_timeout");
    case "token_limit":
    case "call_limit":
      return friendly("coach_too_long");
    case "no_answer":
      return friendly("coach_no_answer");
    case "aborted":
      return friendly("coach_interrupted");
    case "model_error":
      switch (error.modelErrorKind) {
        case "rate_limited":
          return friendly("ai_busy");
        case "overloaded":
        case "timeout":
        case "server":
        case "network":
          return friendly("ai_unavailable");
        case "auth":
        case "bad_request":
          return friendly("coach_config");
        default:
          return friendly("internal");
      }
    default:
      return friendly("internal");
  }
}

// Shown when a run worked but no pattern survived the verifier. The model's own
// `notEnoughData` text is never shown (nothing checks it); it's logged instead.
export const NO_PATTERNS_MESSAGE =
  "No weakness clearly stood out from your own average yet. More analysed games will help.";

// Sends a friendly refusal: { error, code }, and Retry-After (whole seconds) when it's known.
export function sendFriendly(res: Response, status: number, code: FriendlyCode, vars: FriendlyVars = {}): void {
  const f = friendly(code, vars);
  if (vars.retryAfterMs !== undefined) res.setHeader("Retry-After", String(Math.max(1, Math.ceil(vars.retryAfterMs / 1000))));
  res.status(status).json({ error: f.message, code: f.code });
}
