// How many rows of a long list to render at once (the games list, GamesList.tsx).
//
// Rendering 200 rows in one go is one long frame on a slow phone. So a list that has just
// arrived renders its first rows at once and the rest in a later, interruptible render
// (React's useDeferredValue: `drawn` is the list React has already rendered in full, and it
// catches up with `total` in the background). Rows that are already on screen are never taken
// away: a refreshed list keeps at least as many rows as were drawn before.
export const FIRST_ROWS = 30; // more than a screen of rows (57-75 px each) on any device

export function urgentRowCount(total: number, drawn: number, caughtUp: boolean, first = FIRST_ROWS): number {
  if (caughtUp) return total;
  return Math.min(total, Math.max(first, drawn));
}
