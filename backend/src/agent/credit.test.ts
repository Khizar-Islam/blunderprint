import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createAiBudget, guardedModel } from "./budget.js";
import { createCreditGate, creditGuarded, OUT_OF_CREDIT_HOLD_MS } from "./credit.js";
import { ModelError, userInput, type Model, type ModelRequest } from "./model.js";

const request = (): ModelRequest => ({ system: "s", input: [userInput("go")], signal: new AbortController().signal });
const OK = { status: "completed", steps: [], usage: { input: 1, output: 1, total: 2 } };

// A model whose next answer the test sets, counting the requests that reach it.
function fake() {
  const state = { calls: 0, fail: null as ModelError | null };
  const model: Model = {
    name: "fake",
    async call() {
      state.calls++;
      if (state.fail) throw state.fail;
      return OK;
    },
  };
  return { state, model };
}
const broke = () => new ModelError("out_of_credit", "Gemini 402: credits depleted", { status: 402 });

describe("the credit gate (out of prepaid AI credit)", () => {
  it("is off until marked, holds for 15 minutes, then lets go by itself", () => {
    let t = 1_000;
    const gate = createCreditGate({ now: () => t });
    assert.equal(OUT_OF_CREDIT_HOLD_MS, 15 * 60_000);
    assert.equal(gate.out(), false);
    assert.equal(gate.heldForMs(), 0);
    gate.mark();
    assert.equal(gate.out(), true);
    assert.equal(gate.heldForMs(), OUT_OF_CREDIT_HOLD_MS);
    t += OUT_OF_CREDIT_HOLD_MS - 1;
    assert.equal(gate.out(), true);
    t += 1;
    assert.equal(gate.out(), false);
  });

  it("a second 402 starts the hold over", () => {
    let t = 0;
    const gate = createCreditGate({ now: () => t, holdMs: 1_000 });
    gate.mark();
    t = 900;
    gate.mark();
    t = 1_500;
    assert.equal(gate.out(), true);
    t = 1_900;
    assert.equal(gate.out(), false);
  });
});

describe("creditGuarded", () => {
  it("a 402 starts the hold; while it's on, requests aren't sent at all; afterwards one goes through", async () => {
    let t = 0;
    const gate = createCreditGate({ now: () => t, holdMs: 1_000 });
    const { state, model } = fake();
    const guarded = creditGuarded(model, gate);
    assert.equal(guarded.name, "fake");

    assert.equal((await guarded.call(request())).status, "completed");
    state.fail = broke();
    await assert.rejects(guarded.call(request()), (e: unknown) => e instanceof ModelError && e.kind === "out_of_credit" && e.details.status === 402);
    assert.equal(gate.out(), true);
    assert.equal(state.calls, 2);

    // Held: the same kind of error (so the run fails the same way), but nothing was sent.
    await assert.rejects(guarded.call(request()), (e: unknown) => e instanceof ModelError && e.kind === "out_of_credit" && e.details.status === undefined);
    assert.equal(state.calls, 2);

    // Credit was added meanwhile: the first request after the hold simply works.
    t = 1_000;
    state.fail = null;
    assert.equal((await guarded.call(request())).status, "completed");
    assert.equal(state.calls, 3);
    assert.equal(gate.out(), false);
  });

  it("other errors pass through and never start the hold", async () => {
    const gate = createCreditGate();
    const { state, model } = fake();
    state.fail = new ModelError("rate_limited", "Gemini 429", { status: 429 });
    await assert.rejects(creditGuarded(model, gate).call(request()), (e: unknown) => e instanceof ModelError && e.kind === "rate_limited");
    assert.equal(gate.out(), false);
  });

  it("sits outside the budget guard: a held request takes nothing from the daily budget", async () => {
    const gate = createCreditGate();
    let reserved = 0;
    const budget = { reserve: async () => void reserved++ } as Pick<ReturnType<typeof createAiBudget>, "reserve">;
    const { model } = fake();
    const guarded = creditGuarded(guardedModel(model, budget), gate);
    await guarded.call(request());
    assert.equal(reserved, 1);
    gate.mark();
    await assert.rejects(guarded.call(request()));
    assert.equal(reserved, 1);
  });
});
