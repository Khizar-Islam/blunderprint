// Explains the games-list query (GET /api/players/:platform/:username/games) against the real
// database and writes a summary to docs/explain/games-pagination.json. Read-only.
// Usage (from backend/):  npm run explain:games -- lichess:penguingim1 chesscom:hikaru ...
//
// For each player it compares two ways to say "after the cursor":
//   orOnly:  { $or: [ { playedAt < t }, { playedAt = t, _id < id } ] }
//   bounded: { playedAt ≤ t, $or: [...] }   (what lib/cursor.ts uses)
// at the first page, a middle page and the last page, plus one filtered page (speed=blitz).
import { mkdir, writeFile } from "node:fs/promises";
import mongoose, { type Types } from "mongoose";
import { loadEnv } from "../src/config/env.js";
import { Game } from "../src/db/models/game.js";
import { Player } from "../src/db/models/player.js";
import { afterCursor } from "../src/lib/cursor.js";
import { LIST_PROJECTION } from "../src/routes/players.js";

const LIMIT = 21; // the route's default page (20) plus the one-row lookahead
const OUT = new URL("../../docs/explain/games-pagination.json", import.meta.url);

const players = process.argv.slice(2).map((arg) => arg.split(":") as ["chesscom" | "lichess", string]);
if (players.length === 0 || players.some(([p, u]) => !["chesscom", "lichess"].includes(p) || !u)) {
  console.error("Usage: npm run explain:games -- <chesscom|lichess>:<username> ...");
  process.exit(1);
}

type Plan = { stage: string; indexName?: string; inputStage?: Plan; inputStages?: Plan[]; queryPlan?: Plan };

// "LIMIT > PROJECTION_SIMPLE > FETCH > IXSCAN(index)" - the shape of the winning plan, top down.
function planShape(plan: Plan): string {
  const node = plan.queryPlan ?? plan; // the slot-based engine nests the classic plan here
  const label = node.indexName ? `${node.stage}(${node.indexName})` : node.stage;
  const children = node.inputStages ?? (node.inputStage ? [node.inputStage] : []);
  if (children.length === 0) return label;
  if (children.length === 1) return `${label} > ${planShape(children[0]!)}`;
  return `${label}[${children.map(planShape).join(" | ")}]`;
}

async function explain(filter: Record<string, unknown>) {
  const result = (await Game.find(filter, LIST_PROJECTION)
    .sort({ playedAt: -1, _id: -1 })
    .limit(LIMIT)
    .explain("executionStats")) as unknown as {
    queryPlanner: { winningPlan: Plan; rejectedPlans: unknown[] };
    executionStats: { nReturned: number; totalKeysExamined: number; totalDocsExamined: number; executionTimeMillis: number };
  };
  const shape = planShape(result.queryPlanner.winningPlan);
  const stats = result.executionStats;
  return {
    plan: shape,
    inMemorySort: /(^|[ >[|])SORT\b/.test(shape),
    nReturned: stats.nReturned,
    keysExamined: stats.totalKeysExamined,
    docsExamined: stats.totalDocsExamined,
    ms: stats.executionTimeMillis,
    rejectedPlans: result.queryPlanner.rejectedPlans.length,
  };
}

const orOnly = ({ playedAt, id }: { playedAt: Date; id: Types.ObjectId }) => ({
  $or: [{ playedAt: { $lt: playedAt } }, { playedAt, _id: { $lt: id } }],
});

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

const report: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  mongoVersion: ((await mongoose.connection.db!.admin().serverInfo()) as { version: string }).version,
  index: "{ playerId: 1, playedAt: -1, _id: -1 }",
  limit: LIMIT,
  players: [] as unknown[],
};

for (const [platform, username] of players) {
  const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1, gamesCount: 1 }).lean();
  if (!player) {
    console.error(`Not found: ${platform}:${username}`);
    continue;
  }
  const base = { playerId: player._id };
  const total = await Game.countDocuments(base);
  // A cursor is the last row of the previous page: pick rows that start a middle and the last page.
  const cursorAt = async (skip: number) => {
    const row = await Game.findOne(base, { playedAt: 1 }).sort({ playedAt: -1, _id: -1 }).skip(skip).lean();
    return { playedAt: row!.playedAt, id: row!._id };
  };
  const pages: Record<string, unknown> = { first: await explain(base) };
  for (const [name, skip] of [
    ["middle", Math.floor(total / 2)],
    ["last", Math.max(0, total - 11)],
  ] as const) {
    const cursor = await cursorAt(skip);
    pages[name] = {
      orOnly: await explain({ ...base, ...orOnly(cursor) }),
      bounded: await explain({ ...base, ...afterCursor(cursor) }),
    };
  }
  const middle = await cursorAt(Math.floor(total / 2));
  pages.middleBlitz = {
    orOnly: await explain({ ...base, speed: "blitz", ...orOnly(middle) }),
    bounded: await explain({ ...base, speed: "blitz", ...afterCursor(middle) }),
  };
  (report.players as unknown[]).push({ player: `${platform}:${username}`, games: total, pages });
  console.log(`${platform}:${username} (${total} games)`);
  console.log(JSON.stringify(pages, null, 2));
}

await mkdir(new URL(".", OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`Wrote ${OUT.pathname}`);
await mongoose.disconnect();
