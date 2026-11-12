import type { ToolLog } from "./verifier.js";

// Number slots for "Ask the coach" answers (Stage 6 chunk B, CLAUDE.md §10).
//
// The model writes no numbers. A sentence says "you make {{a}} in the endgame" and the slot `a`
// points at a number in one of THIS run's tool results: { step: 3, path: "rows[2].per100Moves" }.
// Code looks the number up and writes it, with its unit, so the figure on screen is always the one
// a tool computed, rounded the same way every time. The model can't invent a figure, round one
// wrong, or put a raw 0.2374 into a sentence.
//
// Which fields may be shown, and how, is decided by the field's NAME (the last key of the path):
// each allowed name maps to a kind, and the kind decides the rounding and the unit text. A field
// that isn't in the table (a ply, a rank score, a step number) can't be a slot at all.

export type SlotKind = "percent" | "share" | "per100" | "perGame" | "count" | "moveNumber" | "seconds" | "winPoints" | "rating";

export const SLOT_KINDS: readonly SlotKind[] = ["percent", "share", "per100", "perGame", "count", "moveNumber", "seconds", "winPoints", "rating"];

// Field name → kind. Field names are the tools' own (agent/tools/*.ts).
const KIND_BY_KEY: Record<string, SlotKind> = {
  // Percentages 0-100 (tools/format.ts pct).
  scorePct: "percent",
  accuracyPct: "percent",
  gapPct: "percent",
  // Shares of the player's errors, with what they're a share of: "88% of your blunders".
  shareOfErrorsPct: "share",
  blunderSharePct: "share",
  mistakeSharePct: "share",
  inaccuracySharePct: "share",
  // Errors per 100 of the player's moves.
  per100Moves: "per100",
  errorsPer100Moves: "per100",
  inaccuracyPer100: "per100",
  mistakePer100: "per100",
  blunderPer100: "per100",
  // Errors per analysed game.
  perGame: "perGame",
  errorsPerGame: "perGame",
  // Plain counts.
  games: "count",
  analysedGames: "count",
  moves: "count",
  playerMoves: "count",
  errors: "count",
  totalErrors: "count",
  matchingErrors: "count",
  matchingGames: "count",
  inaccuracy: "count",
  mistake: "count",
  blunder: "count",
  total: "count",
  win: "count",
  draw: "count",
  loss: "count",
  squaresWithErrors: "count",
  qualifying: "count",
  ecoCodes: "count",
  // One position.
  moveNumber: "moveNumber",
  clockLeftSeconds: "seconds",
  winPctLost: "winPoints",
  // Ratings.
  playerRating: "rating",
  opponentRating: "rating",
};

// Parents whose every numeric child has one kind: accuracyPct.white, currentRatings.blitz.
const KIND_BY_PARENT: Record<string, SlotKind> = {
  accuracyPct: "percent",
  currentRatings: "rating",
};

// A candidate's value and baseline (get_weakness_candidates) are in the unit its `unit` names.
const KIND_BY_UNIT: Record<string, SlotKind> = { per100: "per100", perGame: "perGame", percent: "percent" };

// What a rate, a share or a kind count counts, written by code into the unit ("6.8 blunders per
// 100 moves", "88% of your blunders", "9 blunders"), so the sentence can't call an all-errors
// figure a blunder figure. By field name, and for a candidate's value/baseline by its `measure`.
// Other counts (games, moves, matchingErrors…) stay bare: the model writes their noun.
export type RateNoun = "errors" | "blunders" | "mistakes" | "inaccuracies";
const NOUN_BY_KEY: Record<string, RateNoun> = {
  per100Moves: "errors",
  errorsPer100Moves: "errors",
  inaccuracyPer100: "inaccuracies",
  mistakePer100: "mistakes",
  blunderPer100: "blunders",
  perGame: "errors",
  errorsPerGame: "errors",
  shareOfErrorsPct: "errors",
  blunderSharePct: "blunders",
  mistakeSharePct: "mistakes",
  inaccuracySharePct: "inaccuracies",
  blunder: "blunders",
  mistake: "mistakes",
  inaccuracy: "inaccuracies",
};
const SINGULAR: Record<RateNoun, string> = { errors: "error", blunders: "blunder", mistakes: "mistake", inaccuracies: "inaccuracy" };

