import { layout, type Layout } from "../patterns/geometry";

// The landing hero, "the print develops", as pure functions of the time since it started, so
// the phases and the final state can be tested without a browser.
//
//   0 – 0.9 s     games arrive: faint stone rows drop in from the top, the counter ticks up
//   1.2 – 4.0 s   the engine passes: a scan line sweeps the ply columns left to right and the
//                 player's moves take their colours behind it
//   4.2 – 5.7 s   the coach marks three moves: a ring, a hairline leader and a margin note each
//
// Everything is computed from the elapsed time, never counted frame by frame: a browser that
// skips frames (a throttled tab, a slow laptop) jumps to the right phase instead of lagging,
// and heroFrame(Infinity) is the final state (reduced motion, the safety timer).

export const ARRIVE_MS = 900; // the last row starts arriving here
export const ROW_FADE_MS = 200;
export const SCAN_START_MS = 1200;
export const SCAN_END_MS = 4000;
export const NOTES_START_MS = 4200;
export const NOTE_GAP_MS = 500;
export const NOTE_IN_MS = 500; // the ring, leader and note's own transition (CSS)

export const noteStartMs = (index: number) => NOTES_START_MS + index * NOTE_GAP_MS;
export const heroDurationMs = (notes: number) => noteStartMs(Math.max(0, notes - 1)) + NOTE_IN_MS;

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export interface HeroFrame {
  rowAlpha: (row: number) => number;
  games: number; // the counter: rows that have started to arrive
  colouredUpTo: number; // plies coloured so far (Infinity once the pass is over)
  scanX: number | null; // the scan line's x in CSS px, while it runs
  notes: number; // margin notes shown
  done: boolean;
}

export function heroFrame(t: number, rows: number, l: Pick<Layout, "columns" | "tickW">, notes: number): HeroFrame {
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

  let shown = 0;
  while (shown < notes && t >= noteStartMs(shown)) shown++;

  return {
    rowAlpha: (row) => clamp01((t - rowStart(row)) / ROW_FADE_MS),
    games,
    colouredUpTo,
    scanX,
    notes: shown,
    done: t >= heroDurationMs(notes),
  };
}

// The hero's rows are thinner than the dashboard's, so 200 games fit beside the headline
// (desktop: 2 px + 1 px gap = 600 px) and inside ~55% of a phone's screen (1 + 0.5 = 300 px;
// 1.5 CSS px is 3 device pixels on a typical phone, so the rows stay crisp).
export function heroLayout(width: number, lengths: number[], compact: boolean): Layout {
  const base = layout(width, lengths, true);
  const rowH = compact ? 1 : 2;
  const pitch = compact ? 1.5 : 3;
  return { ...base, rowH, pitch, height: lengths.length * pitch };
}

// The centre of a ply's tick: where a margin note's ring goes.
export const tickCentre = (l: Layout, row: number, ply: number) => ({
  x: (ply - 0.5) * l.tickW,
  y: row * l.pitch + l.rowH / 2,
});

// Margin notes sit level with their move, but never overlap: in order from the top, each is
// pushed down to at least `minGap` below the one before, then the stack is pulled back up if
// it runs past `height`. Returns each note's top, in the input order.
export function placeNotes(wanted: number[], height: number, minGap: number): number[] {
  const order = wanted.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const tops = order.map((o) => Math.max(0, o.y));
  for (let k = 1; k < tops.length; k++) tops[k] = Math.max(tops[k]!, tops[k - 1]! + minGap);
  const last = height - minGap;
  if (tops.length && tops[tops.length - 1]! > last) {
    tops[tops.length - 1] = Math.max(0, last);
    for (let k = tops.length - 2; k >= 0; k--) tops[k] = Math.max(0, Math.min(tops[k]!, tops[k + 1]! - minGap));
  }
  const out = new Array<number>(wanted.length);
  order.forEach((o, k) => (out[o.i] = tops[k]!));
  return out;
}

// "0:04" / "1:07": the clock in a margin note.
export function clockText(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
