import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { refetchDelay, REFETCH_GAP_MS, type RefetchState } from "./refetch";

const base: RefetchState = { stale: false, extracting: false, hidden: false, inFlight: false, lastFetchAt: 100_000, now: 100_000 };

describe("refetchDelay", () => {
  test("nothing new: no refetch", () => {
    assert.equal(refetchDelay(base), null);
  });
  test("stale right after a fetch: waits out the 10 s gap", () => {
    assert.equal(refetchDelay({ ...base, stale: true, now: 103_000 }), REFETCH_GAP_MS - 3_000);
  });
  test("stale long after the last fetch: at once", () => {
    assert.equal(refetchDelay({ ...base, stale: true, now: 500_000 }), 0);
  });
  test("still extracting keeps polling every 10 s even with no new pulse", () => {
    assert.equal(refetchDelay({ ...base, extracting: true }), REFETCH_GAP_MS);
  });
  test("never while a request is out or the tab is hidden", () => {
    assert.equal(refetchDelay({ ...base, stale: true, inFlight: true }), null);
    assert.equal(refetchDelay({ ...base, extracting: true, hidden: true }), null);
  });
});
