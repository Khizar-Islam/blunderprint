import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { countTo, LAND_MARGIN_MS, type Animator } from "./countTo";

// A fake animator that records its onUpdate and never runs a frame by itself, like a browser
// that throttles requestAnimationFrame. `frame(n)` runs one frame by hand.
function fakeAnimator() {
  let onUpdate: ((n: number) => void) | null = null;
  let stopped = false;
  const animator: Animator = (_from, _to, options) => {
    onUpdate = options.onUpdate;
    return { stop: () => (stopped = true) };
  };
  return {
    animator,
    frame: (n: number) => onUpdate?.(n),
    get stopped() {
      return stopped;
    },
  };
}

describe("countTo", () => {
  beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
  afterEach(() => mock.timers.reset());

  test("lands on the final value even when no animation frame ever runs", () => {
    const fake = fakeAnimator();
    const written: number[] = [];
    countTo({ from: 0, to: 7.9, durationS: 0.6, write: (n) => written.push(n) }, fake.animator);
    mock.timers.tick(600);
    assert.deepEqual(written, [], "nothing before the margin");
    mock.timers.tick(LAND_MARGIN_MS);
    assert.deepEqual(written, [7.9]);
    assert.equal(fake.stopped, true);
  });

  test("frames write in-between values, then the timer still ends on the final one", () => {
    const fake = fakeAnimator();
    const written: number[] = [];
    countTo({ from: 0, to: 10, durationS: 0.6, write: (n) => written.push(n) }, fake.animator);
    fake.frame(3);
    fake.frame(6.5);
    mock.timers.tick(600 + LAND_MARGIN_MS);
    assert.deepEqual(written, [3, 6.5, 10]);
    fake.frame(9.9); // a late frame after landing changes nothing
    assert.deepEqual(written, [3, 6.5, 10]);
  });

  test("cancelling (new value, unmount) stops the count and writes nothing more", () => {
    const fake = fakeAnimator();
    const written: number[] = [];
    const cancel = countTo({ from: 0, to: 5, durationS: 0.6, write: (n) => written.push(n) }, fake.animator);
    fake.frame(1);
    cancel();
    fake.frame(2);
    mock.timers.tick(5000);
    assert.deepEqual(written, [1]);
    assert.equal(fake.stopped, true);
  });
});
