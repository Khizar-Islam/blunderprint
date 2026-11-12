// One read-only look at the live system (Stage 6 chunk D). Run from backend/ (Windows cmd):
//   npm run ops:status -- https://<the API's address>
//   (or set OPS_API_URL; without an address the live API isn't asked, only the database)
//
// Prints: today's AI budget (used, left, reset time), storage against the new-player gate and
// Atlas's 512 MB, the job queue and failures, coach runs, whether the demo player's suggested
// questions are still answered, how many visitors are at a limit today, and the live deploy.
// Only READS: the database from backend/.env (find, count, aggregate, dbStats) and two kinds of
// GET on the live API (/api/health, and GET /report for each demo player, which writes nothing
// for a frozen demo player). Never prints the connection string, a key, a token or a visitor hash.
// Asking the live API wakes Render if it's asleep (up to about a minute).
import mongoose from "mongoose";
import { staleDemoAnswers } from "../src/agent/suggestions.js";
import { loadEnv } from "../src/config/env.js";
import { collectDbStatus, fetchLive, formatStatus, type StatusLimits } from "../src/ops/status.js";

const env = loadEnv();
const apiBase = process.argv[2] ?? process.env.OPS_API_URL ?? "";
if (apiBase && !/^https?:\/\/[^/\s]+\/?$/.test(apiBase)) {
  console.error("usage: npm run ops:status -- https://<api address>   (the address only, no path)");
  process.exit(2);
}
// The demo players from DEMO_PLAYERS, or the landing page's demo player when it isn't set
// locally (it usually isn't: CLAUDE.md §17).
const demoPlayers = env.demoPlayers.length ? env.demoPlayers : ["lichess:drnykterstein"];

const limits: StatusLimits = {
  aiDailyCalls: env.AI_DAILY_CALL_BUDGET,
  askMinRequests: env.ASK_MAX_REQUESTS,
  reportMinRequests: env.COACH_MAX_REQUESTS,
  storageGateMb: env.STORAGE_NEW_PLAYER_LIMIT_MB,
  atlasMb: 512,
  importsPerHour: env.LIMIT_IMPORTS_PER_HOUR,
  importsPerDay: env.LIMIT_IMPORTS_PER_DAY,
  reportsPerDay: env.LIMIT_REPORTS_PER_DAY,
  asksPerHour: env.LIMIT_ASKS_PER_HOUR,
  asksPerDay: env.LIMIT_ASKS_PER_DAY,
  newPlayersPerDay: env.NEW_PLAYERS_PER_DAY,
};

const clock = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) + " your time";

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 15_000 });
try {
  const [db, live] = await Promise.all([collectDbStatus(limits), apiBase ? fetchLive(apiBase, demoPlayers) : Promise.resolve(null)]);
  // The live API knows Render's model; only when it couldn't say, check locally (and say so).
  const liveKnows = !!live?.demo.some((d) => d.unanswered);
  const localStale = liveKnows ? null : { model: env.GEMINI_MODEL, stale: await staleDemoAnswers(demoPlayers, env.GEMINI_MODEL) };
  console.log(formatStatus(db, live, { limits, localStale, clock }).join("\n"));
} finally {
  await mongoose.disconnect();
}
