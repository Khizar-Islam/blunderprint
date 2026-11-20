import type { ErrorKind } from "@/lib/api";

// The landing's first screen, "the print develops", as pure functions of the time since it
// started, so the phases and the final state can be tested without a browser. (What happens
// once the page is scrolled is in diveTimeline.ts.)
//
// It develops like a photograph in its tray, the faintest marks first:
//
//   0 – 0.5 s     games arrive: quiet rows drop in from the top, the counter ticks up
//   0.5 – 1.1 s   the inaccuracies bleed in, from the paper's own tone to full amber
//   1.0 – 1.6 s   the mistakes
//   1.5 – 2.2 s   the blunders
//   2.3 – 2.6 s   one last mark: the move the page follows
//   2.7 – 3.3 s   the print shows the coach's finding: the marks outside the stretch of the game
//                 it is about recede, so that stretch stands out as a lit band
//
// Everything is computed from the elapsed time, never counted frame by frame: a browser that
// skips frames (a throttled tab, a slow laptop) jumps to the right phase instead of lagging,
// and heroFrame(Infinity) is the final state (reduced motion, no frames, a scrolled page).

export const ARRIVE_MS = 500; // the last row starts arriving here
export const ROW_FADE_MS = 200;
export const KIND_MS: Record<ErrorKind, readonly [number, number]> = {
  inaccuracy: [500, 1100],
  mistake: [1000, 1600],
  blunder: [1500, 2200],
};
export const TARGET_MS: readonly [number, number] = [2300, 2600];
export const DEVELOPED_MS = TARGET_MS[1]; // the whole print is there
export const RECEDE_MS: readonly [number, number] = [DEVELOPED_MS + 100, DEVELOPED_MS + 700];
export const RECEDED_STRENGTH = 0.3; // how much colour a mark outside the finding's band keeps

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const span = (t: number, [from, to]: readonly [number, number]) => clamp01((t - from) / (to - from));

export interface HeroFrame {
  rowAlpha: (row: number) => number;
  games: number; // the counter: rows that have started to arrive
  kind: Record<ErrorKind, number>; // how far each kind of mark has developed, 0 to 1
  target: number; // … and the one followed move, which comes last
}

export function heroFrame(t: number, rows: number): HeroFrame {
  const rowStart = (row: number) => (rows <= 1 ? 0 : (row / (rows - 1)) * ARRIVE_MS);
  const games = t < 0 ? 0 : t >= ARRIVE_MS ? rows : Math.min(rows, Math.floor((t / ARRIVE_MS) * (rows - 1)) + 1);
  return {
    rowAlpha: (row) => clamp01((t - rowStart(row)) / ROW_FADE_MS),
    games,
    kind: { inaccuracy: span(t, KIND_MS.inaccuracy), mistake: span(t, KIND_MS.mistake), blunder: span(t, KIND_MS.blunder) },
    target: span(t, TARGET_MS),
  };
}

// How far the marks outside the finding's band have receded: 0 not at all, 1 fully.
export function recedeAt(t: number): number {
  const x = span(t, RECEDE_MS);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

// "0:04" / "1:07": a clock.
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
