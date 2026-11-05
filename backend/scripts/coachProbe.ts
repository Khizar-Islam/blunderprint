import { createGeminiModel } from "../src/agent/gemini.js";
import { userInput } from "../src/agent/model.js";
import { buildSystemPrompt, FINAL_PROMPT, TASK_PROMPT } from "../src/agent/prompts.js";
import { REPORT_JSON_SCHEMA } from "../src/agent/schema.js";
import { loadEnv } from "../src/config/env.js";

// ONE real request shaped like the coach's answer phase: no tools, the full report schema as
// structured output, the real system prompt, and a small fake transcript (the investigation's
// results as plain text). It checks that the schema itself isn't what makes Google fail.
//   npm run coach:probe            (the primary model, GEMINI_MODEL)
//   npm run coach:probe -- <model> (another model id)
// Costs one call; it is NOT counted in the app's daily budget.

const env = loadEnv();
if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
const modelId = process.argv[2] ?? env.GEMINI_MODEL;

const FAKE_RESULTS = {
  step: 2,
  result: {
    candidates: [
      {
        id: "phase=endgame|kind=blunder",
        label: "Blunders per 100 moves in the endgame",
        measure: "blunderPer100",
        value: 6,
        baseline: 2,
        gapPct: 200,
        games: 10,
        exampleFilter: { phase: "endgame", kind: "blunder" },
      },
    ],
  },
  examples: {
    step: 3,
    filters: { phase: "endgame", kind: "blunder" },
    examples: [
      { gameId: "000000000000000000000001", ply: 45, moveNumber: 23, played: "Kd2", betterMove: "Ke2", winPctLost: 40 },
      { gameId: "000000000000000000000002", ply: 47, moveNumber: 24, played: "Rc1", betterMove: "Rd1", winPctLost: 35 },
    ],
  },
};

const model = createGeminiModel({ apiKey: env.GEMINI_API_KEY, model: modelId, timeoutMs: env.COACH_CALL_TIMEOUT_MS });
const input = [
  userInput(TASK_PROMPT),
  userInput(`(probe) Tool results from the investigation, as data:\n${JSON.stringify(FAKE_RESULTS)}`),
  userInput(FINAL_PROMPT),
];
console.log(`probe: ${modelId}, answer-shaped (no tools, report schema ${JSON.stringify(REPORT_JSON_SCHEMA).length} chars)`);
const t0 = Date.now();
try {
  const res = await model.call({ system: buildSystemPrompt(), input, responseSchema: REPORT_JSON_SCHEMA, signal: new AbortController().signal });
  const text = res.steps.filter((s) => s.type === "model_output").map((s) => JSON.stringify((s as { content?: unknown }).content ?? "")).join("");
  console.log(`OK status=${res.status} in ${Date.now() - t0} ms, tokens ${res.usage.input} in / ${res.usage.output} out`);
  console.log(`answer starts: ${text.slice(0, 200)}`);
} catch (err) {
  console.log(`FAILED after ${Date.now() - t0} ms: ${err instanceof Error ? `${(err as { kind?: string }).kind ?? ""} ${err.message}` : String(err)}`);
  process.exitCode = 1;
}