export type PathPart = string | number;

const PATH = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*|\[\d{1,3}\])*$/;
const MAX_PATH = 120;
const MAX_DEPTH = 8;

// "rows[2].per100Moves" → ["rows", 2, "per100Moves"]; null if it isn't that shape.
export function parsePath(path: string): PathPart[] | null {
  if (typeof path !== "string" || path.length > MAX_PATH || !PATH.test(path)) return null;
  const parts: PathPart[] = [];
  for (const m of path.matchAll(/([A-Za-z][A-Za-z0-9]*)|\[(\d+)\]/g)) parts.push(m[1] !== undefined ? m[1] : Number(m[2]));
  return parts.length <= MAX_DEPTH ? parts : null;
}

export type Resolved =
  | { ok: true; value: number; kind: SlotKind; key: string; noun?: RateNoun }
  | { ok: false; problem: string };

// Follows the path through a tool result, own properties only (never "constructor" or
// "__proto__"), to a finite number whose field may be shown.
export function resolvePath(data: unknown, path: string): Resolved {
  const parts = parsePath(path);
  if (!parts) return { ok: false, problem: `path "${path.slice(0, 60)}" isn't a field path like rows[2].per100Moves` };
  let node: unknown = data;
  let parent: unknown = undefined;
  let parentKey: string | undefined;
  let lastKey: string | undefined;
  for (const part of parts) {
    parent = node;
    if (typeof part === "number") {
      if (!Array.isArray(node) || part >= node.length) return { ok: false, problem: `path "${path}" doesn't exist in that result` };
      node = node[part];
    } else {
      if (!node || typeof node !== "object" || Array.isArray(node) || !Object.hasOwn(node, part)) {
        return { ok: false, problem: `path "${path}" doesn't exist in that result` };
      }
      parentKey = lastKey;
      lastKey = part;
      node = (node as Record<string, unknown>)[part];
    }
  }
  if (node === null) return { ok: false, problem: `path "${path}" has no value in that result` };
  // The model's habit: a move as a slot ("you played {{d}}", d = examples[0].played).
  if (typeof node === "string" && (lastKey === "played" || lastKey === "betterMove")) {
    return { ok: false, problem: `path "${path}" is a move (${node.slice(0, 10)}), not a number: write the move itself in the sentence and cite its position as evidence` };
  }
  if (typeof node !== "number" || !Number.isFinite(node)) return { ok: false, problem: `path "${path}" isn't a number` };
  if (typeof parts.at(-1) !== "string") return { ok: false, problem: `path "${path}" must end at a named field` };

  const key = lastKey!;
  let kind: SlotKind | undefined;
  let noun: RateNoun | undefined;
  if ((key === "value" || key === "baseline") && parent && typeof parent === "object") {
    const p = parent as Record<string, unknown>;
    kind = KIND_BY_UNIT[String(p.unit)];
    noun = NOUN_BY_KEY[String(p.measure)];
  } else {
    kind = KIND_BY_KEY[key] ?? (parentKey ? KIND_BY_PARENT[parentKey] : undefined);
    noun = NOUN_BY_KEY[key];
  }
  if (!kind) return { ok: false, problem: `the field "${key}" can't be shown in an answer` };
  // A rate always says what it counts; one without a known noun (never expected) isn't shown.
  if ((kind === "per100" || kind === "perGame" || kind === "share") && !noun) return { ok: false, problem: `the field "${key}" can't be shown in an answer` };
  return { ok: true, value: node, kind, key, ...(noun ? { noun } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Formatting: the kind decides the rounding and the unit. Never more than 2 decimals, never a
// 0-1 ratio (the tools give percentages as 0-100).

const trimZeros = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);
const fixed = (n: number, decimals: number) => trimZeros(n.toFixed(decimals));
const int = (n: number) => Math.round(n);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// "1 blunder", "6.8 blunders".
const counted = (n: string, noun: RateNoun) => `${n} ${n === "1" ? SINGULAR[noun] : noun}`;

export function formatSlot(value: number, kind: SlotKind, noun?: RateNoun): string {
  switch (kind) {
    case "percent":
      return `${fixed(value, 1)}%`;
    case "share":
      return `${fixed(value, 1)}% of your ${noun ?? "errors"}`;
    case "per100":
      return `${counted(fixed(value, 1), noun ?? "errors")} per 100 moves`;
    case "perGame":
      return `${counted(fixed(value, 2), noun ?? "errors")} per game`;
    case "count": {
      // Only the kind counts carry a noun ("9 blunders"); other counts are bare.
      const n = int(value).toLocaleString("en-US");
      return noun ? counted(n, noun) : n;
    }
    case "moveNumber":
      return `move ${int(value)}`;
    case "seconds": {
      const total = Math.max(0, int(value));
      if (total < 60) return plural(total, "second", "seconds");
      const m = Math.floor(total / 60);
      const s = total % 60;
      return s === 0 ? plural(m, "minute", "minutes") : `${plural(m, "minute", "minutes")} ${plural(s, "second", "seconds")}`;
    }
    case "winPoints":
      return `${fixed(value, 1)} win-chance points`;
    case "rating":
      return String(int(value));
  }
}

// What each kind looks like, for the system prompt (so the model writes "a rate of {{a}}", not
// "{{a}} per 100 moves per 100 moves").
export const SLOT_KIND_EXAMPLES: Record<SlotKind, string> = {
  percent: `"54.2%"`,
  share: `"88% of your blunders", "96.4% of your errors"`,
  per100: `"7.9 errors per 100 moves", "6.8 blunders per 100 moves"`,
  perGame: `"1.25 errors per game"`,
  count: `"37" (no unit: write the noun yourself, "{{a}} games")`,
  moveNumber: `"move 23"`,
  seconds: `"12 seconds", "1 minute 5 seconds"`,
  winPoints: `"18.4 win-chance points"`,
  rating: `"1850"`,
};

export interface FilledSlot {
  text: string;
  kind: SlotKind;
  value: number;
  // Where it came from (logs and the stored answer only; the page gets text and kind).
  step: number;
  path: string;
}

// A slot as the model wrote it.
export interface SlotRef {
  name: string;
  step: number;
  path: string;
}

// Resolves one slot against this run's tool log.
export function fillSlot(slot: SlotRef, log: ToolLog): { ok: true; slot: FilledSlot } | { ok: false; problem: string } {
  const entry = log.get(slot.step);
  if (!entry) return { ok: false, problem: `slot {{${slot.name}}}: step ${slot.step} doesn't exist` };
  if (!entry.ok) return { ok: false, problem: `slot {{${slot.name}}}: step ${slot.step} was a failed ${entry.tool} call` };
  const r = resolvePath(entry.data, slot.path);
  if (!r.ok) return { ok: false, problem: `slot {{${slot.name}}} (step ${slot.step}): ${r.problem}` };
  return { ok: true, slot: { text: formatSlot(r.value, r.kind, r.noun), kind: r.kind, value: r.value, step: slot.step, path: slot.path } };
}

// The placeholders in a sentence: "{{a}} and {{b2}}" → ["a", "b2"].
export const SLOT_NAME = /^[a-z][a-z0-9]{0,7}$/;
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]!);
}

