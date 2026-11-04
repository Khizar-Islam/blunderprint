// Runs every coach tool (src/agent/tools) against the real database for one player and prints
// each result's size, plus the full JSON of the ones named in --full. Read-only.
//   npm run coach:tools                                   (lichess:DrNykterstein)
//   npm run coach:tools -- chesscom:gothamchess
//   npm run coach:tools -- lichess:DrNykterstein --full=all
//
// The size is what the model would receive. ~4 characters a token, so the 8,000-character
// budget per result is ~2k tokens.
import mongoose from "mongoose";
import type { AgentContext } from "../src/agent/context.js";
import { GROUP_BY } from "../src/agent/tools/mistakes.js";
import { MAX_RESULT_CHARS, runTool } from "../src/agent/tools/index.js";
import { loadEnv } from "../src/config/env.js";
import { Player, type Platform } from "../src/db/models/player.js";

const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const fullArg = process.argv.find((a) => a.startsWith("--full="))?.slice("--full=".length);
const [platform, username] = (positional[0] ?? "lichess:DrNykterstein").split(":") as [Platform, string];
// By default the profile and the weakness candidates are printed in full.
const full = new Set((fullArg ?? "get_player_profile,get_weakness_candidates").split(","));

const env = loadEnv();
await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });

const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1, username: 1 }).lean();
if (!player) throw new Error(`No player ${platform}:${username}`);
const ctx: AgentContext = { playerId: player._id, platform };

const calls: { label: string; name: string; args: unknown }[] = [
  { label: "get_player_profile", name: "get_player_profile", args: {} },
  { label: "get_weakness_candidates", name: "get_weakness_candidates", args: {} },
  { label: "get_opening_breakdown", name: "get_opening_breakdown", args: {} },
  ...GROUP_BY.map((g) => ({ label: `get_mistake_breakdown:${g}`, name: "get_mistake_breakdown", args: { groupBy: g } })),
  { label: "find_example_mistakes", name: "find_example_mistakes", args: { limit: 5 } },
];

console.log(`${platform}:${player.username}  (budget ${MAX_RESULT_CHARS} chars ≈ 2k tokens per result)\n`);
const printed: { label: string; data: unknown }[] = [];
let exampleGame: string | undefined;

async function run(label: string, name: string, args: unknown) {
  const started = performance.now();
  const r = await runTool(ctx, name, args);
  const ms = Math.round(performance.now() - started);
  if (!r.ok) {
    console.log(`${label.padEnd(36)} ERROR ${r.error}`);
    return;
  }
  console.log(`${label.padEnd(36)} ${String(r.chars).padStart(5)} chars  ~${String(Math.ceil(r.chars / 4)).padStart(4)} tokens  ${String(ms).padStart(4)} ms  ${r.chars <= MAX_RESULT_CHARS ? "ok" : "OVER BUDGET"}`);
  if (full.has("all") || full.has(label)) printed.push({ label, data: r.data });
  if (name === "find_example_mistakes") exampleGame = (r.data as { examples: { gameId: string }[] }).examples[0]?.gameId;
}

for (const c of calls) await run(c.label, c.name, c.args);
// The game summary for the worst example found above.
if (exampleGame) await run("get_game_summary", "get_game_summary", { gameId: exampleGame });

for (const p of printed) console.log(`\n--- ${p.label} ---\n${JSON.stringify(p.data, null, 2)}`);

await mongoose.disconnect();
