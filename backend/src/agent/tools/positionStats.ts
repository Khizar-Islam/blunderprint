import { z } from "zod";

export const positionStatsArgs = z.object({
  fen: z.string().min(10).max(100),
  band: z.enum(["0-1199", "1200-1599", "1600-1999", "2000+"]).optional(),
});
export type PositionStatsArgs = z.infer<typeof positionStatsArgs>;

// Stub until Stage 4 builds positionStats (deferred: see CLAUDE.md §15). It answers honestly
// instead of inventing numbers, and the registry (index.ts) doesn't declare it to the model
// yet: a tool that always says "not available" would only waste the run's 10 model calls.
export async function getPositionStats(_args: PositionStatsArgs) {
  return {
    available: false as const,
    reason: "The database of positions from other players' games isn't loaded yet, so there are no statistics for this position.",
  };
}
