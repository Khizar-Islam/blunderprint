import { Types, type PipelineStage } from "mongoose";
import { FEATURES_VERSION } from "../chess/features.js";
import { Game, type Classification, type Color, type Speed } from "../db/models/game.js";
import { Player } from "../db/models/player.js";

// The dashboard summary (CLAUDE.md 8.3): one aggregation over a player's games.
//
// - Unfiltered, it's cached in players.summary (rebuilt by the extract job at the end of each
//   run, and by the import job), so the dashboard's first load is one document read.
// - Filtered (colour, speed, date range), it runs live per request: a player has at most
//   MAX_GAMES_PER_PLAYER (200) games, so it reads at most 200 documents.
//
// Bump SUMMARY_VERSION when the response shape changes: a cached summary with another version
// is ignored and rebuilt.
// v2: squares split by the colour the player had (the heat board mirrors Black's ranks).
export const SUMMARY_VERSION = 2;

export interface SummaryFilters {
  color?: Color;
  speed?: Speed;
  from?: Date; // inclusive
  to?: Date; // exclusive
}

type KindCounts = { inaccuracy: number; mistake: number; blunder: number };
const KINDS = ["inaccuracy", "mistake", "blunder"] as const;
export const PHASES = ["opening", "middlegame", "endgame"] as const;
// Same buckets and the same edges as chess/features.ts clockBucket(): the share of the
// starting clock left after the move.
export const CLOCK_BUCKETS = ["over50", "from25to50", "from10to25", "under10"] as const;
// Move numbers (1 = each side's first move), lower bounds; the last bucket is open-ended.
export const MOVE_BUCKETS = [
  { label: "1-10", from: 1, to: 10 },
  { label: "11-20", from: 11, to: 20 },
  { label: "21-30", from: 21, to: 30 },
  { label: "31-40", from: 31, to: 40 },
  { label: "41+", from: 41, to: Infinity },
] as const;

// Rates: "per game" = errors / analysed games; "per 100 moves" = errors / the player's moves in
// that group × 100. Per 100 moves is the fair comparison between groups of different sizes
// (many games never reach an endgame); per game is the easier number to picture.
export interface Rate extends KindCounts {
  total: number;
  moves: number;
  perGame: number | null;
  per100: number | null;
}

export type SquareCount = { square: string; total: number } & KindCounts;

export interface Summary {
  version: number;
  generatedAt: string;
  filters: { color?: Color; speed?: Speed; from?: string; to?: string };
  totals: {
    games: number; // every game in the filter, analysed or not
    analysed: number; // games with features (the base of every rate below)
    moves: number; // the player's moves in those games
    mistakes: KindCounts & { total: number };
    firstPlayedAt: string | null;
    lastPlayedAt: string | null;
  };
  // Score from every game (a result needs no engine); errors per game from analysed ones.
  openings: {
    eco: string | null;
    name: string | null;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    score: number; // 0–100: a win counts 1, a draw ½
    analysed: number;
    mistakesPerGame: number | null;
  }[];
  byPhase: ({ phase: (typeof PHASES)[number] } & Rate)[];
  bySpeed: ({ speed: Speed; games: number } & Rate)[];
  byClock: ({ bucket: (typeof CLOCK_BUCKETS)[number] } & Rate)[];
  byMoveNumber: ({ bucket: string } & Rate)[];
  // Errors per destination square, split by the player's colour: all 64 for each, a1, b1 … h8.
  // Real board squares; the dashboard mirrors Black's ranks itself for "both colours".
  squares: Record<Color, SquareCount[]>;
  // One per analysed game, newest first. classes: one letter per ply, both sides
  // (b best, g good, i inaccuracy, m mistake, x blunder); the client knows which plies are the
  // player's from color.
  ribbons: { gameId: string; playedAt: string; color: Color; result: string; speed: Speed; classes: string }[];
}

const CLASS_LETTER: Record<Classification, string> = { best: "b", good: "g", inaccuracy: "i", mistake: "m", blunder: "x" };
const OPENINGS_SHOWN = 25;

