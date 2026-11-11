// Runs ONE "Ask the coach" question against the real model, from your local backend/.env:
// real Gemini (with the fallback), the real tools on the real database, the shared daily budget
// (global:ai, every request counts), the pacer, the ask limits and the verifier. Prints the trace
// as it happens, then the answer the way the page will show it.
//   npm run ask -- lichess DrNykterstein "Which piece do I blunder most?"
//
// Spends up to ASK_MAX_REQUESTS (10) requests of today's budget. Writes nothing to the database
// except the budget counter: no agent run, no job, no cached answer (so a later real question
// isn't served from a test run). Never prints the API key, a token or the connection string.
import mongoose from "mongoose";
import { askTask, CANNOT_ANSWER_MESSAGES, type VerifiedAnswer } from "../src/agent/ask.js";
import { createCoachRuntime } from "../src/agent/coach.js";
import { friendlyFromAgent } from "../src/agent/friendly.js";
import { runTask } from "../src/agent/loop.js";
import { fillSentence } from "../src/agent/slots.js";
import { loadEnv } from "../src/config/env.js";
import { Player, PLATFORMS, type Platform } from "../src/db/models/player.js";

const [platform, username, question] = process.argv.slice(2) as [Platform, string, string];
if (!platform || !username || !question || !PLATFORMS.includes(platform)) {
  console.error('usage: npm run ask -- <lichess|chesscom> <username> "<question>"');
  process.exit(2);
}

const env = loadEnv();
// Always the real model here, whatever COACH_MODEL says: that's what this script is for.
const coach = createCoachRuntime({ ...env, COACH_MODEL: "gemini" });
if (!coach.available) {
  console.error("The coach isn't available: AI_ENABLED is false or GEMINI_API_KEY is not set.");
  process.exit(1);
}

await mongoose.connect(env.MONGODB_URI, { serverSelectionTimeoutMS: 10_000 });
try {
  const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1, username: 1, platform: 1 }).lean();
  if (!player) throw new Error(`No player ${platform}:${username}`);

  // The same budget check POST /ask makes.
  const before = await coach.budget.remaining();
  if (before < coach.askLimits.maxRequests) throw new Error(`Only ${before} requests left in today's budget; a question needs ${coach.askLimits.maxRequests}.`);

  const l = coach.askLimits;
  console.log(`ask: ${platform}:${player.username}  question: ${JSON.stringify(question)}`);
  console.log(`limits: ${l.maxCalls} + ${l.maxRepairCalls} repair calls, ${l.maxRequests} requests, ${l.runTimeoutMs / 1000} s; budget left today: ${before}\n`);

  const ctx = { playerId: player._id, platform: player.platform, rules: coach.rules };
  const started = Date.now();
  const result = await runTask({
    ctx,
    task: askTask(ctx, question),
    model: coach.model,
    ...(coach.fallback ? { fallback: coach.fallback } : {}),
    pacer: coach.pacer,
    limits: l,
    onStep: (s) => {
      const at = ((Date.now() - started) / 1000).toFixed(1).padStart(5);
      const tokens = s.tokens !== undefined ? `  ${s.tokens} tok` : "";
      console.log(`${at}s  #${String(s.n).padStart(2)} ${s.kind.padEnd(6)} ${s.label}  →  ${s.detail}  (${s.ms} ms${tokens})`);
    },
  });
  const wallS = ((Date.now() - started) / 1000).toFixed(1);
  const after = await coach.budget.remaining();
  const modelCalls = result.trace.filter((s) => s.kind === "model" && s.tokens !== undefined).length;

  console.log(`\nstatus: ${result.status}`);
  if (result.status === "failed") {
    const f = friendlyFromAgent(result.error, { resetsInMs: coach.budget.resetsInMs() });
    console.log(`shown to the visitor: [${f.code}] ${f.message}`);
    console.log(`(logs: ${result.error?.code}${result.error?.phase ? ` in ${result.error.phase}` : ""}: ${result.error?.message})`);
  }
  const a = result.output as VerifiedAnswer | undefined;
  if (a) {
    console.log("\n--- what the page shows ---");
    if (a.outcome === "cannot_answer") {
      console.log(`cannot_answer (${a.reason}): ${CANNOT_ANSWER_MESSAGES[a.reason!]}`);
    } else {
      const slots = new Map(Object.entries(a.slots));
      for (const s of a.sentences) console.log(`  ${fillSentence(s, slots)}`);
      for (const [name, s] of slots) console.log(`  slot {{${name}}} = "${s.text}" (${s.kind}, raw ${s.value}, step ${s.step} ${s.path})`);
      for (const e of a.evidence) {
        console.log(`  evidence: game ${e.gameId} ply ${e.ply} (move ${e.moveNumber}): played ${e.played}, better ${e.betterMove ?? "?"}, ${e.kind}, -${e.winPctLost} win %, ${e.facts.phase}, ${e.facts.speed}`);
      }
    }
    const repaired = result.trace.some((s) => s.kind === "repair");
    console.log(`\nrepair round: ${repaired ? "yes" : "no"}`);
    for (const s of result.trace.filter((t) => t.kind === "verify" || t.kind === "repair")) console.log(`  ${s.kind}: ${s.detail}`);
    if (a.removed.length) {
      console.log("removed by the final check:");
      for (const r of a.removed) console.log(`  - ${r}`);
    }
  }
  console.log(
    `\nmodel calls: ${modelCalls}  requests: ${result.usage.calls} (budget ${before} → ${after})  tokens: ${result.usage.totalTokens}  wall time: ${wallS} s${result.answerModel && result.answerModel !== coach.modelName ? "  (answered by the fallback)" : ""}`,
  );
} finally {
  await mongoose.disconnect();
}
