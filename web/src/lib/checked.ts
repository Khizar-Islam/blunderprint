import type { CoachEvidence, CoachPattern, CoachStat } from "./api";
import { ANNOTATION, statText } from "./coach";

// "Checked", made visible: where each figure on a pattern card comes from.
//
// The backend's verifier (agent/verifier.ts) only lets a pattern's prose use digits that match
// one of a fixed list of fields: the group's own figures, its sample, and each cited position's
// move number, win chance lost and clock. This file finds, for a number in the prose, WHICH of
// those fields it is, with the verifier's own matching rule (a number matches a value it could
// be a rounding of). The page then underlines the figure and, on hover or focus, says the
// source in one line and outlines the position it belongs to.
//
// - Pure text → parts; no React here, so it is tested (checked.test.ts).
// - A number the page can't place stays plain text: the report doesn't carry everything the
//   verifier saw (the group's filter, the example search's match counts), and the page never
//   guesses a source.

// Where a figure comes from: `line` continues the sentence "<figure> …"; `evidence` is the
// cited position it belongs to (its board and lens row are outlined), if any.
export interface Source {
  line: string;
  evidence: number | null;
}

export type ProsePart = { kind: "text"; text: string } | { kind: "figure"; text: string; source: Source };

// ---- The verifier's rules, ported (backend agent/verifier.ts: proseNumbers, matchesValue) ----

const decimalsOf = (text: string) => (text.includes(".") ? text.split(".")[1]!.length : 0);

// "12" matches 12.04 (it is 12.04 rounded), "12.4" doesn't, "12.5" matches 12.46.
export function matchesValue(claimed: string, actual: number): boolean {
  return Math.abs(actual - Number(claimed)) <= 0.5 * 10 ** -decimalsOf(claimed) + 1e-9;
}

// Numbers written in digits, with their place in the text. Not a digit right after a letter
// (Nf3, e4, B06), not the 100 of "per 100 moves" (a unit), not castling written "0-0".
export function proseNumbers(text: string): { text: string; index: number }[] {
  const hide = (m: string) => m.replace(/\d/g, "x"); // same length, so the places stay right
  const masked = text.replace(/\bper[\s-]+100\b/gi, hide).replace(/(?<![\w-])0-0(?:-0)?(?![\w-])/g, hide);
  return [...masked.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g)].map((m) => ({ text: m[0], index: m.index }));
}

// The bounds in a bucket label: "under10" → 10, "from25to50" → 25 and 50.
const BUCKET_LABEL = /^(?:(?:under|over|from)\d+(?:to\d+)?|\d+-\d+|\d+\+)$/;
const labelNumbers = (label: string | null | undefined) => (label && BUCKET_LABEL.test(label) ? label.match(/\d+/g)!.map(Number) : []);

// ---- The sources ------------------------------------------------------------------------------

const ERRORS: Record<CoachStat["measure"], string> = {
  per100Moves: "errors",
  inaccuracyPer100: "inaccuracies",
  mistakePer100: "mistakes",
  blunderPer100: "blunders",
  errorsPerGame: "errors",
  scorePct: "points",
};
const count = (n: number) => n.toLocaleString("en-US");

// "47. Nd4??" / "24… Qa3?"
export const moveLabel = (e: CoachEvidence) => `${e.moveNumber}${e.color === "black" ? "…" : "."} ${e.played}${ANNOTATION[e.kind]}`;

// The pattern's big number and the player's usual one (StatLine).
export function statSources(stat: CoachStat): { value: Source; baseline: Source } {
  const games = `${count(stat.games)} game${stat.games === 1 ? "" : "s"}`;
  const value =
    stat.unit === "per100" && stat.errors != null && stat.moves != null
      ? `is this group's own rate: ${count(stat.errors)} ${ERRORS[stat.measure]} in ${count(stat.moves)} of your moves, over ${games}.`
      : stat.unit === "perGame" && stat.errors != null
        ? `is this group's own rate: ${count(stat.errors)} ${ERRORS[stat.measure]} in ${games}.`
        : `is this group's own figure, over ${games}.`;
  return {
    value: { line: value, evidence: null },
    baseline: { line: "is your own figure for the same thing, over all your analysed games.", evidence: null },
  };
}

