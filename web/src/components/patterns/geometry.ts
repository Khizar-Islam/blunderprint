import type { ErrorKind } from "@/lib/api";

// The Blunderprint's geometry and colours, kept out of the canvas component so they can be
// tested. One row per analysed game (newest first), one tick per ply. x is the ply number on
// ONE scale for every row, so a column is the same move in every game, and "you go wrong
// around move 25" shows up as a vertical band.
//
// Plies are 1-based here (ply 1 = White's first move), like the game review's ?ply=N.

// Rows longer than this are cut, so one 200-ply game doesn't squash every other row into
// slivers. A cut row gets an end marker (tinted by the worst error past the cap), and the loupe
// and keyboard still reach every ply.
export const PLY_CAP = 120;
// Room at the right edge for the end marker of a cut row.
export const MARKER_W = 6;

export type Tick = "own" | "opponent" | ErrorKind;

// Canvas can't read CSS variables cheaply, so the palette is repeated here as hex.
// Keep in sync with globals.css (@theme).
export const TICK_COLOR: Record<Tick, string> = {
  own: "#8c8675", // square-dark: the player's good and best moves
  opponent: "#d8d2c4", // square-light: the opponent's moves, faint on bone
  inaccuracy: "#d4a72c",
  mistake: "#d9772b",
  blunder: "#b3362b",
};
export const NEUTRAL_MARKER = "#2b2b28"; // graphite: a cut row with no hidden errors

const LETTER_KIND: Record<string, ErrorKind | undefined> = { i: "inaccuracy", m: "mistake", x: "blunder" };
const SEVERITY: Record<ErrorKind, number> = { inaccuracy: 1, mistake: 2, blunder: 3 };

export type Color = "white" | "black";

// White plays the odd plies (standard games only, so White always moves first).
export const isPlayersPly = (ply: number, color: Color) => (ply % 2 === 1) === (color === "white");

// What one tick shows: the opponent's moves are neutral whatever their class; the player's
// errors carry their colour.
export function tickAt(classes: string, ply: number, color: Color): Tick {
  if (!isPlayersPly(ply, color)) return "opponent";
  return LETTER_KIND[classes[ply - 1] ?? ""] ?? "own";
}

export const errorKindAt = (classes: string, ply: number, color: Color): ErrorKind | null => {
  const t = tickAt(classes, ply, color);
  return t === "own" || t === "opponent" ? null : t;
};

// The player's error plies in a game, in order, including those past the cap.
export function errorPlies(classes: string, color: Color): number[] {
  const out: number[] = [];
  for (let ply = 1; ply <= classes.length; ply++) if (errorKindAt(classes, ply, color)) out.push(ply);
  return out;
}

// The next (dir 1) or previous (dir −1) error from `from` (exclusive; null = from the edge).
// Null when there is none that way.
export function stepError(classes: string, color: Color, from: number | null, dir: 1 | -1): number | null {
  const plies = errorPlies(classes, color);
  if (dir === 1) return plies.find((p) => from === null || p > from) ?? null;
  for (let i = plies.length - 1; i >= 0; i--) if (from === null || plies[i]! < from) return plies[i]!;
  return null;
}

// A row past the cap: is it cut, and the worst error of the player's among the hidden plies.
export function truncation(classes: string, color: Color, cap = PLY_CAP): { cut: boolean; worstHidden: ErrorKind | null } {
  if (classes.length <= cap) return { cut: false, worstHidden: null };
  let worst: ErrorKind | null = null;
  for (let ply = cap + 1; ply <= classes.length; ply++) {
    const k = errorKindAt(classes, ply, color);
    if (k && (worst === null || SEVERITY[k] > SEVERITY[worst])) worst = k;
  }
  return { cut: true, worstHidden: worst };
}

export interface Layout {
  width: number;
  height: number;
  rowH: number;
  pitch: number; // row height + gap
  columns: number; // plies across (the longest game, at most the cap)
  tickW: number;
  rows: number;
}

// Desktop: 3 px rows with a 1 px gap (200 games = 800 px). Narrow screens: 2 + 1 px.
export function layout(width: number, lengths: number[], compact: boolean, cap = PLY_CAP): Layout {
  const rowH = compact ? 2 : 3;
  const pitch = rowH + 1;
  const columns = Math.max(1, Math.min(cap, Math.max(0, ...lengths)));
  const tickW = Math.max(0, width - MARKER_W) / columns;
  return { width, height: lengths.length * pitch, rowH, pitch, columns, tickW, rows: lengths.length };
}

// The row and ply under a point on the canvas. The gap below a row counts as that row, so
// hovering never flickers between rows. ply is null past the row's last (shown) ply or over
// the end-marker margin.
export function hitTest(l: Layout, lengths: number[], x: number, y: number): { row: number; ply: number | null } | null {
  if (x < 0 || y < 0 || x >= l.width || y >= l.height) return null;
  const row = Math.floor(y / l.pitch);
  if (row >= l.rows) return null;
  const col = Math.floor(x / l.tickW);
  const ply = col + 1;
  const shown = Math.min(lengths[row]!, l.columns);
  return { row, ply: col < l.columns && ply <= shown ? ply : null };
}

// The loupe draws one game's FULL row (no cap) across its own width: the ply under x there.
export function loupePly(width: number, plies: number, x: number): number | null {
  if (plies <= 0 || x < 0 || x >= width) return null;
  return Math.min(plies, Math.floor((x / width) * plies) + 1);
}

// Draws the rows. `alpha(row)` fades rows in (reveal and newly arrived games).
// `colouredUpTo`: plies after it are drawn as faint stone, as if not analysed yet (the landing
// hero's engine pass colours the print column by column). End markers appear once every
// column is coloured.
export function drawRows(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  rows: { classes: string; color: Color }[],
  alpha: (row: number) => number,
  colouredUpTo = Infinity,
): void {
  const tick = (r: { classes: string; color: Color }, ply: number): Tick => (ply <= colouredUpTo ? tickAt(r.classes, ply, r.color) : "opponent");
  ctx.clearRect(0, 0, l.width, l.height);
  rows.forEach((r, row) => {
    const a = alpha(row);
    if (a <= 0) return;
    ctx.globalAlpha = a;
    const y = row * l.pitch;
    const shown = Math.min(r.classes.length, l.columns);
    // Runs of one colour are one rectangle: fewer draw calls, and no hairline seams between ticks.
    let start = 1;
    for (let ply = 2; ply <= shown + 1; ply++) {
      const prev = tick(r, ply - 1);
      if (ply === shown + 1 || tick(r, ply) !== prev) {
        ctx.fillStyle = TICK_COLOR[prev];
        ctx.fillRect((start - 1) * l.tickW, y, (ply - start) * l.tickW, l.rowH);
        start = ply;
      }
    }
    const t = truncation(r.classes, r.color, l.columns);
    if (t.cut && colouredUpTo > l.columns) {
      // End marker: a short notch after a 2 px gap, in the colour of the worst hidden error.
      ctx.fillStyle = t.worstHidden ? TICK_COLOR[t.worstHidden] : NEUTRAL_MARKER;
      ctx.fillRect(l.columns * l.tickW + 2, y, MARKER_W - 2, l.rowH);
    }
  });
  ctx.globalAlpha = 1;
}

// "23." for White's 23rd move, "23…" for Black's.
export const moveName = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"}`;
