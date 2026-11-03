// Explains the dashboard summary aggregation (stats/summary.ts) against the real database and
// writes docs/explain/summary-unfiltered.json and summary-filtered.json. Read-only.
//   npm run explain:summary                                  (lichess:DrNykterstein)
//   npm run explain:summary -- chesscom:gothamchess          (another player)
//
// Each file has a short summary (index used, in-memory sort or not, keys and documents
// examined, executionTimeMillis), the round-trip times of the full aggregation from this
// machine (network included), and the complete .explain("executionStats") output.
//
// executionTimeMillis is the server's own time. The round trip from my laptop adds the
// network to the Singapore cluster; Render's round trip is measured on Render.
import { mkdir, writeFile } from "node:fs/promises";
import mongoose from "mongoose";
import { loadEnv } from "../src/config/env.js";
import { Game } from "../src/db/models/game.js";
import { Player, type Platform } from "../src/db/models/player.js";
import { summarizeExplain } from "../src/lib/explain.js";
import { computeSummary, summaryPipeline, type SummaryFilters } from "../src/stats/summary.js";

const RUNS = 5;
const [platform, username] = (process.argv[2] ?? "lichess:DrNykterstein").split(":") as [Platform, string];
// A filter that exercises all three: colour, speed and a date range (the index's playedAt bounds).
const FILTERED: SummaryFilters = { color: "white", speed: "bullet", from: new Date("2025-01-01T00:00:00Z") };

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
const mongoVersion = ((await mongoose.connection.db!.admin().serverInfo()) as { version: string }).version;

const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1, username: 1 }).lean();
if (!player) throw new Error(`No player ${platform}:${username}`);

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

// These files go in the public repo: drop the cluster's hostname (serverInfo) and the signed
// cluster time ($clusterTime, operationTime). The plan and the statistics are all that matter.
function publishable(explain: unknown): unknown {
  const { serverInfo: _host, $clusterTime: _clusterTime, operationTime: _operationTime, ...rest } = explain as Record<string, unknown>;
  return rest;
}

for (const [name, filters] of [
  ["unfiltered", {}],
  ["filtered", FILTERED],
] as const) {
  const explain = await Game.aggregate(summaryPipeline(player._id, filters)).explain("executionStats");
  const summary = summarizeExplain(explain);

  // The full aggregation + shaping, as the route runs it (a cold first run, then warm ones).
  const roundTripMs: number[] = [];
  let games = 0;
  let analysed = 0;
  for (let i = 0; i < RUNS; i++) {
    const started = performance.now();
    const s = await computeSummary(player._id, filters);
    roundTripMs.push(Math.round(performance.now() - started));
    games = s.totals.games;
    analysed = s.totals.analysed;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mongoVersion,
    player: `${platform}:${player.username}`,
    filters,
    index: "{ playerId: 1, playedAt: -1, _id: -1 }",
    games,
    analysed,
    ...summary,
    roundTripMs: { runs: roundTripMs, median: median(roundTripMs), from: "my laptop (Karachi) to Atlas (Singapore)" },
    explain: publishable(explain),
  };
  const out = new URL(`../../docs/explain/summary-${name}.json`, import.meta.url);
  await mkdir(new URL(".", out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n");

  console.log(`\n${name} ${JSON.stringify(filters)}: ${games} games, ${analysed} analysed`);
  console.log(`  index scans:        ${summary.indexScans.join(", ") || "none"}`);
  console.log(`  collection scan:    ${summary.collectionScan}   in-memory sort: ${summary.inMemorySort}`);
  console.log(`  keys / docs examined: ${summary.keysExamined} / ${summary.docsExamined}`);
  console.log(`  executionTimeMillis: ${summary.executionTimeMillis}`);
  console.log(`  round trip (ms):    ${roundTripMs.join(", ")} (median ${median(roundTripMs)})`);
  console.log(`  wrote ${out.pathname}`);
}

await mongoose.disconnect();
