import type { ErrorKind } from "@/lib/api";

// The Blunderprint's geometry and colours, kept out of the canvas component so they can be
// tested. One row per analysed game (newest first): a quiet line as long as the game, and one
// coloured MARK per error of the player's, at its ply. x is the ply number on ONE scale for
// every row, so a column is the same move in every game, and "you go wrong around move 25"
// shows up as a vertical band.
//
// (Until the UI pass of Nov 2026 every ply was its own tick: the player's moves dark, the
// opponent's faint. That alternation was the loudest thing in the picture, and the errors read
// as specks in grey noise. Single moves are still shown where ONE game is opened up: the loupe,
// the coach's lens, the landing's dive. TICK_COLOR is for those.)
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
// A game's quiet line in the print: between the two stone tones, clearly there on bone but far
// behind the three error colours.
export const RIDGE = "#cfc8b9";
// An error's mark covers its own ply and the reply's (2 columns), and is never thinner than
// MARK_MIN_W px, so a single error is visible in a 200-game print on a phone.
export const MARK_COLS = 2;
export const MARK_MIN_W = 2.5;

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

// The error whose mark covers `ply`: the ply itself, or the one before it (a mark is MARK_COLS
// wide). Null where the row is only its quiet line.
export function markAt(classes: string, color: Color, ply: number): number | null {
  for (let p = ply; p > ply - MARK_COLS && p >= 1; p--) if (errorKindAt(classes, p, color)) return p;
  return null;
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

export const INK = "#1b1d1a";
// A mark that isn't part of what's being pointed at (the dashboard's linked hovering).
export const DIM_ALPHA = 0.16;

export interface DrawOptions {
  // A row's top edge (default: row × pitch). The dashboard glides rows to their new place when
  // the filters change.
  y?: (row: number) => number;
  // false: draw over what's there (a second set of rows on the same canvas).
  clear?: boolean;
  // Linked hovering: "lit" marks are drawn larger with an ink edge, on top of everything;
  // "dim" ones fade back. Null: as usual.
  emphasis?: (row: number, ply: number) => "lit" | "dim" | null;
}

// Draws the rows: each game's quiet line, then its error marks on top. `alpha(row)` fades rows
// in (reveal and newly arrived games). `colouredUpTo`: errors after that ply aren't marked yet,
// as if not analysed (the landing's engine pass colours the print column by column). End markers
// appear once every column is coloured.
export function drawRows(
  ctx: CanvasRenderingContext2D,
  l: Layout,
  rows: { classes: string; color: Color }[],
  alpha: (row: number) => number,
  colouredUpTo = Infinity,
  opts: DrawOptions = {},
): void {
  if (opts.clear !== false) ctx.clearRect(0, 0, l.width, l.height);
  const edge = l.columns * l.tickW; // marks stop at the cap: the margin past it is the end marker's
  const lit: { x: number; y: number; w: number; color: string; a: number }[] = [];
  rows.forEach((r, row) => {
    const a = alpha(row);
    if (a <= 0) return;
    ctx.globalAlpha = a;
    const y = opts.y ? opts.y(row) : row * l.pitch;
    const shown = Math.min(r.classes.length, l.columns);
    ctx.fillStyle = RIDGE;
    ctx.fillRect(0, y, shown * l.tickW, l.rowH);
    const upTo = Math.min(shown, colouredUpTo);
    for (let ply = 1; ply <= upTo; ply++) {
      const kind = errorKindAt(r.classes, ply, r.color);
      if (!kind) continue;
      const x = (ply - 1) * l.tickW;
      const w = Math.min(Math.max(MARK_MIN_W, MARK_COLS * l.tickW), edge - x);
      const em = opts.emphasis ? opts.emphasis(row, ply) : null;
      if (em === "lit") {
        lit.push({ x, y, w, color: TICK_COLOR[kind], a });
        continue;
      }
      ctx.globalAlpha = em === "dim" ? a * DIM_ALPHA : a;
      ctx.fillStyle = TICK_COLOR[kind];
      ctx.fillRect(x, y, w, l.rowH);
    }
    ctx.globalAlpha = a;
    const t = truncation(r.classes, r.color, l.columns);
    if (t.cut && colouredUpTo > l.columns) {
      // End marker: a short notch after a 2 px gap, in the colour of the worst hidden error.
      ctx.fillStyle = t.worstHidden ? TICK_COLOR[t.worstHidden] : NEUTRAL_MARKER;
      ctx.fillRect(l.columns * l.tickW + 2, y, MARKER_W - 2, l.rowH);
    }
  });
  // The lit marks last, so a neighbouring row's line never covers their edge: 1 px larger all
  // round (at least 5 px wide), with an ink outline.
  for (const m of lit) {
    const w = Math.max(5, m.w + 2);
    ctx.globalAlpha = m.a;
    ctx.fillStyle = m.color;
    ctx.fillRect(m.x - 1, m.y - 2, w, l.rowH + 4);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1;
    ctx.strokeRect(m.x - 1.5, m.y - 2.5, w + 1, l.rowH + 5);
  }
  ctx.globalAlpha = 1;
}

// Where each row is while the rows glide to a new order (a filter changed, a game arrived).
// `from`/`to`: a row's top before and after; k: 0 → 1 over the move. Eased so rows settle.
export const glideEase = (k: number) => 1 - (1 - Math.min(1, Math.max(0, k))) ** 4;
export const glideY = (from: number, to: number, k: number) => from + (to - from) * glideEase(k);
// Rows that leave fade out in the first half of the move, where they were.
export const leaveAlpha = (k: number) => Math.max(0, 1 - Math.min(1, Math.max(0, k)) * 2.2);

// "23." for White's 23rd move, "23…" for Black's.
export const moveName = (ply: number) => `${Math.ceil(ply / 2)}${ply % 2 === 1 ? "." : "…"}`;
