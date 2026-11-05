import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ModelError } from "./model.js";
import { scriptedPair, SCRIPTED_FALLBACK_NAME } from "./scriptedModel.js";

// COACH_SCRIPTED_SCENARIO: what each scenario's models do (the full runs are in coach.test.ts).
describe("scripted scenarios", () => {
  const req = () => ({ system: "", input: [], tools: [{ type: "function" as const, name: "x", description: "", parameters: {} }], signal: new AbortController().signal });

  it("overload-switch: the main model answers 503 twice, then works; a fallback exists", async () => {
    const { model, fallback } = scriptedPair("overload-switch");
    for (let i = 0; i < 2; i++) await assert.rejects(model.call(req()), (e: unknown) => e instanceof ModelError && e.kind === "overloaded");
    assert.equal((await model.call(req())).status, "requires_action");
    assert.equal(fallback!.name, SCRIPTED_FALLBACK_NAME);
  });

  it("fail-overloaded: both models always answer 503", async () => {
    const { model, fallback } = scriptedPair("fail-overloaded");
    for (const m of [model, fallback!]) await assert.rejects(m.call(req()), (e: unknown) => e instanceof ModelError && e.kind === "overloaded");
  });

  it("ok and slow have no fallback", () => {
    assert.equal(scriptedPair("ok").fallback, undefined);
    assert.equal(scriptedPair("slow").fallback, undefined);
  });
});
