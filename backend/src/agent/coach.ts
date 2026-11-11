import type { Env } from "../config/env.js";
import { createAiBudget, guardedModel, type AiBudget } from "./budget.js";
import { DEFAULT_RULES, type WeaknessRules } from "./context.js";
import { createGeminiModel } from "./gemini.js";
import type { AgentLimits } from "./loop.js";
import type { Model } from "./model.js";
import { createPacer, type Pacer } from "./pacer.js";
import { scriptedPair } from "./scriptedModel.js";

// Everything the coach needs at runtime, built once per process from env: the model (with the
// budget guard in front of it), the ONE shared pacer, the limits, the weakness rules and the
// guards. The report job (jobs/handlers/report.ts) runs reports with it; the coach routes ask
// it whether a report may start.
export interface CoachRuntime {
  model: Model;
  // The rest of a run uses this after the main model is overloaded twice in a row.
  fallback?: Model;
  modelName: string;
  // AI_ENABLED and a usable model (the real one needs GEMINI_API_KEY).
  available: boolean;
  budget: AiBudget;
  pacer: Pacer;
  limits: AgentLimits;
  rules: WeaknessRules;
  // One question's limits (Stage 6 chunk B, ASK_*): smaller than a report's.
  askLimits: AgentLimits;
  // POST /report and /ask: below this many analysed games → 409 not_enough_games.
  minAnalysed: number;
  // The most requests one run can make (COACH_MAX_REQUESTS): the budget must have this many
  // left to start one.
  worstCaseCalls: number;
}

type CoachEnv = Pick<
  Env,
  | "AI_ENABLED"
  | "AI_DAILY_CALL_BUDGET"
  | "GEMINI_API_KEY"
  | "GEMINI_MODEL"
  | "GEMINI_FALLBACK_MODEL"
  | "GEMINI_RPM"
  | "GEMINI_TPM"
  | "COACH_MODEL"
  | "COACH_SCRIPTED_SCENARIO"
  | "COACH_MAX_MODEL_CALLS"
  | "COACH_MAX_REPAIR_CALLS"
  | "COACH_MAX_REQUESTS"
  | "COACH_MAX_TOKENS"
  | "COACH_CALL_TIMEOUT_MS"
  | "COACH_RUN_TIMEOUT_MS"
  | "COACH_MIN_BASELINE_GAP"
  | "COACH_MIN_CANDIDATE_GAMES"
  | "COACH_MIN_CANDIDATE_MOVES"
  | "COACH_MIN_ANALYSED_GAMES"
> &
  Partial<Pick<Env, "ASK_MAX_MODEL_CALLS" | "ASK_MAX_REPAIR_CALLS" | "ASK_MAX_REQUESTS" | "ASK_RUN_TIMEOUT_MS">>;

// The model can be passed in (tests); otherwise it comes from COACH_MODEL.
export function createCoachRuntime(
  env: CoachEnv,
  { model: given, fallback: givenFallback, budget: givenBudget, pacer: givenPacer }: { model?: Model; fallback?: Model; budget?: AiBudget; pacer?: Pacer } = {},
): CoachRuntime {
  const scripted = env.COACH_MODEL === "scripted";
  const hasModel = !!given || scripted || !!env.GEMINI_API_KEY;
  const pair = !given && scripted ? scriptedPair(env.COACH_SCRIPTED_SCENARIO ?? "ok") : null;
  const base: Model =
    given ??
    pair?.model ??
    createGeminiModel({ apiKey: env.GEMINI_API_KEY ?? "", model: env.GEMINI_MODEL, timeoutMs: env.COACH_CALL_TIMEOUT_MS });
  const available = env.AI_ENABLED && hasModel;
  // The scripted model counts against its own scope, so local runs never use the real budget.
  const budget =
    givenBudget ?? createAiBudget({ enabled: available, dailyCalls: env.AI_DAILY_CALL_BUDGET, scope: scripted && !given ? "dev:scripted" : "global:ai" });
  // The fallback (real Gemini only): the same pacer and budget, so every request still counts.
  const fallbackId = env.GEMINI_FALLBACK_MODEL;
  const fallback: Model | undefined =
    givenFallback ??
    pair?.fallback ??
    (!given && !scripted && env.GEMINI_API_KEY && fallbackId && fallbackId !== "none" && fallbackId !== env.GEMINI_MODEL
      ? createGeminiModel({ apiKey: env.GEMINI_API_KEY, model: fallbackId, timeoutMs: env.COACH_CALL_TIMEOUT_MS })
      : undefined);
  return {
    model: guardedModel(base, budget),
    ...(fallback ? { fallback: guardedModel(fallback, budget) } : {}),
    modelName: base.name,
    available,
    budget,
    pacer: givenPacer ?? createPacer({ rpm: env.GEMINI_RPM, tpm: env.GEMINI_TPM }),
    limits: {
      maxCalls: env.COACH_MAX_MODEL_CALLS,
      maxRepairCalls: env.COACH_MAX_REPAIR_CALLS,
      maxTokens: env.COACH_MAX_TOKENS,
      runTimeoutMs: env.COACH_RUN_TIMEOUT_MS,
      maxRequests: env.COACH_MAX_REQUESTS,
    },
    // Defaults for callers that predate asks (tests, scripts): env.ts's defaults.
    askLimits: {
      maxCalls: env.ASK_MAX_MODEL_CALLS ?? 6,
      maxRepairCalls: env.ASK_MAX_REPAIR_CALLS ?? 1,
      maxTokens: env.COACH_MAX_TOKENS,
      runTimeoutMs: env.ASK_RUN_TIMEOUT_MS ?? 120_000,
      maxRequests: env.ASK_MAX_REQUESTS ?? 10,
    },
    rules: {
      ...DEFAULT_RULES,
      minGap: env.COACH_MIN_BASELINE_GAP,
      minGames: env.COACH_MIN_CANDIDATE_GAMES,
      minMoves: env.COACH_MIN_CANDIDATE_MOVES,
    },
    minAnalysed: env.COACH_MIN_ANALYSED_GAMES,
    worstCaseCalls: env.COACH_MAX_REQUESTS,
  };
}
