// Runs the real coach agent (Gemini + the tools + the verifier) on one player and prints the
// trace as it happens, then the verified report. Spends real model calls: at most
// COACH_MAX_MODEL_CALLS + COACH_MAX_REPAIR_CALLS (10 + 2) per run. Reads the database only.
//   npm run coach:cli                         (lichess:DrNykterstein)
//   npm run coach:cli -- chesscom:someone
import mongoose from "mongoose";
import { createGeminiModel } from "../src/agent/gemini.js";
import { runAgent } from "../src/agent/loop.js";
import { createPacer } from "../src/agent/pacer.js";
import { PROMPT_VERSION } from "../src/agent/prompts.js";
import { loadEnv } from "../src/config/env.js";
import { Player, type Platform } from "../src/db/models/player.js";

const [platform, username] = (process.argv[2] ?? "lichess:DrNykterstein").split(":") as [Platform, string];
const env = loadEnv();
if (!env.AI_ENABLED) throw new Error("AI_ENABLED is false");
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1, username: 1 }).lean();
if (!player) throw new Error(`No player ${platform}:${username}`);

const limits = {
  maxCalls: env.COACH_MAX_MODEL_CALLS,
  maxRepairCalls: env.COACH_MAX_REPAIR_CALLS,
  maxTokens: env.COACH_MAX_TOKENS,
  runTimeoutMs: env.COACH_RUN_TIMEOUT_MS,
};
// What counts as a weakness (get_weakness_candidates), from env.
const rules = { minGap: env.COACH_MIN_BASELINE_GAP, minGames: env.COACH_MIN_CANDIDATE_GAMES, minMoves: env.COACH_MIN_CANDIDATE_MOVES };
console.log(`coach run: ${platform}:${player.username}  model ${env.GEMINI_MODEL}  prompt v${PROMPT_VERSION}`);
console.log(
  `limits: ${limits.maxCalls} + ${limits.maxRepairCalls} repair calls, ${limits.maxTokens} tokens, ${limits.runTimeoutMs / 1000} s; pacing ${env.GEMINI_RPM} RPM / ${env.GEMINI_TPM} TPM; weakness = ${Math.round(rules.minGap * 100)}% worse than own average on ${rules.minGames}+ games / ${rules.minMoves}+ moves\n`,
);

const started = Date.now();
const result = await runAgent({
  ctx: { playerId: player._id, platform, rules },
  model: createGeminiModel({ apiKey: env.GEMINI_API_KEY, model: env.GEMINI_MODEL, timeoutMs: env.COACH_CALL_TIMEOUT_MS }),
  pacer: createPacer({ rpm: env.GEMINI_RPM, tpm: env.GEMINI_TPM }),
  limits,
  onStep: (s) => {
    const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
    const tokens = s.tokens !== undefined ? `  ${s.tokens} tok` : "";
    console.log(`${at}s  #${String(s.n).padStart(2)} ${s.kind.padEnd(6)} ${s.label}  →  ${s.detail}  (${s.ms} ms${tokens})`);
  },
});

console.log(`\nstatus: ${result.status}${result.error ? `  error: ${result.error.code}: ${result.error.message}` : ""}`);
console.log(
  `calls: ${result.usage.calls}  tokens: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out / ${result.usage.totalTokens} total  time: ${(result.durationMs / 1000).toFixed(1)} s`,
);
if (result.report) {
  console.log(`patterns kept: ${result.report.patterns.length}  dropped: ${result.report.dropped.length}  trimmed: ${result.report.trimmed.length}`);
  console.log("\n--- verified report ---");
  console.log(JSON.stringify(result.report, null, 2));
}

await mongoose.disconnect();
