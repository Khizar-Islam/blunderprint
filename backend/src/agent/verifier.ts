import { Types } from "mongoose";
import { FEATURES_VERSION } from "../chess/features.js";
import { Game } from "../db/models/game.js";
import type { AgentContext } from "./context.js";
import type { DraftReport } from "./schema.js";
import { isWithin, type Candidate, type Direction, type ExampleFilter, type Measure } from "./tools/candidates.js";
import { moveNumberOf, round1, uciToSan } from "./tools/format.js";

// The verifier (CLAUDE.md §10): plain code, no AI. Code also FINDS the weaknesses
// (get_weakness_candidates); the model chooses among them and explains. A pattern only reaches
// the player if
//   1. it cites a candidate that really came back from get_weakness_candidates in this run.
//      Its statistic, baseline, direction and label are copied from that candidate: the model
//      never writes a number or a label, so it can't mislabel one;
//   2. it is DISTINCT: no two patterns where one candidate is the same group as the other or a
//      part of it ("endgame" and "endgame with under 10% of the clock left");
//   3. its evidence is real AND matches the candidate: it comes from a find_example_mistakes
//      result (evidenceStep) whose filters are the candidate's exampleFilter (or narrower);
//      every {gameId, ply} is one of that result's examples and this player's judged move; no
//      position is evidence for two patterns; and it spans at least 2 different games;
//   4. its explanation and drill use no unbacked numbers: a number in digits must be one of the
//      candidate's figures, its examples' match counts, or the move number, win % lost or clock
//      left of one of its evidence items (allowedProseNumbers); a number written as a word
//      ("ten", "twice", "half") is never allowed.
// Each verified evidence item carries its situation (speed, phase, clock, opening) from the
// examples result, so the page shows those facts from code, not from the model's text.
// The model is told exactly what failed (prompts.ts repairPrompt) and gets one repair round.
// After that: bad evidence items and sentences with unbacked numbers are removed ("trimmed");
// a pattern with an unknown or overlapping candidate, or fewer than 2 games of evidence left,
// is dropped.

export interface VerificationIssue {
  pattern: number; // index in the report
  title: string;
  problem: string;
}

// What every tool call in the run returned, by step number (1, 2, …). Failed calls are kept
// as errors so a citation of one can be told why it doesn't count.
export type ToolLog = Map<number, { ok: true; tool: string; data: unknown } | { ok: false; tool: string }>;

export interface VerifiedEvidence {
  gameId: string;
  ply: number;
  moveNumber: number;
  kind: string;
  played: string;
  betterMove: string | null;
  winPctLost: number;
  fen: string; // the position before the move (normalized FEN)
  // The situation, from the examples result (computed by code, not written by the model), so the
  // coach page can show it next to each position.
  facts: EvidenceFacts;
}

export interface EvidenceFacts {
  speed: string | null;
  phase: string | null;
  clockBucket: string | null; // null = the game had no clocks
  clockLeftSeconds: number | null;
  opening: { eco: string; name: string | null } | null;
}

// One example as find_example_mistakes returns it (tools/examples.ts).
interface ExampleRow {
  gameId: string;
  ply: number;
  moveNumber?: number;
  speed?: string;
  phase?: string;
  clockBucket?: string | null;
  clockLeftSeconds?: number | null;
  winPctLost?: number;
  opening?: { eco: string; name: string | null } | null;
}

const factsOf = (e: ExampleRow | undefined): EvidenceFacts => ({
  speed: e?.speed ?? null,
  phase: e?.phase ?? null,
  clockBucket: e?.clockBucket ?? null,
  clockLeftSeconds: e?.clockLeftSeconds ?? null,
  opening: e?.opening ? { eco: e.opening.eco, name: e.opening.name ?? null } : null,
});

export interface VerifiedPattern {
  candidateId: string;
  title: string; // the candidate's label, written by code
  explanation: string;
  drill: string;
  // "4.6 vs your 3.1": all copied from the candidate.
  stat: {
    measure: Measure;
    value: number;
    unit: Candidate["unit"];
    baseline: number;
    direction: Direction;
    gapPct: number;
    games: number;
    moves?: number;
    errors?: number;
  };
  evidence: VerifiedEvidence[];
}

