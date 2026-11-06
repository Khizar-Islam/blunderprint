// The counting logic behind AnimatedNumber, kept free of React and the DOM so it can be tested.
//
// Why the safety timer: the count runs on requestAnimationFrame (through motion's animate).
// A browser that throttles animation frames (a background tab, battery saver, a slow test
// browser: one measured frame in 500 ms) can leave the number stuck at its start, so a coach
// stat read "0.0". The timer lands on the final value shortly after the animation should have
// ended, whether or not any frame ran. Writing the final value twice is harmless.

export const LAND_MARGIN_MS = 150;

type Controls = { stop: () => void };
export type Animator = (
  from: number,
  to: number,
  options: { duration: number; onUpdate: (n: number) => void },
) => Controls;

type Timers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
};

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

// Counts from `from` to `to` over `durationS` seconds, calling `write` with each value, and
// always ends with write(to). Returns a cancel function (for a new value or an unmount); a
// cancelled count writes nothing more.
export function countTo(
  { from, to, durationS, write }: { from: number; to: number; durationS: number; write: (n: number) => void },
  animator: Animator,
  timers: Timers = realTimers,
): () => void {
  let finished = false;
  const controls = animator(from, to, {
    duration: durationS,
    onUpdate: (n) => {
      if (!finished) write(n);
    },
  });
  const timer = timers.setTimeout(() => {
    if (finished) return;
    finished = true;
    controls.stop();
    write(to);
  }, durationS * 1000 + LAND_MARGIN_MS);
  return () => {
    finished = true;
    timers.clearTimeout(timer);
    controls.stop();
  };
}
