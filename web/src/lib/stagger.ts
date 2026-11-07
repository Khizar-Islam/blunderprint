// The stagger behind lib/useReveal.ts, kept free of React so it can be tested.
// Reveals that come into view together (the coach page's first screen of cards) start
// STAGGER_MS apart, in order; one that comes into view on its own starts at once.

export const STAGGER_MS = 120;

// How long a reveal that comes into view at `now` waits, and when the one after it may start.
// `next`: when the next reveal may start (performance.now() time).
export function staggerWait(next: number, now: number, gap = STAGGER_MS): { wait: number; next: number } {
  const wait = Math.max(0, next - now);
  return { wait, next: now + wait + gap };
}
