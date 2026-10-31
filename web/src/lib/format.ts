// Display helpers for the games list. Pure functions, no React.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];
const relative = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

// "3 days ago", "yesterday", "2 hours ago"; under a minute is "just now".
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

// For the date's tooltip: "31 Oct 2026, 16:48".
export const fullDate = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });

// Both importers store "<initial seconds>+<increment seconds>", or "1/<seconds per move>" for
// daily games. Shown the way players say it: "3+2", "10+0", "½+0", "3 days".
export function formatTimeControl(tc?: string): string | null {
  if (!tc) return null;
  if (tc.startsWith("1/")) {
    const days = Number(tc.slice(2)) / 86_400;
    return Number.isFinite(days) ? `${days} day${days === 1 ? "" : "s"}` : null;
  }
  const [initial, increment = "0"] = tc.split("+");
  const minutes = Number(initial) / 60;
  if (!Number.isFinite(minutes)) return null;
  const shown = minutes === 0.5 ? "½" : minutes === 0.25 ? "¼" : Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${shown}+${increment}`;
}
