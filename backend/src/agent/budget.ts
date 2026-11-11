import { msUntilPacificMidnight, quotaId, takeOne, type QuotaRule } from "../lib/quota.js";
import { Usage } from "../db/models/usage.js";
import type { Model } from "./model.js";

// The AI guards (CLAUDE.md §10 "Guards"): the AI_ENABLED kill switch and a global daily call
// budget (AI_DAILY_CALL_BUDGET), both checked before a run starts AND before every single model
// request, retries included (each retry is a billed request).
//
// Days are Pacific-time dates: Google's daily quota resets at midnight Pacific, so ours does too.
// The counting itself (one atomic update, the duplicate-key retry) is lib/quota.ts, shared with
// the per-visitor limits.

// Re-exported: the Pacific-day helpers lived here before lib/quota.ts.
export { msUntilPacificMidnight, pacificDay } from "../lib/quota.js";

export type BudgetRefusal = "ai_disabled" | "ai_budget_exhausted";

// Thrown before a model request that the guards don't allow. The agent loop turns it into a
// stop with the same code (and the run gets that friendly message).
export class BudgetRefused extends Error {
  constructor(readonly code: BudgetRefusal) {
    super(code === "ai_disabled" ? "AI is switched off (AI_ENABLED=false)" : "The daily AI call budget is used up");
    this.name = "BudgetRefused";
  }
}

export interface AiBudgetOptions {
  enabled: boolean;
  dailyCalls: number;
  // The counter's scope: "global:ai" for the real model. The local scripted model counts under
  // its own scope so development runs never use up the real budget (the DB may be shared).
  scope?: string;
  now?: () => Date;
}

export function createAiBudget({ enabled, dailyCalls, scope = "global:ai", now = () => new Date() }: AiBudgetOptions) {
  const rule: QuotaRule = { scope, limit: dailyCalls, window: "day" };

  // Takes one call from today's budget, atomically (lib/quota.ts takeOne), or throws BudgetRefused.
  async function reserve(): Promise<void> {
    if (!enabled) throw new BudgetRefused("ai_disabled");
    if (!(await takeOne(rule, now()))) throw new BudgetRefused("ai_budget_exhausted");
  }

  // Calls left today (0 when AI is off).
  async function remaining(): Promise<number> {
    if (!enabled) return 0;
    const doc = await Usage.findById(quotaId(scope, "day", now()), { count: 1 }).lean();
    return Math.max(0, dailyCalls - (doc?.count ?? 0));
  }

  return { enabled, dailyCalls, scope, reserve, remaining, resetsInMs: () => msUntilPacificMidnight(now()) };
}

export type AiBudget = ReturnType<typeof createAiBudget>;

// The model with the guards in front: every request first takes one call from the budget. The
// loop calls model.call() once per request, including retries, so every billed request counts.
// A request that then fails still counts: over-counting is the safe direction.
export function guardedModel(model: Model, budget: Pick<AiBudget, "reserve">): Model {
  return {
    name: model.name,
    async call(request) {
      await budget.reserve();
      return model.call(request);
    },
  };
}