// "Has features of the current version, and they're not a replay error": the games every
// rate is computed from. Exported for the coach's tools (agent/tools), which count the same games.
export const HAS_FEATURES = { "features.version": FEATURES_VERSION, "features.error": { $exists: false } };
// The same test as an expression, for counting inside a $group.
const HAS_FEATURES_EXPR = { $and: [{ $eq: ["$features.version", FEATURES_VERSION] }, { $not: ["$features.error"] }] };

// A mistake's clock bucket from `share` (clockLeft ÷ the starting time). A $switch, not
// $bucket, so the edges match clockBucket() exactly (> 50%, > 25%, ≥ 10%, below).
export const clockBucketSwitch = (share: unknown) => ({
  $switch: {
    branches: [
      { case: { $gt: [share, 0.5] }, then: "over50" },
      { case: { $gt: [share, 0.25] }, then: "from25to50" },
      { case: { $gte: [share, 0.1] }, then: "from10to25" },
    ],
    default: "under10",
  },
});

// clockLeft ÷ the starting time read from timeControl ("180+2" → 180).
export const clockShare = (clockLeft: unknown, timeControl: unknown) => ({
  $divide: [clockLeft, { $toDouble: { $arrayElemAt: [{ $split: [timeControl, "+"] }, 0] } }],
});

// A move number (1 = each side's first move) → its MOVE_BUCKETS label.
export const moveBucketSwitch = (moveNumber: unknown) => ({
  $switch: {
    branches: MOVE_BUCKETS.slice(0, -1).map((b) => ({ case: { $lte: [moveNumber, b.to] }, then: b.label })),
    default: MOVE_BUCKETS.at(-1)!.label,
  },
});

// Counts per kind of whatever group the stage before produced ({ _id, kind, n }) →
// { _id, inaccuracy, mistake, blunder }. Shared by every "mistakes by X" facet.
const countKinds = (groupKey: unknown): PipelineStage.FacetPipelineStage[] => [
  { $group: { _id: { key: groupKey, kind: "$m.kind" }, n: { $sum: 1 } } },
  { $group: { _id: "$_id.key", kinds: { $push: { k: "$_id.kind", v: "$n" } } } },
  { $project: { _id: 1, counts: { $arrayToObject: "$kinds" } } },
];

// The stages every "mistakes by X" facet starts with: only games with features, then one
// document per mistake (as `m`), keeping the game fields the grouping needs.
const unwindMistakes: PipelineStage.FacetPipelineStage[] = [
  { $match: HAS_FEATURES },
  { $unwind: "$features.mistakes" },
  { $set: { m: "$features.mistakes" } },
];

