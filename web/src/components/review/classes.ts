import type { MoveClass } from "@/lib/api";

// Shared by the review components: the annotation glyph and colours for each classification.

export const GLYPH: Partial<Record<MoveClass, string>> = { inaccuracy: "?!", mistake: "?", blunder: "??" };

export const LABEL: Record<MoveClass, string> = {
  best: "the engine's choice",
  good: "a good move",
  inaccuracy: "an inaccuracy",
  mistake: "a mistake",
  blunder: "a blunder",
};

export const isError = (c: MoveClass | undefined): c is "inaccuracy" | "mistake" | "blunder" =>
  c === "inaccuracy" || c === "mistake" || c === "blunder";

// Tailwind classes for a classification's WORDS (a move's name, its glyph, "blunder"): the darker
// text-only tones from globals.css, readable on bone (WCAG AA). Amber can't be darkened that far
// and still read as amber, so an inaccuracy is ink behind an amber tick. For text on bone or
// a stone tint only, never on ink.
export const TEXT: Partial<Record<MoveClass, string>> = {
  inaccuracy: "text-ink tick-inaccuracy",
  mistake: "text-mistake-text",
  blunder: "text-blunder-text",
};
export const BEST_TEXT = "text-best-text";

// Hex values for places CSS variables can't reach (SVG attributes in react-chessboard's arrows).
// Keep in sync with globals.css.
export const HEX = {
  best: "#3e7c74",
  inaccuracy: "#d4a72c",
  mistake: "#d9772b",
  blunder: "#b3362b",
} as const;
