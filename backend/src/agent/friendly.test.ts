import { describe, it, test } from "node:test";
import assert from "node:assert/strict";
import { friendly, friendlyFromAgent, waitText } from "./friendly.js";

describe("friendly messages", () => {
  it("maps every way a run can stop to a fixed code", () => {
    const cases: [Parameters<typeof friendlyFromAgent>[0], string][] = [
      [{ code: "time_limit", message: "x" }, "coach_timeout"],
      [{ code: "token_limit", message: "x" }, "coach_too_long"],
      [{ code: "call_limit", message: "x" }, "coach_too_long"],
      [{ code: "no_answer", message: "x" }, "coach_no_answer"],
      [{ code: "aborted", message: "x" }, "coach_interrupted"],
      [{ code: "ai_disabled", message: "x" }, "ai_disabled"],
      [{ code: "ai_budget_exhausted", message: "x" }, "ai_budget_exhausted"],
      [{ code: "model_error", message: "x", modelErrorKind: "rate_limited" }, "ai_busy"],
      [{ code: "model_error", message: "x", modelErrorKind: "timeout" }, "ai_unavailable"],
      [{ code: "model_error", message: "x", modelErrorKind: "server" }, "ai_unavailable"],
      [{ code: "model_error", message: "x", modelErrorKind: "network" }, "ai_unavailable"],
      [{ code: "model_error", message: "x", modelErrorKind: "auth" }, "coach_config"],
      [{ code: "model_error", message: "x", modelErrorKind: "bad_request" }, "coach_config"],
      [{ code: "model_error", message: "Unexpected error: secret", unexpected: true }, "internal"],
      [undefined, "internal"],
    ];
    for (const [error, code] of cases) assert.equal(friendlyFromAgent(error).code, code, JSON.stringify(error));
  });

  it("never passes the internal message through", () => {
    const secret = "Gemini 401 API key AIza-SECRET invalid at /v1beta/interactions";
    for (const kind of ["auth", "bad_request", "server", "rate_limited"] as const) {
      const f = friendlyFromAgent({ code: "model_error", message: secret, modelErrorKind: kind });
      assert.ok(!f.message.includes("SECRET") && !f.message.includes("Gemini"), f.message);
    }
  });

  it("fills in the numbers it's given", () => {
    assert.equal(
      friendly("not_enough_games", { analysed: 12, needed: 20 }).message,
      "The coach needs at least 20 analysed games. 12 are ready, so keep this page open while the engine analyses more.",
    );
    assert.match(friendly("not_enough_games", { analysed: 1, needed: 20 }).message, /1 is ready/);
    assert.match(friendly("ai_budget_exhausted", { resetsInMs: 5.4 * 3_600_000 }).message, /midnight Pacific time \(about 5 hours from now\)/);
    assert.match(friendly("ai_budget_exhausted", { resetsInMs: 60_000 }).message, /about 1 hour from now/);
  });
});

test("the Stage 6 refusals: fixed messages, waits in words", () => {
  assert.equal(waitText(30_000), "in a minute");
  assert.equal(waitText(20 * 60_000 + 1), "in about 21 minutes");
  assert.equal(waitText(89 * 60_000), "in about 89 minutes");
  assert.equal(waitText(5 * 3_600_000), "in about 5 hours");
  assert.match(friendly("limit_imports", { retryAfterMs: 20 * 60_000 }).message, /start another in about 20 minutes/);
  assert.match(friendly("limit_reports", { retryAfterMs: 3 * 3_600_000 }).message, /in about 3 hours/);
  for (const code of ["limit_requests", "limit_new_players", "storage_full", "busy"] as const) {
    const f = friendly(code);
    assert.equal(f.code, code);
    assert.ok(f.message.length > 20);
    assert.ok(!/\d{3}/.test(f.message), "no status codes or raw numbers in the message");
  }
});