type Role = "cost" | "stat" | "move" | "clock" | "bound";
interface Field {
  role: Role;
  value: number;
  source: Source;
}

function fieldsOf(pattern: Pick<CoachPattern, "title" | "stat" | "evidence">): Field[] {
  const { stat } = pattern;
  const t = statText(stat);
  const s = statSources(stat);
  const sample: Source = { line: `is the size of this group: ${t.sample}.`, evidence: null };
  const bound: Source = { line: "is a bound of this group, from its definition.", evidence: null };
  const out: Field[] = [];
  pattern.evidence.forEach((e, i) => {
    const label = moveLabel(e);
    out.push({ role: "cost", value: e.winPctLost, source: { line: `is what ${label} lost in win chance: the outlined position.`, evidence: i } });
    out.push({ role: "move", value: e.moveNumber, source: { line: `is the move number of ${label}: the outlined position.`, evidence: i } });
    if (e.facts.clockLeftSeconds != null)
      out.push({
        role: "clock",
        value: e.facts.clockLeftSeconds,
        source: { line: `is the clock when ${label} was played: ${e.facts.clockLeftSeconds} seconds left.`, evidence: i },
      });
  });
  out.push({ role: "stat", value: stat.value, source: s.value });
  out.push({ role: "stat", value: stat.baseline, source: s.baseline });
  out.push({
    role: "stat",
    value: stat.gapPct,
    source: { line: `is how far this group's ${t.value(stat.value)} is from your usual ${t.baseline}, in percent.`, evidence: null },
  });
  for (const n of [stat.games, stat.moves, stat.errors]) if (n != null) out.push({ role: "stat", value: n, source: sample });
  // Bounds: the clock buckets of the cited positions, and the numbers in the label code wrote.
  const bounds = new Set<number>([...pattern.evidence.flatMap((e) => labelNumbers(e.facts.clockBucket)), ...proseNumbers(pattern.title).map((n) => Number(n.text))]);
  for (const n of bounds) out.push({ role: "bound", value: n, source: bound });
  return out;
}

// Which kind of field the words around a number point to, most likely first.
function rolesFor(before: string, after: string): Role[] {
  if (/^\s*(?:win-chance|points?\b)/i.test(after)) return ["cost", "stat", "move", "clock", "bound"];
  if (/^\s*(?:%|percent)/i.test(after)) return ["bound", "stat", "cost", "move", "clock"];
  if (/^\s*seconds?\b/i.test(after)) return ["clock", "bound", "stat", "cost", "move"];
  if (/\bmoves?\s*$/i.test(before)) return ["move", "bound", "stat", "cost", "clock"];
  return ["cost", "stat", "move", "clock", "bound"];
}

// The prose, cut into plain text and placed figures.
export function checkedParts(text: string, pattern: Pick<CoachPattern, "title" | "stat" | "evidence">): ProsePart[] {
  const fields = fieldsOf(pattern);
  const parts: ProsePart[] = [];
  const seen = new Map<string, number>(); // how often a role + number has been placed already
  let at = 0;
  for (const n of proseNumbers(text)) {
    const roles = rolesFor(text.slice(0, n.index), text.slice(n.index + n.text.length));
    let hits: Field[] = [];
    let role: Role | null = null;
    for (const r of roles) {
      const all = fields.filter((f) => f.role === r && matchesValue(n.text, f.value));
      if (all.length === 0) continue;
      // A value written out exactly beats one the number could only be a rounding of.
      const exact = all.filter((f) => f.value === Number(n.text));
      hits = exact.length > 0 ? exact : all;
      role = r;
      break;
    }
    if (!role) continue; // nothing the page can point to: it stays plain text
    // Two cited moves with the same figure ("cost 10 … another 10"): the first mention is the
    // first position, the second the second.
    const key = `${role}:${n.text}`;
    const nth = seen.get(key) ?? 0;
    seen.set(key, nth + 1);
    const field = hits[nth % hits.length]!;
    if (n.index > at) parts.push({ kind: "text", text: text.slice(at, n.index) });
    parts.push({ kind: "figure", text: n.text, source: field.source });
    at = n.index + n.text.length;
  }
  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts;
}
