// Backfill: extract features (chess/features.ts) for games analysed before Stage 3 existed.
// New results don't need this: the extract job runs after each one.
//
// DRY RUN BY DEFAULT: extracts in memory and prints per player what it would write, plus the
// numbers to check before writing (mistakes found, a sample entry, bytes added per game, ms
// per game on this machine). Writes nothing.
//   npm run extract:features                                     (dry run, every player)
//   npm run extract:features -- --player lichess:DrNykterstein   (dry run, one player)
//   npm run extract:features -- --apply                          (writes)
//
// Safe to repeat: it only picks games whose features are missing or from an older
// FEATURES_VERSION, and each write re-checks that condition.
//
// Times here are my laptop's, not Render's (~15–20× slower, CLAUDE.md 17). The extract job
// logs Render's real numbers ("Extract batch", wallMsPerGame).
import mongoose from "mongoose";
import { extractFeatures, FEATURES_VERSION, type GameFeatures } from "../src/chess/features.js";
import { loadEnv } from "../src/config/env.js";
import { Game } from "../src/db/models/game.js";
import { Player, type Platform } from "../src/db/models/player.js";
import { featureInputOf, needsExtraction, PROJECTION, type ExtractableGame } from "../src/jobs/handlers/extract.js";

const APPLY = process.argv.includes("--apply");
const playerArg = process.argv[process.argv.indexOf("--player") + 1];
const only = process.argv.includes("--player") ? playerArg?.split(":") : undefined;
if (only && (only.length !== 2 || !only[0] || !only[1])) throw new Error("--player wants platform:username");

const { calculateObjectSize } = mongoose.mongo.BSON;
// What adding `features` to a game document costs, in BSON bytes.
const bytesAdded = (features: unknown) => calculateObjectSize({ features }) - calculateObjectSize({});

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

const players = await Player.find(
  only ? { platform: only[0] as Platform, usernameLower: only[1]!.toLowerCase() } : {},
  { platform: 1, username: 1 },
).lean();
if (only && players.length === 0) throw new Error(`No player ${only.join(":")}`);

console.log(`${APPLY ? "APPLY" : "DRY RUN"}: FEATURES_VERSION ${FEATURES_VERSION}, ${players.length} players`);
const totals = { games: 0, mistakes: 0, failed: 0, bytes: 0, ms: 0, written: 0 };

for (const p of players) {
  const games = await Game.find(needsExtraction(p._id), PROJECTION).lean<ExtractableGame[]>();
  if (games.length === 0) continue;

  let mistakes = 0;
  let failed = 0;
  let bytes = 0;
  let ms = 0;
  let written = 0;
  let sample: GameFeatures["mistakes"][number] | undefined;
  for (const game of games) {
    const started = performance.now();
    const features = await extractFeatures(featureInputOf(game));
    ms += performance.now() - started;
    bytes += bytesAdded(features);
    if ("error" in features) failed++;
    else {
      mistakes += features.mistakes.length;
      sample ??= features.mistakes.find((m) => m.kind === "blunder") ?? features.mistakes[0];
    }
    if (APPLY) {
      const res = await Game.updateOne(
        { _id: game._id, "analysis.status": game.analysis?.status, "features.version": { $ne: FEATURES_VERSION } },
        { $set: { features } },
      );
      written += res.modifiedCount;
    }
  }

  console.log(`\n${p.platform}:${p.username}`);
  console.log(`  games to extract: ${games.length}${failed ? ` (${failed} didn't replay)` : ""}`);
  console.log(`  mistakes found:   ${mistakes} (${(mistakes / Math.max(1, games.length - failed)).toFixed(2)} per game)`);
  console.log(`  bytes added:      ${Math.round(bytes / games.length)} per game on average (${(bytes / 1024).toFixed(1)} KB in all)`);
  console.log(`  ms per game:      ${(ms / games.length).toFixed(1)} (this machine)`);
  if (sample) console.log(`  sample entry:     ${JSON.stringify(sample)}`);
  if (APPLY) console.log(`  written:          ${written}`);

  totals.games += games.length;
  totals.mistakes += mistakes;
  totals.failed += failed;
  totals.bytes += bytes;
  totals.ms += ms;
  totals.written += written;
}

console.log(
  `\nTotal: ${totals.games} games, ${totals.mistakes} mistakes, ${totals.failed} didn't replay, ` +
    `${Math.round(totals.bytes / Math.max(1, totals.games))} bytes per game on average ` +
    `(${(totals.bytes / 1024).toFixed(1)} KB in all), ${(totals.ms / Math.max(1, totals.games)).toFixed(1)} ms per game` +
    (APPLY ? `, ${totals.written} written` : ""),
);
if (!APPLY) console.log("Nothing written. Run again with -- --apply to write these features.");

await mongoose.disconnect();
