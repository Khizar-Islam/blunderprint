import type { Types } from "mongoose";
import { moverOfPly } from "../../chess/classify.js";
import { clockBucket, initialSeconds } from "../../chess/features.js";
import { phaseOfPly, type Division } from "../../chess/phase.js";
import { Game, type Color, type Speed } from "../../db/models/game.js";
import { HAS_FEATURES, MOVE_BUCKETS } from "../../stats/summary.js";
import { rulesOf, type AgentContext, type WeaknessRules } from "../context.js";
import { cleanOpeningName, pct, strictArgs } from "./format.js";

// get_weakness_candidates: CODE finds the weaknesses, the model only explains and chooses.
//
// The first real runs showed why. Left to hunt with the breakdown tools, the model explored
// a few groups, missed others that qualified, and once labelled an all-phase number "endgame".
// So this tool scans every group the coach can report on, the same way every time:
//
//   groups:   phase, clock bucket, move-number bucket, speed, colour, opening (ECO), and the
//             combination phase × clock bucket
//   measures: errors per 100 moves, and each kind (inaccuracy, mistake, blunder) per 100 moves;
//             openings also errors per game and score %
//
// and keeps a group + measure (a "candidate") only if
//   - it's at least rules.minGap (15%) worse than the player's OWN overall figure for the same
//     measure (the baseline), in the direction that's bad for that measure;
//   - the sample is big enough to call it a habit: at least rules.minGames games and
//     rules.minMoves of the player's moves (openings: games only);
//   - its errors come from at least 2 games (a pattern needs evidence from 2 games).
//
// Each candidate carries everything the report shows (label, value, baseline, gap, sample) and
// the exact filter for find_example_mistakes. The verifier takes the numbers and the label from
// here, never from the model.

export const candidateArgs = strictArgs({});

const KINDS = ["inaccuracy", "mistake", "blunder"] as const;
type Kind = (typeof KINDS)[number];

// The dimensions a group can fix, in the order ids and labels use. kind is the measure's error
// kind (blunderPer100 → kind=blunder), so it's also part of the example filter.
const DIMS = ["color", "speed", "eco", "phase", "clockBucket", "moveNumberBucket"] as const;
type Dim = (typeof DIMS)[number];
export type ExampleFilter = Partial<Record<Dim | "kind", string>>;

const GROUPINGS: Dim[][] = [["phase"], ["clockBucket"], ["moveNumberBucket"], ["speed"], ["color"], ["eco"], ["phase", "clockBucket"]];

export const MEASURES = ["per100Moves", "inaccuracyPer100", "mistakePer100", "blunderPer100", "errorsPerGame", "scorePct"] as const;
export type Measure = (typeof MEASURES)[number];
export type Direction = "higherIsWorse" | "lowerIsWorse";

export interface Candidate {
  id: string; // stable: "phase=endgame|kind=blunder", "eco=D01|errorsPerGame"
  label: string; // written by code: "Blunders per 100 moves in the endgame"
  measure: Measure;
  unit: "per100" | "perGame" | "percent";
  value: number;
  baseline: number; // the player's overall figure for the same measure
  direction: Direction;
  gapPct: number; // how much worse than the baseline, in % of the baseline
  games: number; // games in the group (rates: games with at least one of the player's moves in it)
  moves?: number; // the player's moves in the group (rates only)
  errors?: number; // the errors the measure counts (not for score %)
  rankScore: number; // how surprising this is given the player's own average and the sample
  exampleFilter: ExampleFilter; // ready for find_example_mistakes
  parentIds?: string[]; // broader candidates in this list that contain this one
}

const SHOWN = 12;

// Is `value` at least `minGap` (relative) worse than `baseline`, in the stated direction?
// higherIsWorse: 4.6 vs 3.1 is 48% worse; 11.8 vs 11.9 isn't worse at all.
// lowerIsWorse: a 40% score vs 75.3% is 47% worse.
export function isWorseEnough(value: number, baseline: number, direction: Direction, minGap: number): boolean {
  return direction === "higherIsWorse"
    ? value > baseline && value >= baseline * (1 + minGap) - 1e-9
    : value < baseline && value <= baseline * (1 - minGap) + 1e-9;
}

// The filter as a set of "key=value" strings, for nesting and overlap checks.
export const filterDims = (f: ExampleFilter) => Object.entries(f).map(([k, v]) => `${k}=${v}`);

