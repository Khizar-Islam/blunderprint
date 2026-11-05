import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { Usage } from "../db/models/usage.js";
import { BudgetRefused, createAiBudget, guardedModel, msUntilPacificMidnight, pacificDay } from "./budget.js";
import type { Model } from "./model.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

const H = 3_600_000;

describe("Pacific days", () => {
  it("names the Pacific date, which changes at 08:00 UTC in winter", () => {
    assert.equal(pacificDay(new Date("2026-11-05T07:59:59Z")), "2026-11-04");
    assert.equal(pacificDay(new Date("2026-11-05T08:00:00Z")), "2026-11-05");
    // Summer (PDT, UTC−7): the date changes at 07:00 UTC.
    assert.equal(pacificDay(new Date("2026-07-01T06:59:59Z")), "2026-06-30");
    assert.equal(pacificDay(new Date("2026-07-01T07:00:00Z")), "2026-07-01");
  });

  it("counts the time to the next Pacific midnight, also across both DST changes", () => {
    // 07:00 PST → 17 h.
    assert.equal(msUntilPacificMidnight(new Date("2026-11-05T15:00:00Z")), 17 * H);
    // 8 Mar 2026 (clocks go forward at 02:00, a 23-hour day): 00:30 PST → 22.5 h.
    assert.equal(msUntilPacificMidnight(new Date("2026-03-08T08:30:00Z")), 22.5 * H);
    // 1 Nov 2026 (clocks go back at 02:00, a 25-hour day): 00:30 PDT → 24.5 h.
    assert.equal(msUntilPacificMidnight(new Date("2026-11-01T07:30:00Z")), 24.5 * H);
    // A second before midnight → 1 s.
    assert.equal(msUntilPacificMidnight(new Date("2026-11-05T07:59:59Z")), 1_000);
  });
});

describe("the daily budget", () => {
  const at = (iso: string) => () => new Date(iso);

  it("allows exactly the budget, even when 20 reservations race on an empty day (run 10 times)", async () => {
    for (let round = 0; round < 10; round++) {
      // A new day each round, so every round starts with no document at all: the insert race.
      const day = new Date(Date.UTC(2026, 10, 10 + round, 20));
      const budget = createAiBudget({ enabled: true, dailyCalls: 5, now: () => day });
      const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve()));
      const ok = results.filter((r) => r.status === "fulfilled").length;
      const refused = results.filter((r) => r.status === "rejected" && r.reason instanceof BudgetRefused && r.reason.code === "ai_budget_exhausted");
      assert.equal(ok, 5, `round ${round}`);
      assert.equal(refused.length, 15, `round ${round}: every other result is a clean refusal`);
      assert.equal((await Usage.findById(`global:ai|${pacificDay(day)}`).lean())!.count, 5);
      assert.equal(await budget.remaining(), 0);
    }
  });

  // The empty-day race, forced: MongoDB usually absorbs two simultaneous first inserts as an
  // internal write conflict and retries them itself, so the real race above rarely produces a
  // duplicate-key error. Here the first attempt always gets one, as the losing insert would.
  it("a duplicate-key error from the day's first insert is retried once, and only once", async () => {
    const budget = createAiBudget({ enabled: true, dailyCalls: 5, now: at("2026-11-05T20:00:00Z") });
    const real = Usage.findOneAndUpdate.bind(Usage);
    let calls = 0;
    const lostRace = mock.method(Usage, "findOneAndUpdate", (...args: Parameters<typeof Usage.findOneAndUpdate>) => {
      if (++calls === 1) {
        // Meanwhile the winner's insert lands.
        return Usage.create({ _id: "global:ai|2026-11-05", count: 1, expiresAt: new Date("2026-11-09T08:00:00Z") }).then(() => {
          throw Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
        });
      }
      return real(...args);
    });
    try {
      await budget.reserve(); // not refused: the budget is almost untouched
      assert.equal(calls, 2);
      assert.equal(await budget.remaining(), 3);
    } finally {
      lostRace.mock.restore();
    }

    // Two misses in a row: really used up.
    const always = mock.method(Usage, "findOneAndUpdate", () => Promise.reject(Object.assign(new Error("E11000"), { code: 11000 })));
    try {
      await assert.rejects(budget.reserve(), (err: unknown) => err instanceof BudgetRefused && err.code === "ai_budget_exhausted");
      assert.equal(always.mock.callCount(), 2);
    } finally {
      always.mock.restore();
    }
  });

  it("allows exactly the budget when the day's document already exists", async () => {
    const budget = createAiBudget({ enabled: true, dailyCalls: 5, now: at("2026-11-05T20:00:00Z") });
    await budget.reserve();
    const results = await Promise.allSettled(Array.from({ length: 20 }, () => budget.reserve()));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 4);
    assert.equal(await budget.remaining(), 0);
  });

  it("a new Pacific day starts from zero, and an old day's document expires after it", async () => {
    let now = new Date("2026-11-06T07:30:00Z"); // 23:30 on 5 Nov, Pacific
    const budget = createAiBudget({ enabled: true, dailyCalls: 1, now: () => now });
    await budget.reserve();
    await assert.rejects(budget.reserve(), BudgetRefused);
    now = new Date("2026-11-06T08:30:00Z"); // 00:30 on 6 Nov
    await budget.reserve();
    const doc = await Usage.findById("global:ai|2026-11-05").lean();
    // Midnight Pacific (08:00 UTC) plus 3 days.
    assert.equal(doc!.expiresAt.toISOString(), "2026-11-09T08:00:00.000Z");
  });

  it("refuses everything when AI is off or the budget is 0, without writing", async () => {
    const off = createAiBudget({ enabled: false, dailyCalls: 400 });
    await assert.rejects(off.reserve(), (err: unknown) => err instanceof BudgetRefused && err.code === "ai_disabled");
    assert.equal(await off.remaining(), 0);
    const zero = createAiBudget({ enabled: true, dailyCalls: 0 });
    await assert.rejects(zero.reserve(), (err: unknown) => err instanceof BudgetRefused && err.code === "ai_budget_exhausted");
    assert.equal(await Usage.countDocuments(), 0);
  });

  it("scopes count separately (the scripted model never uses the real budget)", async () => {
    const now = at("2026-11-05T20:00:00Z");
    const real = createAiBudget({ enabled: true, dailyCalls: 3, now });
    const dev = createAiBudget({ enabled: true, dailyCalls: 3, scope: "dev:scripted", now });
    await dev.reserve();
    await dev.reserve();
    assert.equal(await real.remaining(), 3);
    assert.equal(await dev.remaining(), 1);
  });
});

describe("guardedModel", () => {
  it("takes one call from the budget before every request, and never calls the model once refused", async () => {
    let calls = 0;
    const model: Model = {
      name: "m",
      async call() {
        calls++;
        return { status: "completed", steps: [], usage: { input: 1, output: 1, total: 2 } };
      },
    };
    const budget = createAiBudget({ enabled: true, dailyCalls: 2, now: () => new Date("2026-11-05T20:00:00Z") });
    const guarded = guardedModel(model, budget);
    const req = { system: "", input: [], signal: new AbortController().signal };
    await guarded.call(req);
    await guarded.call(req);
    await assert.rejects(guarded.call(req), BudgetRefused);
    assert.equal(calls, 2);
    assert.equal(guarded.name, "m");
  });
});
