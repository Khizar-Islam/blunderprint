// Pre-answers the demo player's suggested questions (Stage 6 chunk C), so a visitor's click on a
// chip is answered at once from the cache, with no AI call. Run from backend/ (Windows cmd):
//   set DEMO_PLAYERS=lichess:DrNykterstein&& npm run demo:answers
//   (or name the player: npm run demo:answers -- lichess DrNykterstein; it must be in DEMO_PLAYERS)
//   npm run demo:answers -- --force     answers ALL the chips again, also the ones with a current
//                                       answer, and replaces those answers (after a change to how
//                                       answers are checked or worded that didn't bump the prompt
//                                       version). Prints each answer it replaced. Demo players only,
//                                       like the rest of this script.
//   npm run demo:answers -- --force --question "Why do I lose so many games in time trouble?"
//                                       ONE chip only (its exact text); the others are untouched.
//
// Uses the REAL model, the live database from backend/.env and the shared daily budget: up to
// ASK_MAX_REQUESTS (10) requests per question that isn't answered yet; already answered ones are
// just kept (free). Each question runs through the real job path (agent/demoAnswers.ts): this
// script's worker claims only the jobs it enqueued itself and never reaps, so visitors' queued
// jobs are left alone. The answers and their runs are kept with no expiry.
//
// RE-RUN after every ASK_PROMPT_VERSION bump or GEMINI_MODEL change (the cache key includes both),
// then update DEMO_ANSWERS_PROMPT_VERSION (agent/suggestions.ts). The API's startup log warns
// "demo_answers_stale" until it's done. Never prints the API key, a token or the connection string.
import mongoose from "mongoose";
import { PROMPT_VERSION } from "../src/agent/prompts.js";
import { analysedBasis } from "../src/agent/basis.js";
import { createCoachRuntime } from "../src/agent/coach.js";
import { preAnswer } from "../src/agent/demoAnswers.js";
import { syncAnswerExpiry, syncRunExpiry } from "../src/agent/runExpiry.js";
import { SUGGESTED_QUESTIONS, suggestionsFor } from "../src/agent/suggestions.js";
import { loadEnv } from "../src/config/env.js";
import { Answer } from "../src/db/models/answer.js";
import { Game } from "../src/db/models/game.js";
import { Player, PLATFORMS, type Platform } from "../src/db/models/player.js";
import { Report } from "../src/db/models/report.js";
import { createQueue } from "../src/jobs/queue.js";
import { demoKeyParts } from "../src/lib/demo.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const env = loadEnv();
const USAGE = 'usage: npm run demo:answers [-- [--force] [--question "<exact chip text>"] [<lichess|chesscom> <username>]]';
const args = process.argv.slice(2);
let force = false;
let onlyQuestion: string | undefined;
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--force") force = true;
  else if (a === "--question") {
    onlyQuestion = args[++i];
    if (onlyQuestion === undefined) fail(`--question needs the chip's text. ${USAGE}`);
  } else if (a.startsWith("-")) fail(`Unknown option ${a}. ${USAGE}`);
  else positional.push(a);
}
// Only a chip can be pre-answered: any other text would be a typed question, not a demo answer.
const CHIPS: readonly string[] = SUGGESTED_QUESTIONS;
if (onlyQuestion !== undefined && !CHIPS.includes(onlyQuestion)) {
  fail(`--question must be one of the chips, exactly:\n${SUGGESTED_QUESTIONS.map((q) => `  "${q}"`).join("\n")}`);
}
const questions: readonly string[] = onlyQuestion !== undefined ? [onlyQuestion] : CHIPS;
const [argPlatform, argUser] = positional;
let key: string;
if (argPlatform || argUser) {
  if (!argPlatform || !argUser || !PLATFORMS.includes(argPlatform as Platform)) fail("usage: npm run demo:answers [-- <lichess|chesscom> <username>]");
  key = `${argPlatform}:${argUser.toLowerCase()}`;
} else {
  if (env.demoPlayers.length !== 1) fail(`Name the player: DEMO_PLAYERS has ${env.demoPlayers.length} entries.`);
  key = env.demoPlayers[0]!;
}
// The final syncRunExpiry uses DEMO_PLAYERS: a player outside it would have its kept runs dated again.
if (!env.demoPlayers.includes(key)) fail(`${key} isn't in DEMO_PLAYERS. Set it for this command: set DEMO_PLAYERS=${key}&& npm run demo:answers`);