// Is `inner` the same group as `outer` or a part of it (every condition of outer also in inner)?
export function isWithin(inner: ExampleFilter, outer: ExampleFilter): boolean {
  const dims = new Set(filterDims(inner));
  return filterDims(outer).every((d) => dims.has(d));
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const moveBucketOf = (moveNumber: number) => MOVE_BUCKETS.find((b) => moveNumber >= b.from && moveNumber <= b.to)!.label;

// ---------------------------------------------------------------------------------------------
// Labels, written by code so they always say exactly what was counted.

const MEASURE_LABEL: Record<Measure, string> = {
  per100Moves: "Errors per 100 moves",
  inaccuracyPer100: "Inaccuracies per 100 moves",
  mistakePer100: "Mistakes per 100 moves",
  blunderPer100: "Blunders per 100 moves",
  errorsPerGame: "Errors per game",
  scorePct: "Score",
};
const CLOCK_LABEL: Record<string, string> = {
  over50: "with over 50% of the clock left",
  from25to50: "with 25-50% of the clock left",
  from10to25: "with 10-25% of the clock left",
  under10: "with under 10% of the clock left",
};

export function labelOf(measure: Measure, f: ExampleFilter, openingName?: string | null): string {
  const parts: string[] = [];
  if (f.phase) parts.push(`in the ${f.phase}`);
  if (f.moveNumberBucket) parts.push(f.moveNumberBucket.endsWith("+") ? `from move ${f.moveNumberBucket.slice(0, -1)} on` : `in moves ${f.moveNumberBucket}`);
  if (f.clockBucket) parts.push(CLOCK_LABEL[f.clockBucket] ?? f.clockBucket);
  if (f.speed) parts.push(`in ${f.speed} games`);
  if (f.color) parts.push(`with ${f.color === "white" ? "White" : "Black"}`);
  if (f.eco) parts.push(`in the ${f.eco}${openingName ? ` (${openingName})` : ""}`);
  return [MEASURE_LABEL[measure], ...parts].join(" ");
}

// ---------------------------------------------------------------------------------------------
// The scan

export interface GameRow {
  _id: Types.ObjectId;
  color: Color;
  speed: Speed;
  timeControl?: string;
  plies: number;
  clocks?: number[];
  opening?: { eco?: string; name?: string };
  // division is missing when the game never left the opening (Mongoose doesn't store {}).
  features: { division?: Division; mistakes: { ply: number; kind: string; phase: string; clockLeft?: number }[] };
}

interface Cell {
  values: Partial<Record<Dim, string>>;
  moves: number;
  games: Set<string>;
  kinds: Record<Kind, number>;
  // Games where the cell has at least one error of that kind (or any kind).
  errorGames: Record<Kind | "total", Set<string>>;
}

const newCell = (values: Partial<Record<Dim, string>>): Cell => ({
  values,
  moves: 0,
  games: new Set(),
  kinds: { inaccuracy: 0, mistake: 0, blunder: 0 },
  errorGames: { inaccuracy: new Set(), mistake: new Set(), blunder: new Set(), total: new Set() },
});

const isKind = (k: string): k is Kind => (KINDS as readonly string[]).includes(k);

export async function getWeaknessCandidates(ctx: AgentContext) {
  const rules = rulesOf(ctx);
  const [analysed, all] = await Promise.all([
    // Only what the scan reads: no PGN, evals or FENs.
    Game.find(
      { playerId: ctx.playerId, ...HAS_FEATURES },
      {
        color: 1,
        speed: 1,
        timeControl: 1,
        plies: 1,
        clocks: 1,
        opening: 1,
        "features.division": 1,
        "features.mistakes.ply": 1,
        "features.mistakes.kind": 1,
        "features.mistakes.phase": 1,
        "features.mistakes.clockLeft": 1,
      },
    ).lean<GameRow[]>(),
    // Results need no engine: the score counts every game, like the profile and the dashboard.
    Game.find({ playerId: ctx.playerId }, { result: 1, "opening.eco": 1, "opening.name": 1 }).lean<
      { result: "win" | "draw" | "loss"; opening?: { eco?: string; name?: string } }[]
    >(),
  ]);
  return scanCandidates(analysed, all, rules);
}

export function scanCandidates(
  analysed: GameRow[],
  all: { result: "win" | "draw" | "loss"; opening?: { eco?: string; name?: string } }[],
  rules: WeaknessRules,
  shown = SHOWN,
) {
  // 1. Count the player's moves and errors into every group, one game at a time. The phase and
  //    clock bucket of each move use the same functions the extract job used for moveCounts
  //    (chess/features.ts), so the per-100 rates agree with the dashboard and the profile.
  const cells = new Map<string, Cell>();
  const overall = newCell({});
  const analysedByEco = new Map<string, number>();
  const cellsOf = (values: Partial<Record<Dim, string>>) => {
    const out: Cell[] = [];
    for (const grouping of GROUPINGS) {
      if (grouping.some((d) => values[d] === undefined)) continue;
      const key = grouping.map((d) => `${d}=${values[d]}`).join("|");
      let cell = cells.get(key);
      if (!cell) cells.set(key, (cell = newCell(Object.fromEntries(grouping.map((d) => [d, values[d]])))));
      out.push(cell);
    }
    return out;
  };

  for (const g of analysed) {
    const id = String(g._id);
    const eco = g.opening?.eco || undefined;
    if (eco) analysedByEco.set(eco, (analysedByEco.get(eco) ?? 0) + 1);
    const initial = initialSeconds(g.timeControl);
    const clocks = g.clocks && g.clocks.length === g.plies && initial ? g.clocks : undefined;
    const base = { color: g.color, speed: g.speed, eco };

    for (let ply = 1; ply <= g.plies; ply++) {
      if (moverOfPly(ply) !== g.color) continue;
      const values = {
        ...base,
        phase: phaseOfPly(g.features.division ?? {}, ply),
        clockBucket: clocks ? clockBucket(clocks[ply - 1]!, initial!) : undefined,
        moveNumberBucket: moveBucketOf(Math.ceil(ply / 2)),
      };
      for (const cell of [overall, ...cellsOf(values)]) {
        cell.moves++;
        cell.games.add(id);
      }
    }
    for (const m of g.features.mistakes ?? []) {
      if (!isKind(m.kind)) continue;
      const values = {
        ...base,
        phase: m.phase,
        clockBucket: m.clockLeft !== undefined && initial ? clockBucket(m.clockLeft, initial) : undefined,
        moveNumberBucket: moveBucketOf(Math.ceil(m.ply / 2)),
      };
      for (const cell of [overall, ...cellsOf(values)]) {
        cell.kinds[m.kind]++;
        cell.errorGames[m.kind].add(id);
        cell.errorGames.total.add(id);
      }
    }
  }

  // Openings: results from every game; the most common name for each code.
  const ecoResults = new Map<string, { games: number; points: number; names: Map<string, number> }>();
  let allPoints = 0;
  for (const g of all) {
    const points = g.result === "win" ? 1 : g.result === "draw" ? 0.5 : 0;
    allPoints += points;
    const eco = g.opening?.eco;
    if (!eco) continue;
    const r = ecoResults.get(eco) ?? { games: 0, points: 0, names: new Map() };
    r.games++;
    r.points += points;
    const name = cleanOpeningName(g.opening?.name);
    if (name) r.names.set(name, (r.names.get(name) ?? 0) + 1);
    ecoResults.set(eco, r);
  }
  const openingName = (eco: string) => {
    const names = [...(ecoResults.get(eco)?.names ?? new Map<string, number>()).entries()];
    return names.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  };

  // 2. The player's own overall figures: the baselines (the same numbers get_player_profile shows).
  const totalErrors = (c: Cell) => c.kinds.inaccuracy + c.kinds.mistake + c.kinds.blunder;
  const analysedGames = analysed.length;
  const baselines = {
    analysedGames,
    playerMoves: overall.moves,
    per100Moves: pct(totalErrors(overall), overall.moves),
    inaccuracyPer100: pct(overall.kinds.inaccuracy, overall.moves),
    mistakePer100: pct(overall.kinds.mistake, overall.moves),
    blunderPer100: pct(overall.kinds.blunder, overall.moves),
    errorsPerGame: analysedGames > 0 ? round2(totalErrors(overall) / analysedGames) : null,
    scorePct: pct(allPoints, all.length),
  };

  // 3. Every group × measure that qualifies. rankScore is a z-score: how many standard
  //    deviations the group's count is from what the player's own average predicts for a sample
  //    that size (Poisson for error counts, binomial for the score). It rewards a big gap AND a
  //    big sample: 4 blunders where 2 were expected rank below 40 where 20 were expected.
  const found: Candidate[] = [];
  let checked = 0;
  const minGapPct = Math.round(rules.minGap * 100);

  for (const cell of cells.values()) {
    const filter: ExampleFilter = Object.fromEntries(DIMS.filter((d) => cell.values[d] !== undefined).map((d) => [d, cell.values[d]]));
    const isOpening = filter.eco !== undefined;
    const name = isOpening ? openingName(filter.eco!) : null;
    const add = (c: Omit<Candidate, "id" | "label" | "gapPct">, idSuffix?: string) => {
      checked++;
      if (!isWorseEnough(c.value, c.baseline, c.direction, rules.minGap) || c.baseline <= 0) return;
      const id = [...filterDims(c.exampleFilter), ...(idSuffix ? [idSuffix] : [])].join("|");
      const gapPct = Math.round((Math.abs(c.value - c.baseline) / c.baseline) * 100);
      found.push({ id, label: labelOf(c.measure, c.exampleFilter, name), ...c, gapPct });
    };

    // Error rates per 100 of the player's moves: all errors, then each kind.
    const enoughSample = isOpening ? cell.games.size >= rules.minGames : cell.games.size >= rules.minGames && cell.moves >= rules.minMoves;
    if (enoughSample && overall.moves > 0) {
      for (const kind of [null, ...KINDS]) {
        const count = kind ? cell.kinds[kind] : totalErrors(cell);
        const overallCount = kind ? overall.kinds[kind] : totalErrors(overall);
        if (cell.errorGames[kind ?? "total"].size < 2) continue;
        const expected = (cell.moves * overallCount) / overall.moves;
        add({
          measure: kind ? (`${kind}Per100` as Measure) : "per100Moves",
          unit: "per100",
          value: pct(count, cell.moves)!,
          baseline: pct(overallCount, overall.moves)!,
          direction: "higherIsWorse",
          games: cell.games.size,
          moves: cell.moves,
          errors: count,
          rankScore: expected > 0 ? Math.round(((count - expected) / Math.sqrt(expected)) * 10) / 10 : 0,
          exampleFilter: kind ? { ...filter, kind } : filter,
        });
      }
    }

    if (!isOpening || cell.errorGames.total.size < 2) continue;
    // Openings: errors per analysed game, and the score (from every game with that code).
    const ecoAnalysed = analysedByEco.get(filter.eco!) ?? 0;
    if (ecoAnalysed >= rules.minGames && analysedGames > 0) {
      const errors = totalErrors(cell);
      const expected = (ecoAnalysed * totalErrors(overall)) / analysedGames;
      add(
        {
          measure: "errorsPerGame",
          unit: "perGame",
          value: round2(errors / ecoAnalysed),
          baseline: baselines.errorsPerGame!,
          direction: "higherIsWorse",
          games: ecoAnalysed,
          errors,
          rankScore: expected > 0 ? Math.round(((errors - expected) / Math.sqrt(expected)) * 10) / 10 : 0,
          exampleFilter: filter,
        },
        "errorsPerGame",
      );
    }
    const results = ecoResults.get(filter.eco!);
    if (results && results.games >= rules.minGames && all.length > 0) {
      const p0 = allPoints / all.length;
      const p = results.points / results.games;
      add(
        {
          measure: "scorePct",
          unit: "percent",
          value: pct(results.points, results.games)!,
          baseline: baselines.scorePct!,
          direction: "lowerIsWorse",
          games: results.games,
          rankScore: p0 > 0 && p0 < 1 ? Math.round(((p0 - p) / Math.sqrt((p0 * (1 - p0)) / results.games)) * 10) / 10 : 0,
          exampleFilter: filter,
        },
        "scorePct",
      );
    }
  }

  // 4. Strongest first. One candidate per example filter (an opening's errors per game and its
  //    errors per 100 moves would bring the same examples), then the top SHOWN (one slot kept
  //    for an opening), with the broader candidates each one sits inside.
  found.sort((a, b) => b.rankScore - a.rankScore || b.gapPct - a.gapPct || a.id.localeCompare(b.id));
  const seenFilters = new Set<string>();
  const unique = found.filter((c) => {
    const key = filterDims(c.exampleFilter).sort().join("|");
    if (seenFilters.has(key)) return false;
    seenFilters.add(key);
    return true;
  });
  // One slot is kept for the strongest opening candidate: openings are the most concrete thing
  // to study, and a slightly lower score shouldn't hide them behind phase and clock groups.
  const top = unique.slice(0, shown);
  const bestOpening = unique.find((c) => c.exampleFilter.eco !== undefined);
  if (bestOpening && !top.includes(bestOpening) && top.length === shown) top[shown - 1] = bestOpening;
  const listed = top.map((c, _, list) => {
    const parentIds = list.filter((o) => o !== c && isWithin(c.exampleFilter, o.exampleFilter)).map((o) => o.id);
    return parentIds.length ? { ...c, parentIds } : c;
  });

  return {
    rules: { minGapPct, minGames: rules.minGames, minMoves: rules.minMoves },
    overall: baselines,
    checked,
    qualifying: unique.length,
    candidates: listed,
  };
}
