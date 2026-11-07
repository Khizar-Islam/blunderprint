import assert from "node:assert/strict";
import { test } from "node:test";
import { STAGGER_MS, staggerWait } from "./stagger";

test("reveals that arrive together start STAGGER_MS apart, in order", () => {
  let next = 0;
  const waits: number[] = [];
  for (let i = 0; i < 3; i++) {
    const s = staggerWait(next, 1000);
    waits.push(s.wait);
    next = s.next;
  }
  assert.deepEqual(waits, [0, STAGGER_MS, 2 * STAGGER_MS]);
});

test("a reveal on its own (after the queue has drained) starts at once", () => {
  const first = staggerWait(0, 1000);
  const later = staggerWait(first.next, 5000);
  assert.equal(later.wait, 0);
  assert.equal(later.next, 5000 + STAGGER_MS);
});

test("a reveal arriving mid-gap waits only for what's left of it", () => {
  const first = staggerWait(0, 1000); // next = 1120
  assert.equal(staggerWait(first.next, 1050).wait, 70);
});
