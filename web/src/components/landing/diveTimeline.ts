import type { ErrorKind } from "@/lib/api";
import { errorKindAt, PLY_CAP, type Color } from "../patterns/geometry";
import type { DemoRibbon } from "./demoData";

// The landing's dive, as pure functions: how far the page has been scrolled (one number, p from
// 0 to 1) decides everything on the stage. Nothing is counted frame by frame, so a browser that
// skips frames lands on the right picture, and p = 1 is the final state.
//
//   A  0.03 – 0.30  the print parts around one game; that game's line opens into single moves
//   B  0.33 – 0.55  the strip zooms sideways until one move is a square
//   C  0.57 – 0.68  that square grows into the board (the position before the move)
//   D  0.70 – 0.87  the move played slides out along a rust arrow, slides back, and a teal arrow
//                   draws the better move
//   E  0.88 – 0.99  the coach's sentence about it; the move's own number is underlined
//                   (phones: the board first shrinks to make room for the words under it)

export const DIVE_COLS = PLY_CAP; // columns of the first screen's print, as on the dashboard

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
export const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
// A zoom feels even when the size grows by the same FACTOR per step, not the same amount.
export const xlerp = (a: number, b: number, t: number) => a * (b / a) ** t;
// How far p is through the stretch from..to (0 before, 1 after).
export const seg = (p: number, from: number, to: number) => clamp01((p - from) / (to - from));

export interface DivePhases {
  a: number; // the print parts, the game opens
  b: number; // the sideways zoom
  c: number; // the square becomes the board
  slide: number; // the played piece: 0 on its own square, 1 on the square it moved to
  played: number; // the rust arrow
  better: number; // the teal arrow
  shrink: number; // phones only: the board gives the words room
  words: number; // the coach's sentence
  check: number; // the underline under the move's own number
  ctas: number;
}

export function divePhases(p: number): DivePhases {
  const played = ease(seg(p, 0.7, 0.76));
  return {
    a: ease(seg(p, 0.03, 0.3)),
    b: ease(seg(p, 0.33, 0.55)),
    c: ease(seg(p, 0.57, 0.68)),
    slide: played - ease(seg(p, 0.78, 0.82)),
    played,
    better: ease(seg(p, 0.82, 0.87)),
    shrink: ease(seg(p, 0.87, 0.915)),
    words: ease(seg(p, 0.88, 0.95)),
    check: ease(seg(p, 0.93, 0.98)),
    ctas: ease(seg(p, 0.95, 0.99)),
  };
}

export interface DiveRow {
  len: number;
  color: Color;
  classes: string;
  errs: { ply: number; kind: ErrorKind }[]; // the player's errors
}

export function diveRows(ribbons: DemoRibbon[]): DiveRow[] {
  return ribbons.map((r) => {
    const errs: DiveRow["errs"] = [];
    for (let ply = 1; ply <= r.classes.length; ply++) {
      const kind = errorKindAt(r.classes, ply, r.color);
      if (kind) errs.push({ ply, kind });
    }
    return { len: r.classes.length, color: r.color, classes: r.classes, errs };
  });
}

// found[c]: the errors in columns 1..c of the print (errors past the last column count in it),
// so the counter can run with the scan line.
export function errorsFoundUpTo(rows: DiveRow[], columns = DIVE_COLS): number[] {
  const found: number[] = new Array(columns + 1).fill(0);
  for (const r of rows) for (const e of r.errs) found[Math.min(e.ply, columns)]! += 1;
  for (let c = 1; c < found.length; c++) found[c]! += found[c - 1]!;
  return found;
}

// The coach's sentence around the move's own figure: [before, figure, after]. The figure is
// underlined; when the sentence doesn't hold it, the whole sentence comes back as `before`.
export function splitFigure(sentence: string, figure: string | null): [string, string, string] {
  const at = figure ? sentence.indexOf(figure) : -1;
  if (!figure || at < 0) return [sentence, "", ""];
  return [sentence.slice(0, at), figure, sentence.slice(at + figure.length)];
}

// "won as White", "lost as Black", "drew as White".
export function resultWords(result: "win" | "loss" | "draw", color: Color): string {
  const verb = result === "win" ? "won" : result === "loss" ? "lost" : "drew";
  return `${verb} as ${color === "white" ? "White" : "Black"}`;
}

// A day in UTC, the same text on the server and in every visitor's time zone: "6 Oct 2026".
export const utcDay = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

// ---- The stage's layout ------------------------------------------------------------------------

export interface StageBox {
  wide: boolean; // the words beside the print (from 1280 px)
  hx: number; // the print's left edge on the first screen
  hy: number; // … and its top
  pitch0: number; // a row and its gap on the first screen
  rowH0: number;
  board: number; // the board's side while its story is told
  small: number; // … and once the coach's words are there (phones: they sit under it)
  bx: number;
  by: number;
}

// `fit` (phones): the tallest board that still leaves room for the caption and the coach's words
// under it; the stage is one screen tall, so the board shrinks to that once the words come.
// `top` (beside the words): where the print starts, from the page's own --print-top
// (globals.css), which the headline's place is worked out from too.
export const PRINT_TOP = 140;
export function stageBox(W: number, H: number, wide: boolean, rows: number, fit = Infinity, top = PRINT_TOP): StageBox {
  const hx = wide ? Math.round(W * 0.38) : 0;
  // Above the print: the coach's finding (its figure in large type, its label) and the bracket
  // it hangs from.
  const hy = wide ? top : 88;
  // Beside the words the print is as tall as the screen allows: rows 2 to 4 px apart (200 games
  // at 3 px need 600 px, so a short laptop screen gets 2). Under the words (phones) always 2.
  const pitch0 = wide ? Math.max(2, Math.min(4, Math.floor((H - hy - 64) / rows))) : 2;
  const board = Math.round(wide ? Math.min(440, H * 0.52) : Math.min(W, H * 0.5, 420));
  const small = wide ? board : Math.round(Math.max(96, Math.min(board, fit)));
  return {
    wide,
    hx,
    hy,
    pitch0,
    rowH0: Math.max(1, pitch0 - 1),
    board,
    small,
    bx: wide ? Math.round(W * 0.05) : Math.round((W - board) / 2),
    by: wide ? Math.max(24, Math.round((H - board) / 2 - 28)) : 28,
  };
}