export interface DroppedPattern {
  title: string;
  reasons: string[];
}

const MIN_GAMES = 2;
const JUDGEMENTS = new Set(["inaccuracy", "mistake", "blunder"]);
const EXAMPLES_TOOL = "find_example_mistakes";
const CANDIDATES_TOOL = "get_weakness_candidates";

// ---------------------------------------------------------------------------------------------
// Numbers

// Every number in a tool result, at any depth. Numbers inside strings don't count: "a 12-move
// game" isn't a statistic.
export function numbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (Array.isArray(value)) for (const v of value) numbersIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) numbersIn(v, out);
  return out;
}

// How many decimals the model wrote: 12 → 0, 12.5 → 1, 0.25 → 2.
const decimalsOf = (n: number) => {
  const s = String(n);
  if (s.includes("e")) return 0;
  return s.includes(".") ? s.split(".")[1]!.length : 0;
};

// Does the model's number match a number from the data, allowing for the model rounding it?
// The tolerance is half a unit of the last digit the model wrote: "12" matches 12.04 (it's
// 12 rounded), "12.4" doesn't match 12.04, "12.5" matches 12.46. This only forgives the model
// for dropping digits, never for changing them.
export function matchesValue(claimed: number, actual: number): boolean {
  const tolerance = 0.5 * 10 ** -decimalsOf(claimed) + 1e-9;
  return Math.abs(actual - claimed) <= tolerance;
}

// Numbers written in digits in prose: "16.2", "70%" (70), "moves 21-30" (21 and 30), "5 games".
// Not the digits of a square or a move in notation: a digit right after a letter ("Nf3", "e4",
// "Qxf7", "B06") isn't a number.
// "per 100 moves" names the unit of a per100 rate; it isn't a figure, so it's skipped.
export function proseNumbers(text: string): number[] {
  const withoutUnit = text.replace(/\bper[\s-]+100\b/gi, "per hundred");
  return [...withoutUnit.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
}

// Number words in prose: "ten percent", "twice as many", "half your games". The prompt forbids
// them, and a word can't be checked against the data, so each one counts like an unbacked
// number. Two chess terms that only look like numbers are left alone: a double attack or
// double check, and a half-open file.
const NUMBER_WORDS =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundreds?|thousands?|twice|half|double|triple)\b/gi;
const CHESS_TERMS = /\bdouble[\s-]+(?:attacks?|checks?)\b|\bhalf[\s-]+open\b/gi;
export function numberWordsIn(text: string): string[] {
  return [...text.replace(CHESS_TERMS, " ").matchAll(NUMBER_WORDS)].map((m) => m[0].toLowerCase());
}