export function summaryPipeline(playerId: Types.ObjectId, filters: SummaryFilters): PipelineStage[] {
  const playedAt: Record<string, Date> = {};
  if (filters.from) playedAt.$gte = filters.from;
  if (filters.to) playedAt.$lt = filters.to;

  return [
    // 1. This player's games in the filter. playerId + a playedAt range are the prefix of the
    //    { playerId: 1, playedAt: -1, _id: -1 } index, so this is an index scan; colour and
    //    speed are checked on the (at most 200) documents it fetches.
    {
      $match: {
        playerId,
        ...(filters.from || filters.to ? { playedAt } : {}),
        ...(filters.color ? { color: filters.color } : {}),
        ...(filters.speed ? { speed: filters.speed } : {}),
      },
    },
    // 2. Newest first. The same index gives this order, so there's no in-memory sort, and it
    //    makes the planner pick that index over the other { playerId, … } ones. The ribbons
    //    facet relies on this order ($facet passes documents through in input order).
    { $sort: { playedAt: -1, _id: -1 } },
    // 3. Only the fields the facets read: the PGN, evals and best moves (most of a game
    //    document) never leave this stage.
    {
      $project: {
        playedAt: 1,
        color: 1,
        result: 1,
        speed: 1,
        timeControl: 1,
        plies: 1,
        opening: 1,
        "analysis.status": 1,
        "analysis.classifications": 1,
        features: 1,
      },
    },
    // 4. Every breakdown from the same documents in one pass.
    {
      $facet: {
        // Counts over all games in the filter, and over the analysed ones.
        totals: [
          {
            $group: {
              _id: null,
              games: { $sum: 1 },
              analysed: { $sum: { $cond: [HAS_FEATURES_EXPR, 1, 0] } },
              firstPlayedAt: { $min: "$playedAt" },
              lastPlayedAt: { $max: "$playedAt" },
            },
          },
        ],

        // Per opening (by ECO code, the same on both sites): results from every game, errors
        // from the analysed ones. The label is the name used most often for that code.
        openings: [
          // a. One row per (eco, name), so the most common name can be picked below.
          {
            $group: {
              _id: { eco: "$opening.eco", name: "$opening.name" },
              games: { $sum: 1 },
              wins: { $sum: { $cond: [{ $eq: ["$result", "win"] }, 1, 0] } },
              draws: { $sum: { $cond: [{ $eq: ["$result", "draw"] }, 1, 0] } },
              analysed: { $sum: { $cond: [HAS_FEATURES_EXPR, 1, 0] } },
              mistakes: { $sum: { $size: { $ifNull: ["$features.mistakes", []] } } },
            },
          },
          // b. Most-used name first within each code, so $first in the next stage picks it.
          { $sort: { "_id.eco": 1, games: -1, "_id.name": 1 } },
          // c. One row per ECO code.
          {
            $group: {
              _id: "$_id.eco",
              name: { $first: "$_id.name" },
              games: { $sum: "$games" },
              wins: { $sum: "$wins" },
              draws: { $sum: "$draws" },
              analysed: { $sum: "$analysed" },
              mistakes: { $sum: "$mistakes" },
            },
          },
          // d. Most-played first; the dashboard shows the top ones.
          { $sort: { games: -1, _id: 1 } },
          { $limit: OPENINGS_SHOWN },
        ],

        // Denominators: the player's moves per phase and per clock bucket (stored per game by
        // the extract job), and per move-number bucket (computed here from plies and colour),
        // grouped by speed so one facet serves both the phase and the speed breakdowns.
        moves: [
          { $match: HAS_FEATURES },
          {
            // The player's last move number: White plays moves 1…ceil(plies/2), Black 1…floor(plies/2).
            $set: {
              lastMove: {
                $cond: [
                  { $eq: ["$color", "white"] },
                  { $ceil: { $divide: ["$plies", 2] } },
                  { $floor: { $divide: ["$plies", 2] } },
                ],
              },
            },
          },
          {
            $group: {
              _id: "$speed",
              games: { $sum: 1 },
              opening: { $sum: "$features.moveCounts.opening" },
              middlegame: { $sum: "$features.moveCounts.middlegame" },
              endgame: { $sum: "$features.moveCounts.endgame" },
              ...Object.fromEntries(
                CLOCK_BUCKETS.map((b) => [`clock_${b}`, { $sum: { $ifNull: [`$features.moveCounts.clock.${b}`, 0] } }]),
              ),
              // Moves in [from, to]: max(0, min(to, lastMove) − from + 1).
              ...Object.fromEntries(
                MOVE_BUCKETS.map((b, i) => [
                  `move_${i}`,
                  {
                    $sum: {
                      $max: [0, { $add: [{ $subtract: [b.to === Infinity ? "$lastMove" : { $min: [b.to, "$lastMove"] }, b.from] }, 1] }],
                    },
                  },
                ]),
              ),
            },
          },
        ],

        // Errors per phase and kind.
        byPhase: [...unwindMistakes, ...countKinds("$m.phase")],

        // Errors per speed and kind.
        bySpeed: [...unwindMistakes, ...countKinds("$speed")],

        // Errors per clock bucket and kind. The starting time is read from timeControl
        // ("180+2" → 180); daily games and games without clocks have no clockLeft and drop out
        // at the $match. clockBucketSwitch has the same edges as clockBucket().
        byClock: [
          ...unwindMistakes,
          { $match: { "m.clockLeft": { $exists: true } } },
          { $set: { share: clockShare("$m.clockLeft", "$timeControl") } },
          ...countKinds(clockBucketSwitch("$share")),
        ],

        // Errors per move-number bucket and kind (move number = ceil(ply / 2)).
        byMoveNumber: [
          ...unwindMistakes,
          { $set: { moveNumber: { $ceil: { $divide: ["$m.ply", 2] } } } },
          ...countKinds(moveBucketSwitch("$moveNumber")),
        ],

        // Errors per destination square, colour and kind: the heat board. Split by colour so the
        // dashboard can show White's games, Black's, or both with Black's ranks mirrored.
        squares: [...unwindMistakes, ...countKinds({ square: "$m.square", color: "$color" })],

        // One ribbon per analysed game (ours or Lichess's), in the newest-first order of stage 2.
        // Classifications become a one-letter-per-ply string: ~80 bytes a game instead of an
        // array of words.
        ribbons: [
          { $match: { "analysis.status": { $in: ["done", "imported"] }, "analysis.classifications.0": { $exists: true } } },
          {
            $project: {
              playedAt: 1,
              color: 1,
              result: 1,
              speed: 1,
              classes: {
                $reduce: {
                  input: "$analysis.classifications",
                  initialValue: "",
                  in: {
                    $concat: [
                      "$$value",
                      {
                        $switch: {
                          branches: Object.entries(CLASS_LETTER).map(([cls, letter]) => ({
                            case: { $eq: ["$$this", cls] },
                            then: letter,
                          })),
                          default: "g",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        ],
      },
    },
  ];
}

interface FacetResult {
  totals: { games: number; analysed: number; firstPlayedAt: Date | null; lastPlayedAt: Date | null }[];
  openings: { _id: string | null; name: string | null; games: number; wins: number; draws: number; analysed: number; mistakes: number }[];
  moves: ({ _id: Speed; games: number; opening: number; middlegame: number; endgame: number } & Record<string, number>)[];
  byPhase: { _id: string; counts: Partial<KindCounts> }[];
  bySpeed: { _id: Speed; counts: Partial<KindCounts> }[];
  byClock: { _id: string; counts: Partial<KindCounts> }[];
  byMoveNumber: { _id: string; counts: Partial<KindCounts> }[];
  squares: { _id: { square: string; color: Color }; counts: Partial<KindCounts> }[];
  ribbons: { _id: Types.ObjectId; playedAt: Date; color: Color; result: string; speed: Speed; classes: string }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const kindsOf = (c: Partial<KindCounts> | undefined): KindCounts => ({
  inaccuracy: c?.inaccuracy ?? 0,
  mistake: c?.mistake ?? 0,
  blunder: c?.blunder ?? 0,
});

function rate(counts: Partial<KindCounts> | undefined, moves: number, games: number): Rate {
  const k = kindsOf(counts);
  const total = k.inaccuracy + k.mistake + k.blunder;
  return {
    ...k,
    total,
    moves,
    perGame: games > 0 ? round2(total / games) : null,
    per100: moves > 0 ? round1((total / moves) * 100) : null,
  };
}

const FILES = "abcdefgh";

// The facet output → the response shape, with every rate worked out. `readAt` is when the
// data was read (taken before the aggregation ran), not when shaping finished.
export function shapeSummary(raw: FacetResult, filters: SummaryFilters, readAt: Date): Summary {
  const t = raw.totals[0];
  const analysed = t?.analysed ?? 0;
  const sum = (field: string) => raw.moves.reduce((s, row) => s + (row[field] ?? 0), 0);
  const byKey = <T extends { _id: string }>(rows: T[]) => new Map(rows.map((r) => [r._id, r]));

  const phaseRows = byKey(raw.byPhase);
  const byPhase = PHASES.map((phase) => ({ phase, ...rate(phaseRows.get(phase)?.counts, sum(phase), analysed) }));
  const moves = byPhase.reduce((s, p) => s + p.moves, 0);
  const allKinds = byPhase.reduce(
    (acc, p) => ({ inaccuracy: acc.inaccuracy + p.inaccuracy, mistake: acc.mistake + p.mistake, blunder: acc.blunder + p.blunder }),
    { inaccuracy: 0, mistake: 0, blunder: 0 },
  );

  const speedRows = byKey(raw.bySpeed);
  const bySpeed = raw.moves
    .map((row) => {
      const speedMoves = row.opening + row.middlegame + row.endgame;
      return { speed: row._id, games: row.games, ...rate(speedRows.get(row._id)?.counts, speedMoves, row.games) };
    })
    // Most games first; equal counts by name, so the order never depends on how $group came out.
    .sort((a, b) => b.games - a.games || a.speed.localeCompare(b.speed));

  const clockRows = byKey(raw.byClock);
  const byClock = CLOCK_BUCKETS.map((bucket) => ({ bucket, ...rate(clockRows.get(bucket)?.counts, sum(`clock_${bucket}`), analysed) }));

  const moveRows = byKey(raw.byMoveNumber);
  const byMoveNumber = MOVE_BUCKETS.map((b, i) => ({ bucket: b.label, ...rate(moveRows.get(b.label)?.counts, sum(`move_${i}`), analysed) }));

  const squareRows = new Map(raw.squares.map((r) => [`${r._id.color}:${r._id.square}`, r.counts]));
  const squaresFor = (color: Color): SquareCount[] =>
    Array.from({ length: 64 }, (_, i) => {
      const square = `${FILES[i % 8]}${Math.floor(i / 8) + 1}`;
      const k = kindsOf(squareRows.get(`${color}:${square}`));
      return { square, ...k, total: k.inaccuracy + k.mistake + k.blunder };
    });
  const squares = { white: squaresFor("white"), black: squaresFor("black") };

  return {
    version: SUMMARY_VERSION,
    generatedAt: readAt.toISOString(),
    filters: {
      ...(filters.color ? { color: filters.color } : {}),
      ...(filters.speed ? { speed: filters.speed } : {}),
      ...(filters.from ? { from: filters.from.toISOString() } : {}),
      ...(filters.to ? { to: filters.to.toISOString() } : {}),
    },
    totals: {
      games: t?.games ?? 0,
      analysed,
      moves,
      mistakes: { ...allKinds, total: allKinds.inaccuracy + allKinds.mistake + allKinds.blunder },
      firstPlayedAt: t?.firstPlayedAt ? t.firstPlayedAt.toISOString() : null,
      lastPlayedAt: t?.lastPlayedAt ? t.lastPlayedAt.toISOString() : null,
    },
    openings: raw.openings.map((o) => ({
      eco: o._id ?? null,
      name: o.name ?? null,
      games: o.games,
      wins: o.wins,
      draws: o.draws,
      losses: o.games - o.wins - o.draws,
      score: round1(((o.wins + o.draws / 2) / o.games) * 100),
      analysed: o.analysed,
      mistakesPerGame: o.analysed > 0 ? round2(o.mistakes / o.analysed) : null,
    })),
    byPhase,
    bySpeed,
    byClock,
    byMoveNumber,
    squares,
    ribbons: raw.ribbons.map((r) => ({
      gameId: String(r._id),
      playedAt: r.playedAt.toISOString(),
      color: r.color,
      result: r.result,
      speed: r.speed,
      classes: r.classes,
    })),
  };
}

export async function computeSummary(playerId: Types.ObjectId, filters: SummaryFilters = {}): Promise<Summary> {
  // Stamp the time BEFORE the read, so generatedAt says how fresh the data is. Stamped after,
  // a slow aggregation that read older data would carry the later time.
  const readAt = new Date();
  const [raw] = await Game.aggregate<FacetResult>(summaryPipeline(playerId, filters));
  return shapeSummary(raw!, filters, readAt);
}

// Rebuild the cached (unfiltered) summary. The write only lands if no newer summary is stored:
// a dashboard request and an extract job can both rebuild at once, and the older result
// must not overwrite the newer one. "Older" means read earlier (generatedAt is stamped before
// the aggregation), so a rebuild that started first but finished last loses. On an exact
// millisecond tie the later write wins.
export async function rebuildCachedSummary(playerId: Types.ObjectId | string): Promise<Summary> {
  const id = new Types.ObjectId(String(playerId));
  const summary = await computeSummary(id);
  await Player.updateOne(
    {
      _id: id,
      $or: [{ "summary.generatedAt": { $exists: false } }, { "summary.generatedAt": { $lte: summary.generatedAt } }],
    },
    { $set: { summary, summaryVersion: SUMMARY_VERSION } },
    // A rebuilt summary isn't a change to the player's own data.
    { timestamps: false },
  );
  return summary;
}
