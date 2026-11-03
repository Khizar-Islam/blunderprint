import type { Speed } from "./api";

// The dashboard's filters live in the page URL (?color=&speed=&range=), so a filtered view can
// be shared and the back button steps through filter changes. The URL keeps the date range as a
// preset ("90d"), not a date: a shared "last 90 days" link stays the last 90 days. The API gets
// the date (apiQuery).

export const COLORS = ["white", "black"] as const;
export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "daily"] as const satisfies readonly Speed[];
export const RANGES = ["30d", "90d", "1y"] as const;

export type ColorFilter = (typeof COLORS)[number];
export type RangeFilter = (typeof RANGES)[number];

export interface DashboardFilters {
  color?: ColorFilter;
  speed?: Speed;
  range?: RangeFilter;
}

const RANGE_DAYS: Record<RangeFilter, number> = { "30d": 30, "90d": 90, "1y": 365 };

const pick = <T extends string>(allowed: readonly T[], value: string | null): T | undefined =>
  value !== null && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;

// Unknown or invalid values are dropped, not errors: an edited or old link still opens the
// dashboard, just without that filter.
export function parseFilters(params: { get(name: string): string | null }): DashboardFilters {
  const color = pick(COLORS, params.get("color"));
  const speed = pick(SPEEDS, params.get("speed"));
  const range = pick(RANGES, params.get("range"));
  return { ...(color && { color }), ...(speed && { speed }), ...(range && { range }) };
}

// Always the same key order, so the same filters give the same URL (and the same request).
export function filtersToQuery(f: DashboardFilters): string {
  const q = new URLSearchParams();
  if (f.color) q.set("color", f.color);
  if (f.speed) q.set("speed", f.speed);
  if (f.range) q.set("range", f.range);
  return q.toString();
}

// The start of a range, at 00:00 UTC of that day. Rounding to the day keeps the request the
// same all day (not a new `from` every millisecond).
export function rangeStart(range: RangeFilter, now: Date): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(day - RANGE_DAYS[range] * 86_400_000);
}

// The summary API's query: color, speed and an inclusive `from` date (YYYY-MM-DD).
export function apiQuery(f: DashboardFilters, now: Date): string {
  const q = new URLSearchParams();
  if (f.color) q.set("color", f.color);
  if (f.speed) q.set("speed", f.speed);
  if (f.range) q.set("from", rangeStart(f.range, now).toISOString().slice(0, 10));
  return q.toString();
}
