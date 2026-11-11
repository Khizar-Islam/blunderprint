import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { Usage } from "../db/models/usage.js";
import { quotaId, refund, remaining, take, type QuotaRule } from "./quota.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

const MIN = 60_000;
const at = (iso: string) => new Date(iso);
const hourly = (limit: number): QuotaRule => ({ scope: "ip:abc|imports", limit, window: "hour" });
const daily = (limit: number): QuotaRule => ({ scope: "ip:abc|imports", limit, window: "day" });

describe("windows", () => {
  it("names an hour window by its UTC hour and a day window by its Pacific date", () => {
    assert.equal(quotaId("s", "hour", at("2026-11-11T14:59:59Z")), "s|2026-11-11T14");
    assert.equal(quotaId("s", "hour", at("2026-11-11T15:00:00Z")), "s|2026-11-11T15");
    // 07:00 UTC on 11 Nov is still 10 Nov in California (PST, UTC−8).
    assert.equal(quotaId("s", "day", at("2026-11-11T07:00:00Z")), "s|2026-11-10");
  });

  it("an hour window allows its limit, refuses with the time to the next hour, and a new hour starts at zero", async () => {
    const t = at("2026-11-11T14:40:00Z");
    for (let i = 0; i < 3; i++) assert.equal((await take([hourly(3)], t)).ok, true);
    const refused = await take([hourly(3)], t);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.retryAfterMs, 20 * MIN);
    assert.equal((await take([hourly(3)], at("2026-11-11T15:00:01Z"))).ok, true);
    // Kept an hour past the window's end (TTL), to look back a little.
    const doc = await Usage.findById("ip:abc|imports|2026-11-11T14").lean();
    assert.equal(doc!.expiresAt.toISOString(), "2026-11-11T16:00:00.000Z");
  });

  it("a day window refuses with the time to Pacific midnight", async () => {
    const t = at("2026-11-11T20:00:00Z"); // 12:00 PST
    assert.equal((await take([daily(1)], t)).ok, true);
    const refused = await take([daily(1)], t);
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.retryAfterMs, 12 * 60 * MIN);
  });
});

describe("take", () => {
  it("is all or nothing: when the day refuses, the hour it already took is given back", async () => {
    const t = at("2026-11-11T20:00:00Z");
    await Usage.create({ _id: quotaId("ip:abc|imports", "day", t), count: 2, expiresAt: new Date(t.getTime() + 86_400_000) });
    const res = await take([hourly(5), daily(2)], t);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.rule.window, "day");
    assert.equal(await remaining(hourly(5), t), 5);
  });

  it("allows exactly the limit when 20 takes race on an empty window", async () => {
    const t = at("2026-11-11T20:00:00Z");
    const results = await Promise.all(Array.from({ length: 20 }, () => take([hourly(4)], t)));
    assert.equal(results.filter((r) => r.ok).length, 4);
    assert.equal((await Usage.findById(quotaId("ip:abc|imports", "hour", t)).lean())!.count, 4);
  });

  it("a duplicate-key error is retried once (the window's first insert can race)", async () => {
    const t = at("2026-11-11T20:00:00Z");
    const real = Usage.findOneAndUpdate.bind(Usage);
    let calls = 0;
    const lost = mock.method(Usage, "findOneAndUpdate", (...args: Parameters<typeof Usage.findOneAndUpdate>) => {
      if (++calls === 1) return Promise.reject(Object.assign(new Error("E11000"), { code: 11000 }));
      return real(...args);
    });
    try {
      assert.equal((await take([hourly(3)], t)).ok, true);
      assert.equal(calls, 2);
    } finally {
      lost.mock.restore();
    }
  });

  it("a database error gives back what was taken, then throws", async () => {
    const t = at("2026-11-11T20:00:00Z");
    const real = Usage.findOneAndUpdate.bind(Usage);
    let calls = 0;
    const broken = mock.method(Usage, "findOneAndUpdate", (...args: Parameters<typeof Usage.findOneAndUpdate>) => {
      if (++calls === 2) return Promise.reject(new Error("connection reset"));
      return real(...args);
    });
    try {
      await assert.rejects(take([hourly(5), daily(5)], t), /connection reset/);
    } finally {
      broken.mock.restore();
    }
    assert.equal(await remaining(hourly(5), t), 5);
  });

  it("a limit of 0 refuses without writing", async () => {
    assert.equal((await take([hourly(0)])).ok, false);
    assert.equal(await Usage.countDocuments(), 0);
  });
});

describe("refund", () => {
  it("gives back one, never below zero", async () => {
    const t = at("2026-11-11T20:00:00Z");
    const res = await take([hourly(2), daily(2)], t);
    assert.ok(res.ok);
    if (!res.ok) return;
    await refund(res.taken);
    assert.equal(await remaining(hourly(2), t), 2);
    assert.equal(await remaining(daily(2), t), 2);
    await refund(res.taken);
    assert.equal((await Usage.findById(quotaId("ip:abc|imports", "hour", t)).lean())!.count, 0);
  });
});