// Always the real model here, whatever COACH_MODEL says: that's what this script is for.
const coach = createCoachRuntime({ ...env, COACH_MODEL: "gemini" });
if (!coach.available) fail("The coach isn't available: AI_ENABLED is false or GEMINI_API_KEY is not set.");

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
let exitCode = 0;
try {
  const player = await Player.findOne(demoKeyParts(key), { _id: 1, platform: 1, username: 1 }).lean();
  if (!player) throw new Error(`No stored player ${key}.`);

  // The same bar as snapshot:demo: the demo must be complete before its answers are written.
  const notAnalysed = await Game.countDocuments({ playerId: player._id, "analysis.status": { $in: ["pending", "claimed"] } });
  if (notAnalysed) throw new Error(`${notAnalysed} of the player's games aren't analysed yet.`);
  const basis = await analysedBasis(player._id);
  const report = await Report.exists({ playerId: player._id, analysedGamesHash: basis.hash, promptVersion: PROMPT_VERSION, model: coach.modelName });
  if (!report) throw new Error("The player has no current coach report for this model and prompt: refresh it first.");

  const suggestions = await suggestionsFor(player._id, basis.hash, coach.modelName);
  const chosen = suggestions.filter((s) => questions.includes(s.question));
  const toAsk = force ? chosen.length : chosen.filter((s) => !s.answered).length;
  const before = await coach.budget.remaining();
  const needed = toAsk * coach.askLimits.maxRequests;
  console.log(`demo:answers${force ? " --force" : ""} ${player.platform}:${player.username}  model ${coach.modelName}  ${basis.analysed} analysed games`);
  for (const s of suggestions) {
    const plan = !questions.includes(s.question) ? "untouched " : force ? (s.answered ? "to replace" : "to ask    ") : s.answered ? "answered  " : "to ask    ";
    console.log(`  ${plan} ${s.question}`);
  }
  console.log(`budget left today: ${before}; worst case for ${toAsk} question(s): ${needed}\n`);
  if (before < needed) throw new Error(`Not enough budget left today (${before} < ${needed}).`);

  const results = await preAnswer({
    queue: createQueue(),
    coach,
    playerId: player._id,
    questions,
    force,
    onRunStarted: (q, runId) => console.log(`started: ${JSON.stringify(q)} (run ${runId})`),
  });

  // Keep the runs behind the kept answers (and the demo report's), date any stray ones.
  const runs = await syncRunExpiry(env.demoPlayers);
  const answers = await syncAnswerExpiry(env.demoPlayers);

  console.log("\n--- results ---");
  for (const r of results) {
    console.log(`${r.status.padEnd(10)} ${r.question}${r.ownJob === false ? "  (joined a visitor's run of the same question)" : ""}`);
    if (r.error) console.log(`           shown to visitors: [${r.error.code}] ${r.error.message}`);
    if (r.previous) {
      console.log(`           ${r.status === "done" ? "replaced" : "NOT replaced, still stored"} (answer ${r.previous.answerId}, run ${r.previous.runId}):`);
      for (const s of r.previous.sentences) console.log(`             - ${s}`);
      if (r.status === "done") console.log("           now:");
    }
    if (!r.answerId) continue;
    const a = await Answer.findById(r.answerId).lean();
    if (!a) continue;
    if (a.outcome === "cannot_answer") {
      console.log(`           cannot_answer (${a.reason})`);
      continue;
    }
    const slots = (a.slots ?? {}) as Record<string, { text: string }>;
    for (const s of a.sentences) console.log(`           ${s.replace(/\{\{(\w+)\}\}/g, (_, n: string) => `[${slots[n]?.text ?? "?"}]`)}`);
    for (const e of a.evidence) console.log(`           cites move ${e.moveNumber}: ${e.played} (better ${e.betterMove ?? "?"}), ${e.winPctLost} win-chance points`);
    if (a.removed?.length) console.log(`           changed or removed by code: ${a.removed.join("; ")}`);
    console.log(`           ${a.evidence.length} evidence position(s); expiresAt ${a.expiresAt ? "SET (not kept!)" : "none (kept)"}`);
    if (a.expiresAt || r.status === "unfinished") exitCode = 1;
  }
  if (results.some((r) => r.status !== "cached" && r.status !== "done")) exitCode = 1;
  const after = await coach.budget.remaining();
  console.log(`\nbudget ${before} → ${after} (${before - after} requests)  runs kept: ${runs.kept}, dated: ${runs.dated}; answers dated: ${answers.dated}`);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  exitCode = 1;
} finally {
  await mongoose.disconnect();
}
process.exit(exitCode);
