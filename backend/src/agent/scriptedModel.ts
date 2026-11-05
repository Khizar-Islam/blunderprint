import { sleep } from "../lib/sleep.js";
import type { Model, ModelRequest, ModelResponse, Step } from "./model.js";
import { isWithin, type Candidate } from "./tools/candidates.js";

// COACH_MODEL=scripted: a stand-in for Gemini for LOCAL DEVELOPMENT ONLY (env.ts refuses it in
// production). It costs no AI calls, yet the whole chain runs for real: the loop, the real
// tools against the real database, the verifier, the report job, the routes and the SSE trace.
// So the coach page can be built and tried in the browser for free.
//
// It plays the same moves every time, from what the tools really returned:
//   1. asks for get_player_profile + get_weakness_candidates;
//   2. picks up to 3 candidates that don't overlap and asks for each one's examples;
//   3. says it's done; then answers with one pattern per candidate, citing examples from
//      distinct games. The text is fixed, with no numbers or moves, so the verifier passes it.
// A repair request gets the same answer again; the verifier then drops what still fails.

export const SCRIPTED_MODEL_NAME = "scripted";
const MAX_PATTERNS = 3;
const EVIDENCE_PER_PATTERN = 3;

const EXPLANATION =
  "This is a scripted practice report built from your real games, so the coach page can be tried end to end without spending AI calls. The positions below were picked by code from this group of your moves, where you went wrong more often than usual.";
const DRILL = "Set up each position below, cover the move you played, and find a better move before you look at the engine's choice.";

interface ToolOutput {
  name: string;
  step: number;
  result: unknown;
}

// Every tool result the loop has sent back so far, with its step number.
function toolOutputs(request: ModelRequest): ToolOutput[] {
  const out: ToolOutput[] = [];
  for (const s of request.input) {
    if (s.type !== "function_result") continue;
    const r = s as { name?: string; result: { text: string }[] };
    try {
      const payload = JSON.parse(r.result[0]!.text) as { step: number; result?: unknown };
      if (payload.result !== undefined) out.push({ name: r.name ?? "", step: payload.step, result: payload.result });
    } catch {
      // not ours
    }
  }
  return out;
}

// Up to MAX_PATTERNS candidates, strongest first, none inside another.
function pickCandidates(outputs: ToolOutput[]): Candidate[] {
  const found = outputs.find((o) => o.name === "get_weakness_candidates")?.result as { candidates?: Candidate[] } | undefined;
  const picked: Candidate[] = [];
  for (const c of found?.candidates ?? []) {
    if (picked.length >= MAX_PATTERNS) break;
    if (picked.some((p) => isWithin(c.exampleFilter, p.exampleFilter) || isWithin(p.exampleFilter, c.exampleFilter))) continue;
    picked.push(c);
  }
  return picked;
}

const sameFilter = (a: Record<string, unknown>, b: Record<string, unknown>) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};

let callCounter = 0;
const call = (name: string, args: Record<string, unknown>): Step => ({ type: "function_call", id: `scripted_${++callCounter}`, name, arguments: args });
const text = (t: string): Step => ({ type: "model_output", content: [{ type: "text", text: t }] });

function respond(request: ModelRequest, steps: Step[], status: string): ModelResponse {
  // A rough token count (4 characters a token), so the usage numbers look like a real run's.
  const input = Math.ceil((request.system.length + JSON.stringify(request.input).length) / 4);
  const output = Math.ceil(JSON.stringify(steps).length / 4);
  return { status, steps, usage: { input, output, total: input + output } };
}

function investigate(request: ModelRequest): ModelResponse {
  const outputs = toolOutputs(request);
  if (!outputs.some((o) => o.name === "get_weakness_candidates")) {
    return respond(request, [call("get_player_profile", {}), call("get_weakness_candidates", {})], "requires_action");
  }
  const asked = outputs.filter((o) => o.name === "find_example_mistakes");
  if (asked.length === 0) {
    const calls = pickCandidates(outputs).map((c) => call("find_example_mistakes", { filters: c.exampleFilter, limit: 5 }));
    if (calls.length) return respond(request, calls, "requires_action");
  }
  return respond(request, [text("I have what I need.")], "completed");
}

function answer(request: ModelRequest): ModelResponse {
  const outputs = toolOutputs(request);
  const used = new Set<string>();
  const patterns = [];
  for (const c of pickCandidates(outputs)) {
    const examples = outputs.find(
      (o) => o.name === "find_example_mistakes" && sameFilter(((o.result as { filters?: Record<string, unknown> }).filters ?? {}), c.exampleFilter),
    );
    if (!examples) continue;
    const rows = (examples.result as { examples?: { gameId: string; ply: number }[] }).examples ?? [];
    const games = new Set<string>();
    const evidence = [];
    for (const e of rows) {
      const key = `${e.gameId}:${e.ply}`;
      if (games.has(e.gameId) || used.has(key)) continue;
      games.add(e.gameId);
      evidence.push({ gameId: e.gameId, ply: e.ply });
      if (evidence.length >= EVIDENCE_PER_PATTERN) break;
    }
    if (evidence.length < 2) continue;
    for (const e of evidence) used.add(`${e.gameId}:${e.ply}`);
    patterns.push({ candidateId: c.id, explanation: EXPLANATION, evidenceStep: examples.step, evidence, drill: DRILL });
  }
  const report = patterns.length ? { patterns } : { patterns, notEnoughData: "Scripted model: no candidate had examples from two games." };
  return respond(request, [text(JSON.stringify(report))], "completed");
}

// delayMs: a pause per call, so the live trace ticks in like a real run's.
export function createScriptedModel({ delayMs = 600 }: { delayMs?: number } = {}): Model {
  return {
    name: SCRIPTED_MODEL_NAME,
    async call(request) {
      if (delayMs > 0) await sleep(delayMs, request.signal);
      return request.tools?.length ? investigate(request) : answer(request);
    },
  };
}
