import { Usage } from "../db/models/usage.js";
import type { Model } from "./model.js";

// The AI guards (CLAUDE.md §10 "Guards"): the AI_ENABLED kill switch and a global daily call
// budget (AI_DAILY_CALL_BUDGET), both checked before a run starts AND before every single model
// request, retries included (each retry is a billed request).
//
// Days are Pacific-time dates: Google's daily quota resets at midnight Pacific, so ours does too.

const PACIFIC = "America/Los_Angeles";
const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
// How long a day's counter is kept after the day ends (TTL), for looking back a little.
const KEEP_AFTER_DAY_MS = 3 * DAY_MS;
const DUPLICATE_KEY = 11000;

const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PACIFIC, year: "numeric", month: "2-digit", day: "2-digit" });
const timeFormat = new Intl.DateTimeFormat("en-GB", { timeZone: PACIFIC, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });

// "2026-11-05": the Pacific date at this instant ("en-CA" formats dates as YYYY-MM-DD).
export const pacificDay = (at: Date): string => dayFormat.format(at);

// Milliseconds until the next Pacific midnight. A first guess from the wall clock (24 h minus
// the time of day) is exact on normal days; on the two DST change days the day is 23 or 25 h
// long, so the real midnight is the guess or one hour either side: take the first of those at
// which the date has changed.
export function msUntilPacificMidnight(at: Date): number {
  const [h, m, s] = timeFormat.format(at).split(":").map(Number) as [number, number, number];
  const guess = at.getTime() + DAY_MS - ((h * 60 + m) * 60 + s) * 1000 - at.getMilliseconds();
  const today = pacificDay(at);
  for (const t of [guess - HOUR_MS, guess, guess + HOUR_MS]) {
    if (pacificDay(new Date(t)) !== today && pacificDay(new Date(t - 1)) === today) return t - at.getTime();
  }
  return guess - at.getTime();
}

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
  const keyFor = (at: Date) => `${scope}|${pacificDay(at)}`;

  // Takes one call from today's budget, atomically, or throws BudgetRefused.
  //
  // One findOneAndUpdate: "the day's document, if its count is still under the budget: +1".
  // With upsert, a missing document is created with count 1. When the filter matches nothing
  // because the document exists but is AT the budget, the upsert tries to insert a second
  // document with the same _id and gets duplicate-key error 11000.
  //
  // But 11000 has a second cause: at the start of a day two requests can both find no
  // document and both insert; one wins and the other gets 11000 although the budget is almost
  // untouched. So on 11000 we try ONCE more: by then the document exists, the upsert can't
  // race any more, and a second miss really means the budget is used up.
  async function reserve(): Promise<void> {
    if (!enabled) throw new BudgetRefused("ai_disabled");
    if (dailyCalls <= 0) throw new BudgetRefused("ai_budget_exhausted"); // an insert would make count 1
    const at = now();
    const _id = keyFor(at);
    const expiresAt = new Date(at.getTime() + msUntilPacificMidnight(at) + KEEP_AFTER_DAY_MS);
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await Usage.findOneAndUpdate(
          { _id, count: { $lt: dailyCalls } },
          { $inc: { count: 1 }, $setOnInsert: { expiresAt } },
          { upsert: true, returnDocument: "after" },
        );
        return;
      } catch (err) {
        if ((err as { code?: number }).code !== DUPLICATE_KEY) throw err;
      }
    }
    throw new BudgetRefused("ai_budget_exhausted");
  }

  // Calls left today (0 when AI is off).
  async function remaining(): Promise<number> {
    if (!enabled) return 0;
    const doc = await Usage.findById(keyFor(now()), { count: 1 }).lean();
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