// A sentence with every placeholder replaced by its slot's text.
export function fillSentence(template: string, slots: Map<string, FilledSlot>): string {
  return template.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (_, name: string) => slots.get(name)?.text ?? "");
}

// A unit the model repeated after a slot that already carries it: "{{a}} blunders" where a is
// "9 blunders", "{{b}} of your blunders" where b is "3.6% of your blunders", "{{c}} errors per 100
// moves" where c is "6.2 errors per 100 moves". The slot's unit tail is its text after the number
// ("errors per 100 moves", "% of your blunders", "errors per game", "win-chance points",
// "seconds"); for a text that doesn't start with a number ("move 23") it's the trailing words.
// Removed, case-insensitively and singular or plural alike:
//  - the words right after the placeholder when they repeat the END of the unit tail (the whole
//    tail or its last words: "{{c}} per 100 moves", "{{b}} of your blunders"); the longest wins;
//  - or the bare noun, the tail's first token, on its own ("{{c}} errors in the endgame", "{{p}}%").
// Words that don't repeat the slot ("{{a}} lose no piece", "{{b}} of your errors") are left
// alone. Cosmetic and certain, so it isn't a verifier issue: ask.ts applies it to the answer and
// logs each one in `removed`.
const WORD = /^[\p{L}][\p{L}'’-]*$/u;
const LEADING_NUMBER = /^-?\d[\d,]*(?:\.\d+)?/;
// One token after a placeholder: a "%" (attached or not), a word or a number.
const FOLLOWING_TOKEN = /\s*(%)|\s+([\p{L}][\p{L}'’-]*|\d+(?:[.,]\d+)*)/uy;
const SINGULAR_WORD: Record<string, string> = { ...SINGULAR, moves: "move", games: "game", seconds: "second", minutes: "minute", points: "point" };
const wordKey = (w: string) => {
  const lower = w.toLowerCase();
  return SINGULAR_WORD[lower] ?? lower;
};
const trailingWords = (text: string) => {
  const tokens = text.split(/\s+/);
  let i = tokens.length;
  while (i > 0 && WORD.test(tokens[i - 1]!)) i--;
  return tokens.slice(i);
};
// "6.2 errors per 100 moves" → ["errors", "per", "100", "moves"]; "3.6% of your blunders" →
// ["%", "of", "your", "blunders"]; "54.2%" → ["%"]; "37" → []; "move 23" → [].
export function unitTail(text: string): string[] {
  const n = LEADING_NUMBER.exec(text);
  if (!n) return trailingWords(text);
  return text
    .slice(n[0].length)
    .replace(/^%/, "% ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

// The words a slot's text starts with, before its number: "move 23" → ["move"]; "6.2 errors…" → [].
const leadingWords = (text: string) => {
  const tokens = text.split(/\s+/);
  const i = tokens.findIndex((t) => !WORD.test(t));
  return i <= 0 ? [] : tokens.slice(0, i);
};
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function dropDoubledNouns(template: string, slots: Map<string, FilledSlot>): { template: string; dropped: string[] } {
  const dropped: string[] = [];
  let out = "";
  let last = 0;
  for (const m of template.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
    const end = m.index! + m[0].length;
    const slot = slots.get(m[1]!);
    let before = template.slice(last, m.index);
    // A word repeated BEFORE a slot that starts with it: "on move {{e}}", e = "move 59".
    const lead = slot ? leadingWords(slot.text) : [];
    if (lead.length > 0) {
      const re = new RegExp(`(^|[^\\p{L}])${lead.map((w) => `${escapeRe(w)}s?`).join("\\s+")}\\s+$`, "iu");
      const hit = re.exec(before);
      if (hit) {
        before = before.slice(0, hit.index + hit[1]!.length);
        dropped.push(`doubled noun before {{${m[1]}}}`);
      }
    }
    out += before + m[0];
    last = end;
    if (!slot) continue;
    const tail = unitTail(slot.text);
    if (tail.length === 0) continue;
    const following: { token: string; end: number }[] = [];
    FOLLOWING_TOKEN.lastIndex = end;
    for (let t = FOLLOWING_TOKEN.exec(template); t && following.length < tail.length; t = FOLLOWING_TOKEN.exec(template)) {
      following.push({ token: t[1] ?? t[2]!, end: FOLLOWING_TOKEN.lastIndex });
    }
    const same = (a: string, b: string) => wordKey(a) === wordKey(b);
    let drop = 0;
    for (let k = following.length; k >= 1 && drop === 0; k--) {
      if (following.slice(0, k).every((f, i) => same(f.token, tail[tail.length - k + i]!))) drop = k;
    }
    if (drop === 0 && following.length > 0 && same(following[0]!.token, tail[0]!)) drop = 1;
    if (drop > 0) {
      last = following[drop - 1]!.end;
      dropped.push(`doubled noun after {{${m[1]}}}`);
    }
  }
  return { template: out + template.slice(last), dropped };
}
