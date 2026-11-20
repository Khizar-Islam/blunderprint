import type { Summary } from "@/lib/api";
import { errorKindAt } from "./geometry";

// The plate's "print in one line": every game laid over the others, by move number. Kept out of
// the component so it can be tested.

type Ribbon = Summary["ribbons"][number];

// Move numbers past this share one last cell ("60+").
export const DIGEST_MOVES = 60;

// For each move number 1…60 (index 0…59), how often the player's move there was an error, as a
// share of the strip's busiest move (0–1, two decimals). A move number too few games reach
// (under 4% of them, at least 3) stays empty: one long game's blunder on move 58 would
// otherwise be the darkest cell of the strip.
export function moveDigest(ribbons: Ribbon[]): number[] {
  const errors = new Array<number>(DIGEST_MOVES).fill(0);
  const reached = new Array<number>(DIGEST_MOVES).fill(0);
  for (const r of ribbons) {
    const plies = r.classes.length;
    const own = r.color === "white" ? Math.ceil(plies / 2) : Math.floor(plies / 2);
    for (let n = 1; n <= own; n++) reached[Math.min(DIGEST_MOVES, n) - 1]!++;
    for (let ply = 1; ply <= plies; ply++) {
      if (errorKindAt(r.classes, ply, r.color)) errors[Math.min(DIGEST_MOVES, Math.ceil(ply / 2)) - 1]!++;
    }
  }
  const enough = Math.max(3, Math.ceil(ribbons.length * 0.04));
  const rate = errors.map((e, i) => (reached[i]! >= enough ? e / reached[i]! : 0));
  const max = Math.max(...rate);
  // A slight curve (^1.4) so the middling cells step back and the dense stretch reads at once.
  return rate.map((r) => (max > 0 ? Math.round((r / max) ** 1.4 * 100) / 100 : 0));
}

// The stretch of the game where the errors are densest, from the API's own move-number buckets
// (errors per 100 of the player's moves there), against the figure for all moves. Null when no
// bucket stands clear of the overall figure (at least 10% above it) on a fair number of moves
// (at least 100, the coach's own minimum for a group).
export const DENSEST_MIN_MOVES = 100;
export function densest(summary: Pick<Summary, "byMoveNumber" | "totals">): { bucket: string; per100: number; overall: number } | null {
  const { moves, mistakes } = summary.totals;
  if (moves <= 0) return null;
  const overall = Math.round((mistakes.total / moves) * 1000) / 10;
  let top: { bucket: string; per100: number } | null = null;
  for (const b of summary.byMoveNumber) {
    if (b.per100 === null || b.moves < DENSEST_MIN_MOVES) continue;
    if (!top || b.per100 > top.per100) top = { bucket: b.bucket, per100: b.per100 };
  }
  if (!top || top.per100 < overall * 1.1) return null;
  return { ...top, overall };
}

// "41+" → "from move 41 on"; "11-20" → "in moves 11 to 20".
export function bucketWords(bucket: string): string {
  if (bucket.endsWith("+")) return `from move ${bucket.slice(0, -1)} on`;
  const [from, to] = bucket.split("-");
  return `in moves ${from} to ${to}`;
}
