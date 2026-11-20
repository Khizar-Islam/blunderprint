import { logger } from "../lib/logger.js";
import { ModelError, type Model } from "./model.js";

// Out of prepaid credit (Stage 8 chunk H). On Google's paid tier the project runs on prepaid
// credits; when the balance reaches $0 every request fails with HTTP 402 until credits are added
// (auto-reload is off on purpose, so the spend can never run away).
//
// Nothing we do can fix that, so the coach stops asking: after a 402, new reports and questions
// are refused up front for OUT_OF_CREDIT_HOLD_MS, and queued runs fail without sending anything.
// Cached reports and answers are still served. When the hold ends, the next run is let through:
// if credit was added it simply works; if not, its first request gets the 402 again (it costs
// nothing) and the hold starts over.
//
// In memory, per process: a restart forgets it, and the first run after it finds out again with
// one request. That is fine for one Render instance.

export const OUT_OF_CREDIT_HOLD_MS = 15 * 60_000;

export interface CreditGate {
  // A request just failed for lack of credit: start (or restart) the hold.
  mark(info?: Record<string, unknown>): void;
  // Is the hold on?
  out(): boolean;
  heldForMs(): number;
}

export function createCreditGate({ holdMs = OUT_OF_CREDIT_HOLD_MS, now = Date.now }: { holdMs?: number; now?: () => number } = {}): CreditGate {
  let until = 0;
  return {
    mark(info = {}) {
      until = now() + holdMs;
      // Error level: this needs me (add credit in AI Studio), not a retry.
      logger.error("ai_out_of_credit", { ...info, holdMs });
    },
    out: () => now() < until,
    heldForMs: () => Math.max(0, until - now()),
  };
}

// The model with the credit gate in front. While the hold is on, a request isn't sent at all (so
// it takes nothing from the daily budget either: this wrapper sits outside the budget guard);
// a request that comes back "out of credit" starts the hold.
export function creditGuarded(model: Model, credit: CreditGate): Model {
  return {
    name: model.name,
    async call(request) {
      if (credit.out()) throw new ModelError("out_of_credit", "Not sent: the AI account was out of credit a moment ago");
      try {
        return await model.call(request);
      } catch (err) {
        if (err instanceof ModelError && err.kind === "out_of_credit") {
          credit.mark({ model: model.name, status: err.details.status, error: err.message });
        }
        throw err;
      }
    },
  };
}
