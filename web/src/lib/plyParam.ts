// The game review's ?ply=N (the Blunderprint links straight to a move): a whole number ≥ 0,
// clamped to the game's length once that is known. Anything else is ignored (start position).
export function parsePlyParam(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || !/^\d{1,4}$/.test(raw)) return null;
  return Number(raw);
}

export const clampPly = (ply: number | null, last: number) => Math.max(0, Math.min(last, ply ?? 0));
