import assert from "node:assert/strict";
import { test } from "node:test";
import { createMountQueue } from "./mountQueue";

// A schedule we step by hand: each step() is one "frame".
function frames() {
  let pending: (() => void)[] = [];
  return {
    schedule: (run: () => void) => void pending.push(run),
    step() {
      const now = pending;
      pending = [];
      now.forEach((run) => run());
    },
  };
}

test("boards that ask together mount one per frame, in order", () => {
  const f = frames();
  const q = createMountQueue(f.schedule);
  const mounted: number[] = [];
  for (let i = 0; i < 4; i++) q.enqueue(() => mounted.push(i));
  assert.deepEqual(mounted, []); // nothing mounts in the frame that asked
  f.step();
  assert.deepEqual(mounted, [0]);
  f.step();
  f.step();
  assert.deepEqual(mounted, [0, 1, 2]);
  f.step();
  f.step(); // the queue is empty: it stops scheduling
  assert.deepEqual(mounted, [0, 1, 2, 3]);
  assert.equal(q.size, 0);
});

test("a cancelled board is skipped; a later one restarts the queue", () => {
  const f = frames();
  const q = createMountQueue(f.schedule);
  const mounted: string[] = [];
  q.enqueue(() => mounted.push("a"));
  const cancel = q.enqueue(() => mounted.push("b"));
  cancel();
  f.step();
  f.step();
  f.step();
  assert.deepEqual(mounted, ["a"]);
  q.enqueue(() => mounted.push("c"));
  f.step();
  assert.deepEqual(mounted, ["a", "c"]);
});
