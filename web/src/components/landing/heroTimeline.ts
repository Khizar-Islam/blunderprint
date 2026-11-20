import type { Layout } from "../patterns/geometry";

// The landing's first screen, "the print develops", as pure functions of the time since it
// started, so the phases and the final state can be tested without a browser. (What happens
// once the page is scrolled is in diveTimeline.ts.)
//
//   0 – 0.9 s     games arrive: quiet rows drop in from the top, the counter ticks up
//   1.2 – 4.0 s   the engine passes: a scan line sweeps the ply columns left to right and the
//                 player's errors take their colours behind it
//
// Everything is computed from the elapsed time, never counted frame by frame: a browser that
// skips frames (a throttled tab, a slow laptop) jumps to the right phase instead of lagging,
// and heroFrame(Infinity) is the final state (reduced motion, no frames, a scrolled page).

export const ARRIVE_MS = 900; // the last row starts arriving here
export const ROW_FADE_MS = 200;
export const SCAN_START_MS = 1200;
export const SCAN_END_MS = 4000;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export interface HeroFrame {
  rowAlpha: (row: number) => number;
  games: number; // the counter: rows that have started to arrive
  colouredUpTo: number; // plies coloured so far (Infinity once the pass is over)
  scanX: number | null; // the scan line's x in CSS px, while it runs
}

export function heroFrame(t: number, rows: number, l: Pick<Layout, "columns" | "tickW">): HeroFrame {
  const rowStart = (row: number) => (rows <= 1 ? 0 : (row / (rows - 1)) * ARRIVE_MS);
  const games = t < 0 ? 0 : t >= ARRIVE_MS ? rows : Math.min(rows, Math.floor((t / ARRIVE_MS) * (rows - 1)) + 1);

  let colouredUpTo = 0;
  let scanX: number | null = null;
  if (t >= SCAN_END_MS) colouredUpTo = Infinity;
  else if (t > SCAN_START_MS) {
    const cols = easeInOut((t - SCAN_START_MS) / (SCAN_END_MS - SCAN_START_MS)) * l.columns;
    colouredUpTo = Math.floor(cols);
    scanX = cols * l.tickW;
  }

  return { rowAlpha: (row) => clamp01((t - rowStart(row)) / ROW_FADE_MS), games, colouredUpTo, scanX };
}

// "0:04" / "1:07": a clock.
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
