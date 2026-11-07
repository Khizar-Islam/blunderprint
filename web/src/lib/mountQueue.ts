// One heavy mount per frame. The coach page has 8–12 evidence boards (react-chessboard: 64
// squares and 32 pieces each); mounting them all when the report arrives was one frame of
// 145 ms on my laptop (the ?perf=1 probe). Here each board waits its turn, and a turn is one
// animation frame, so the work is spread out and no single frame carries more than one board.
//
// `schedule` is when the next turn may run. The page uses `nextFrame` (below); tests pass their
// own. A cancelled entry (its board unmounted first) is skipped.

export type Schedule = (run: () => void) => void;

export function createMountQueue(schedule: Schedule) {
  const waiting: (() => void)[] = [];
  let pumping = false;
  const pump = () => {
    const next = waiting.shift();
    if (!next) {
      pumping = false;
      return;
    }
    next();
    schedule(pump);
  };
  return {
    // Runs `mount` on a later turn; returns a cancel function.
    enqueue(mount: () => void): () => void {
      waiting.push(mount);
      if (!pumping) {
        pumping = true;
        schedule(pump);
      }
      return () => {
        const i = waiting.indexOf(mount);
        if (i >= 0) waiting.splice(i, 1);
      };
    },
    get size() {
      return waiting.length;
    },
  };
}

// The next animation frame, or 100 ms, whichever comes first: a browser that throttles frames
// (background tab, battery saver) still mounts every board, a few per second.
export const nextFrame: Schedule = (run) => {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    run();
  };
  const timer = setTimeout(once, 100);
  requestAnimationFrame(once);
};
