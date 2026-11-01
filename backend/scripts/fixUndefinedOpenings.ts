// One-off: remove the opening name "Undefined" from Chess.com games imported before the fix in
// importers/chesscom.ts (openingNameFromEcoUrl). Chess.com's ECOUrl ends in ".../Undefined"
// when a game has no named opening, and we used to store that as the name.
//
// Only the name goes: the ECO code (A00 on every affected game seen) is a real code and stays.
//
// DRY RUN BY DEFAULT: prints the counts per player, writes nothing.
//   npm run fix:undefined-openings              (dry run)
//   npm run fix:undefined-openings -- --apply   (writes)
//
// Safe to repeat: the filter only matches games that still have the bad name.
import mongoose from "mongoose";
import { loadEnv } from "../src/config/env.js";
import { Game } from "../src/db/models/game.js";
import { Player } from "../src/db/models/player.js";

const APPLY = process.argv.includes("--apply");
// Exactly "Undefined" (any case), nothing else: an opening whose name merely contains the word
// would be left alone.
const filter = { platform: "chesscom" as const, "opening.name": { $regex: /^undefined$/i } };

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

const groups = await Game.aggregate<{ _id: { playerId: mongoose.Types.ObjectId; eco: string | null }; n: number }>([
  { $match: filter },
  { $group: { _id: { playerId: "$playerId", eco: "$opening.eco" }, n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]);
const players = await Player.find({ _id: { $in: groups.map((g) => g._id.playerId) } }, { username: 1 }).lean();
const nameOf = new Map(players.map((p) => [String(p._id), p.username]));

const total = groups.reduce((sum, g) => sum + g.n, 0);
console.log(`${APPLY ? "APPLY" : "DRY RUN"}: ${total} Chess.com games with opening name "Undefined"`);
for (const g of groups) {
  console.log(`  ${nameOf.get(String(g._id.playerId)) ?? g._id.playerId}  ECO ${g._id.eco ?? "-"}  ${g.n}`);
}

if (APPLY && total > 0) {
  const result = await Game.updateMany(filter, { $unset: { "opening.name": 1 } });
  console.log(`Updated ${result.modifiedCount} games (matched ${result.matchedCount}).`);
} else if (!APPLY) {
  console.log("Nothing written. Run again with -- --apply to remove these names.");
}

await mongoose.disconnect();