// The numbers inside bucket labels: "under10" → 10, "from25to50" → 25, 50, "21-30" → 21, 30,
// "41+" → 41. So "under 10% of your clock" or "moves 21-30" is backed by the bucket it
// describes. Only label-shaped strings count; other text (names) never does.
const BUCKET_LABEL = /^(?:(?:under|over|from)\d+(?:to\d+)?|\d+-\d+|\d+\+)$/;
export function labelNumbersIn(value: unknown, out: number[] = []): number[] {
  if (typeof value === "string" && BUCKET_LABEL.test(value)) for (const d of value.match(/\d+/g)!) out.push(Number(d));
  else if (Array.isArray(value)) for (const v of value) labelNumbersIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) labelNumbersIn(v, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Candidates: every candidate any get_weakness_candidates call in this run returned, by id.
// Their numbers were computed by code (tools/candidates.ts), so they're trusted as they are.

export function candidatesIn(log: ToolLog): Map<string, Candidate> {
  const out = new Map<string, Candidate>();
  for (const entry of log.values()) {
    if (!entry.ok || entry.tool !== CANDIDATES_TOOL) continue;
    for (const c of (entry.data as { candidates?: Candidate[] }).candidates ?? []) out.set(c.id, c);
  }
  return out;
}

// {phase: endgame, kind: blunder}
export const showFilter = (f: Record<string, unknown>) =>
  `{${Object.entries(f)
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(", ")}}`;

// Does a find_example_mistakes result's filter select the candidate's group: every condition
// of the candidate's exampleFilter, possibly more (narrower is fine, broader or different isn't).
export const filtersCover = (stepFilters: Record<string, unknown>, exampleFilter: ExampleFilter) =>
  Object.entries(exampleFilter).every(([k, v]) => stepFilters[k] === v);

// ---------------------------------------------------------------------------------------------
// Evidence step: the find_example_mistakes result the pattern's evidence must come from.

export interface ExamplesStep {
  keys: Set<string>;
  examples: Map<string, ExampleRow>; // by gameId:ply
  filters: Record<string, unknown>;
  matchingErrors?: number;
  matchingGames?: number;
}

export function examplesIn(log: ToolLog, step: number): ExamplesStep | { problem: string } {
  const entry = log.get(step);
  if (!entry) return { problem: `evidenceStep ${step} doesn't exist` };
  if (!entry.ok) return { problem: `evidenceStep ${step} was a failed ${entry.tool} call` };
  if (entry.tool !== EXAMPLES_TOOL) return { problem: `evidenceStep ${step} is a ${entry.tool} result, not ${EXAMPLES_TOOL}` };
  const data = entry.data as { filters?: Record<string, unknown>; matchingErrors?: number; matchingGames?: number; examples?: ExampleRow[] };
  const examples = new Map((data.examples ?? []).map((e) => [`${e.gameId}:${e.ply}`, e]));
  return { keys: new Set(examples.keys()), examples, filters: data.filters ?? {}, matchingErrors: data.matchingErrors, matchingGames: data.matchingGames };
}

// ---------------------------------------------------------------------------------------------
// Prose: every number must be backed by the pattern's own candidate or evidence.

export interface ProseProblem {
  field: "explanation" | "drill";
  value?: number; // a number in digits that isn't backed
  word?: string; // a number written as a word
}

// The numbers a pattern's prose may use, field by field (never "any number anywhere in a
// result": that let "5 seconds per move" through because some unrelated 5 was in the examples):
//   - the candidate's own figures: value, baseline, gapPct, games, moves, errors;
//   - the examples result's match counts: matchingErrors, matchingGames;
//   - for each of the pattern's own evidence items: its move number, win % lost and clock left
//     (seconds);
//   - the bounds in bucket labels of the candidate's filter and the evidence step's filter and
//     examples ("under10" → 10, "21-30" → 21, 30).
export function allowedProseNumbers(
  candidate: Candidate | undefined,
  step: Pick<ExamplesStep, "filters" | "matchingErrors" | "matchingGames"> | undefined,
  evidence: { moveNumber: number; winPctLost: number; facts: Pick<EvidenceFacts, "clockLeftSeconds" | "clockBucket"> }[],
): number[] {
  const nums = [
    ...(candidate ? [candidate.value, candidate.baseline, candidate.gapPct, candidate.games, candidate.moves, candidate.errors] : []),
    step?.matchingErrors,
    step?.matchingGames,
    ...evidence.flatMap((e) => [e.moveNumber, e.winPctLost, e.facts.clockLeftSeconds]),
  ];
  const labels = [candidate?.exampleFilter, step?.filters, evidence.map((e) => e.facts.clockBucket)].flatMap((v) => labelNumbersIn(v));
  return [...nums.filter((n): n is number => typeof n === "number" && Number.isFinite(n)), ...labels];
}

export function checkProse(p: { explanation: string; drill: string }, allowed: number[]): ProseProblem[] {
  const problems: ProseProblem[] = [];
  for (const field of ["explanation", "drill"] as const) {
    for (const value of proseNumbers(p[field])) {
      if (!allowed.some((a) => matchesValue(value, a))) problems.push({ field, value });
    }
    for (const word of numberWordsIn(p[field])) problems.push({ field, word });
  }
  return problems;
}

// The text without the sentences that contain an unbacked number or a number word.
export function withoutUnbackedSentences(text: string, allowed: number[]): string {
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => proseNumbers(sentence).every((n) => allowed.some((a) => matchesValue(n, a))) && numberWordsIn(sentence).length === 0)
    .join(" ")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Evidence in the database (a final safety net: examples come from the database already)

type MistakeDoc = { ply: number; kind: string; san: string; best?: string; fen: string; winDrop: number };
type GameMistakes = Map<string, Map<number, MistakeDoc>>;

// The player's analysed games among the cited ids, with their mistakes by ply: one query for
// the whole report. Another player's game simply isn't found.
async function loadMistakes(ctx: AgentContext, gameIds: string[]): Promise<GameMistakes> {
  const ids = [...new Set(gameIds)].filter((id) => Types.ObjectId.isValid(id) && /^[0-9a-f]{24}$/i.test(id));
  const games = await Game.find(
    { _id: { $in: ids }, playerId: ctx.playerId, "features.version": FEATURES_VERSION, "features.error": { $exists: false } },
    { "features.mistakes": 1 },
  ).lean<{ _id: Types.ObjectId; features?: { mistakes?: MistakeDoc[] } }[]>();
  return new Map(games.map((g) => [String(g._id), new Map((g.features?.mistakes ?? []).map((m) => [m.ply, m]))]));
}

// ---------------------------------------------------------------------------------------------
// The whole report

export interface Verification {
  issues: VerificationIssue[];
  // Patterns that passed (with final=true: after trimming).
  passed: VerifiedPattern[];
  // final=true only: patterns removed, and why.
  dropped: DroppedPattern[];
  // final=true only: patterns kept after evidence items or sentences were removed, and why.
  trimmed: DroppedPattern[];
}

// final = false: report every problem (for the repair round); nothing is removed yet.
// final = true: the last word. Bad evidence items and unbacked sentences are removed; a pattern
// is dropped if its candidate is unknown or overlaps an earlier pattern's, fewer than 2 games of
// evidence remain, or trimming empties its explanation or drill.
export async function verifyReport(ctx: AgentContext, report: DraftReport, log: ToolLog, { final }: { final: boolean }): Promise<Verification> {
  const games = await loadMistakes(ctx, report.patterns.flatMap((p) => p.evidence.map((e) => e.gameId)));
  const candidates = candidatesIn(log);
  const issues: VerificationIssue[] = [];
  const passed: VerifiedPattern[] = [];
  const dropped: DroppedPattern[] = [];
  const trimmed: DroppedPattern[] = [];
  // Evidence already used by an earlier pattern: position → pattern number (1-based).
  const used = new Map<string, number>();
  // Candidates of earlier patterns, for the distinctness check.
  const taken: { pattern: number; candidate: Candidate }[] = [];

  report.patterns.forEach((p, index) => {
    const problems: string[] = [];
    const candidate = candidates.get(p.candidateId);
    const title = candidate?.label ?? p.candidateId;

    // The candidate: real, and not the same group as (or part of) an earlier pattern's.
    // Either failure drops the pattern after the repair round.
    let fatal = false;
    if (!candidate) {
      problems.push(`candidateId "${p.candidateId}" isn't one of the get_weakness_candidates results; copy an id exactly`);
      fatal = true;
    } else {
      const overlap = taken.find((t) => isWithin(candidate.exampleFilter, t.candidate.exampleFilter) || isWithin(t.candidate.exampleFilter, candidate.exampleFilter));
      if (overlap) {
        problems.push(
          `candidate "${candidate.id}" overlaps pattern ${overlap.pattern}'s candidate "${overlap.candidate.id}" (one is the same group as the other or part of it): keep only one of them`,
        );
        fatal = true;
      }
    }

    // Evidence: from a result with the candidate's filters, one of its examples, not reused, real.
    let step = examplesIn(log, p.evidenceStep);
    if (!("problem" in step) && candidate && !filtersCover(step.filters, candidate.exampleFilter)) {
      step = {
        problem: `evidenceStep ${p.evidenceStep}'s filters ${showFilter(step.filters)} don't match candidate "${candidate.id}": call find_example_mistakes with its exampleFilter ${showFilter(candidate.exampleFilter)}`,
      };
    }
    if ("problem" in step) problems.push(step.problem);
    const valid: VerifiedEvidence[] = [];
    const seen = new Set<string>();
    for (const e of p.evidence) {
      const key = `${e.gameId}:${e.ply}`;
      if (seen.has(key)) continue; // a repeat inside one pattern is ignored, not a fabrication
      seen.add(key);
      if ("problem" in step) continue; // already reported once for the whole pattern
      if (!step.keys.has(key)) {
        problems.push(`evidence ${e.gameId} ply ${e.ply} isn't one of step ${p.evidenceStep}'s examples`);
        continue;
      }
      const earlier = used.get(key);
      if (earlier !== undefined) {
        problems.push(`evidence ${e.gameId} ply ${e.ply} is already evidence for pattern ${earlier}`);
        continue;
      }
      const m = games.get(e.gameId)?.get(e.ply);
      if (!m || !JUDGEMENTS.has(m.kind)) {
        problems.push(`evidence ${e.gameId} ply ${e.ply} isn't one of this player's inaccuracies, mistakes or blunders`);
        continue;
      }
      valid.push({
        gameId: e.gameId,
        ply: e.ply,
        moveNumber: moveNumberOf(e.ply),
        kind: m.kind,
        played: m.san,
        betterMove: uciToSan(m.fen, m.best),
        winPctLost: round1(m.winDrop),
        fen: m.fen,
        facts: factsOf(step.examples.get(key)),
      });
    }
    const distinctGames = new Set(valid.map((v) => v.gameId)).size;
    const enough = distinctGames >= MIN_GAMES;
    if (!enough) {
      problems.push(`the valid evidence comes from ${distinctGames} game${distinctGames === 1 ? "" : "s"}; a recurring pattern needs at least ${MIN_GAMES}`);
    }

    // Numbers in the prose.
    const allowed = allowedProseNumbers(candidate, "problem" in step ? undefined : step, valid);
    for (const { field, value, word } of checkProse(p, allowed)) {
      problems.push(
        word !== undefined
          ? `the ${field} spells out a number ("${word}"); numbers must be in digits and come from the candidate or its examples`
          : `the ${field} mentions ${value}, which isn't one of the candidate's figures, step ${p.evidenceStep}'s match counts, or a move number, win % lost or clock time of this pattern's evidence`,
      );
    }

    for (const problem of problems) issues.push({ pattern: index, title, problem });
    const verified: VerifiedPattern | null = candidate
      ? {
          candidateId: candidate.id,
          title: candidate.label,
          explanation: p.explanation,
          drill: p.drill,
          stat: {
            measure: candidate.measure,
            value: candidate.value,
            unit: candidate.unit,
            baseline: candidate.baseline,
            direction: candidate.direction,
            gapPct: candidate.gapPct,
            games: candidate.games,
            ...(candidate.moves !== undefined ? { moves: candidate.moves } : {}),
            ...(candidate.errors !== undefined ? { errors: candidate.errors } : {}),
          },
          evidence: valid.slice(0, 4),
        }
      : null;
    // Marks this pattern's positions and candidate as taken, for the patterns after it.
    const claim = () => {
      for (const v of verified?.evidence ?? []) used.set(`${v.gameId}:${v.ply}`, index + 1);
      if (candidate && !fatal) taken.push({ pattern: index + 1, candidate });
    };

    if (problems.length === 0) {
      passed.push(verified!);
      claim();
    } else if (!final) {
      claim(); // so the repair round also hears about repeats in later patterns
    } else if (fatal || !enough || !verified) {
      dropped.push({ title, reasons: problems });
    } else {
      verified.explanation = withoutUnbackedSentences(p.explanation, allowed);
      verified.drill = withoutUnbackedSentences(p.drill, allowed);
      if (!verified.explanation || !verified.drill) {
        dropped.push({ title, reasons: [...problems, "nothing left of the text after removing unbacked numbers"] });
      } else {
        passed.push(verified);
        trimmed.push({ title, reasons: problems });
        claim();
      }
    }
  });

  return { issues, passed, dropped, trimmed };
}
