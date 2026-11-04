import { sleep as realSleep, type Sleep } from "../lib/sleep.js";
import type { AgentContext } from "./context.js";
import { functionCallsOf, ModelError, textOf, userInput, type Model, type ModelResponse, type Step } from "./model.js";
import type { Pacer } from "./pacer.js";
import { buildSystemPrompt, FINAL_PROMPT, FORMAT_RETRY_PROMPT, repairPrompt, TASK_PROMPT } from "./prompts.js";
import { parseReport, REPORT_JSON_SCHEMA, type DraftReport } from "./schema.js";
import { declaredTools, runTool, summarizeResult } from "./tools/index.js";
import { verifyReport, type DroppedPattern, type ToolLog, type VerifiedPattern } from "./verifier.js";

// The coach agent (CLAUDE.md §10). One run, in two phases plus a check:
//
//   1. Investigate (tools, no structured output): call the model with the tools; run every
//      tool it asks for; send the results back; repeat until it says it's done or the turns
//      run out.
//   2. Answer (structured output, no tools): one call asks for the JSON report. If it can't be
//      read, one more call asks for just the JSON.
//      Why two phases: Google offers tools and structured output in the same request only as a
//      Preview feature, and the first real run timed out twice with both in one request (the
//      same request answered in 2 s later, so the cause was intermittent). Separate phases use
//      only stable features, at the cost of about one extra call per report.
//   3. Verify (verifier.ts). If anything fails, ONE repair round: the model hears exactly what
//      failed and answers again (no tools: it already has every result). The repaired report
//      is verified again, and what still fails is dropped or trimmed.
//
// Limits: maxCalls model calls for 1-2 (two of them kept back for the answer), maxRepairCalls
// more for 3, a total token budget, a per-call timeout (in the model) and a deadline for the
// whole run. Every model call waits for the process-wide pacer first (pacer.ts).

export interface AgentLimits {
  maxCalls: number;
  maxRepairCalls: number;
  maxTokens: number;
  runTimeoutMs: number;
}

export type TraceKind = "model" | "tool" | "verify" | "repair" | "retry";

// One line of the live "agent trace" the coach page shows.
export interface TraceStep {
  n: number;
  kind: TraceKind;
  label: string; // "get_mistake_breakdown(groupBy: phase)", "gemini-3.5-flash-lite"
  detail: string; // "3 rows by phase", "asked for 2 tools", "1 issue"
  ms: number;
  tokens?: number;
}

export type StopCode = "time_limit" | "token_limit" | "call_limit" | "model_error" | "no_answer" | "aborted";

export interface AgentReport {
  patterns: VerifiedPattern[];
  notEnoughData?: string;
  dropped: DroppedPattern[];
  trimmed: DroppedPattern[];
}

export interface AgentResult {
  status: "done" | "failed";
  report?: AgentReport;
  error?: { code: StopCode; message: string };
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  trace: TraceStep[];
}

export interface RunAgentOptions {
  ctx: AgentContext;
  model: Model;
  pacer: Pacer;
  limits: AgentLimits;
  signal?: AbortSignal;
  onStep?: (step: TraceStep) => void;
  now?: () => number;
  sleep?: Sleep;
}

class StopRun extends Error {
  constructor(
    readonly code: StopCode,
    message: string,
  ) {
    super(message);
  }
}

// Retries inside one logical call: 429s wait (Google's delay when it gives one), a timeout or a
// server/network error gets one more try. Each retry is a real request and counts as a call.
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_TRANSIENT_RETRIES = 1;
const BACKOFF_BASE_MS = 5_000;
// Room for the answer when estimating whether the next call fits the token budget.
const OUTPUT_RESERVE_TOKENS = 2_000;

// "groupBy: phase, filters: {color: white}" from { groupBy: "phase", filters: { color: "white" } }.
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object" || Object.keys(args).length === 0) return "";
  const text = JSON.stringify(args)
    .replace(/^\{|\}$/g, "")
    .replace(/"([^"]+)":/g, "$1: ")
    .replace(/"/g, "")
    .replace(/,/g, ", ");
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { ctx, model, pacer, limits, onStep } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const started = now();
  const deadline = started + limits.runTimeoutMs;
  const outer = opts.signal ?? new AbortController().signal;

  const tools = declaredTools();
  // The weakness rules (gap, minimum sample) come with the player's context, so the prompt and
  // the candidate scan always state the same ones.
  const SYSTEM_PROMPT = buildSystemPrompt(ctx.rules);
  const input: Step[] = [userInput(TASK_PROMPT)];
  const log: ToolLog = new Map();
  const trace: TraceStep[] = [];
  const usage = { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  let toolSteps = 0;

  const emit = (step: Omit<TraceStep, "n">) => {
    const full = { n: trace.length + 1, ...step };
    trace.push(full);
    onStep?.(full);
  };
  const checkAborted = () => {
    if (outer.aborted) throw new StopRun("aborted", "The run was stopped.");
    if (now() > deadline) throw new StopRun("time_limit", `The run passed its ${Math.round(limits.runTimeoutMs / 1000)} s limit.`);
  };
  const estimateTokens = (withTools: boolean) =>
    Math.ceil((SYSTEM_PROMPT.length + JSON.stringify(input).length + (withTools ? JSON.stringify(tools).length : 0)) / 4) + OUTPUT_RESERVE_TOKENS;

  // One logical model call, with its retries. Investigation calls offer the tools; answer calls
  // ask for the report schema instead. `budget` is the phase's call allowance.
  async function callModel(phase: "investigate" | "answer", budget: { used: number; max: number }): Promise<ModelResponse> {
    const withTools = phase === "investigate";
    let rateLimited = 0;
    let transient = 0;
    for (;;) {
      checkAborted();
      if (budget.used >= budget.max) throw new StopRun("call_limit", `Used all ${budget.max} model calls for this part of the run.`);
      const estimate = estimateTokens(withTools);
      if (usage.totalTokens + estimate > limits.maxTokens) {
        throw new StopRun("token_limit", `The next call would pass the ${limits.maxTokens}-token budget.`);
      }

      const slot = await pacer.acquire(estimate, outer).catch((err) => {
        throw outer.aborted ? new StopRun("aborted", "The run was stopped.") : err;
      });
      checkAborted();
      budget.used++;
      usage.calls++;
      const t0 = now();
      // The run's deadline also cuts a call short; the model adds its own per-call timeout.
      const callSignal = AbortSignal.any([outer, AbortSignal.timeout(Math.max(1, deadline - now()))]);
      try {
        const res = await model.call({
          system: SYSTEM_PROMPT,
          input,
          ...(withTools ? { tools } : { responseSchema: REPORT_JSON_SCHEMA }),
          signal: callSignal,
        });
        slot.settle(res.usage.total);
        usage.inputTokens += res.usage.input;
        usage.outputTokens += res.usage.output;
        usage.totalTokens += res.usage.total;
        const asked = functionCallsOf(res.steps).map((c) => c.name);
        emit({
          kind: "model",
          label: model.name,
          detail: asked.length ? `asked for ${asked.join(", ")}` : withTools ? "done investigating" : "wrote the report",
          ms: now() - t0,
          tokens: res.usage.total,
        });
        return res;
      } catch (err) {
        if (outer.aborted) throw new StopRun("aborted", "The run was stopped.");
        if (!(err instanceof ModelError)) {
          if (now() > deadline) throw new StopRun("time_limit", `The run passed its ${Math.round(limits.runTimeoutMs / 1000)} s limit.`);
          throw err;
        }
        if (err.kind === "rate_limited" && rateLimited < MAX_RATE_LIMIT_RETRIES) {
          rateLimited++;
          const wait = err.details.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (rateLimited - 1);
          if (now() + wait > deadline) throw new StopRun("time_limit", `Rate limited, and the wait (${Math.round(wait / 1000)} s) would pass the run's limit.`);
          pacer.backoff(wait);
          emit({ kind: "retry", label: model.name, detail: `rate limited: waiting ${Math.round(wait / 1000)} s`, ms: now() - t0 });
          continue;
        }
        if ((err.kind === "timeout" || err.kind === "server" || err.kind === "network") && transient < MAX_TRANSIENT_RETRIES) {
          transient++;
          emit({ kind: "retry", label: model.name, detail: `${err.kind}: trying once more`, ms: now() - t0 });
          await sleep(1_000, outer).catch(() => undefined);
          continue;
        }
        throw new StopRun("model_error", err.message);
      }
    }
  }

  // Runs the tools the model asked for and appends their results to the conversation. Each
  // result carries its step number, which the report's statistics cite (stat.sourceStep).
  async function runToolCalls(res: ModelResponse): Promise<void> {
    for (const call of functionCallsOf(res.steps)) {
      checkAborted();
      const step = ++toolSteps;
      const t0 = now();
      const r = await runTool(ctx, call.name, call.arguments);
      log.set(step, r.ok ? { ok: true, tool: call.name, data: r.data } : { ok: false, tool: call.name });
      const payload = r.ok ? { step, result: r.data } : { step, error: r.error };
      input.push({
        type: "function_result",
        call_id: call.id,
        name: call.name,
        result: [{ type: "text", text: JSON.stringify(payload) }],
        ...(r.ok ? {} : { is_error: true }),
      });
      emit({
        kind: "tool",
        label: `${call.name}(${summarizeArgs(call.arguments)})`,
        detail: r.ok ? summarizeResult(call.name, r.data) : `error: ${r.error}`,
        ms: now() - t0,
      });
    }
  }

  // Phase 1: tools until the model says it's done, keeping `reserve` calls back for the answer.
  // Stops early when the turns run out or one more round wouldn't leave tokens for the answer.
  async function investigate(budget: { used: number; max: number }, reserve: number): Promise<void> {
    for (;;) {
      if (budget.max - budget.used <= reserve) return;
      if (usage.totalTokens + 2 * estimateTokens(true) > limits.maxTokens) return;
      const res = await callModel("investigate", budget);
      input.push(...res.steps);
      if (functionCallsOf(res.steps).length === 0) return;
      await runToolCalls(res);
    }
  }

  // Phase 2: `prompt`, then one answer call for the JSON report. If it can't be read and the
  // budget allows, one more call asking for just the JSON.
  async function answerWithReport(budget: { used: number; max: number }, prompt: string): Promise<DraftReport | null> {
    input.push(userInput(prompt));
    let res = await callModel("answer", budget);
    input.push(...res.steps);
    let parsed = parseReport(textOf(res.steps));
    if (!parsed.ok && budget.max - budget.used >= 1) {
      input.push(userInput(FORMAT_RETRY_PROMPT(parsed.error)));
      res = await callModel("answer", budget);
      input.push(...res.steps);
      parsed = parseReport(textOf(res.steps));
    }
    if (parsed.ok) return parsed.report;
    emit({ kind: "model", label: model.name, detail: `no usable report: ${parsed.error}`, ms: 0 });
    return null;
  }

  try {
    const mainBudget = { used: 0, max: limits.maxCalls };
    // Two calls kept back: the answer, and one format retry if it's needed.
    await investigate(mainBudget, 2);
    const draft = await answerWithReport(mainBudget, FINAL_PROMPT);
    if (!draft) throw new StopRun("no_answer", "The model didn't produce a usable report.");

    // Verify; one repair round if anything failed.
    let t0 = now();
    const first = await verifyReport(ctx, draft, log, { final: false });
    emit({
      kind: "verify",
      label: "verifier",
      detail: first.issues.length
        ? `${draft.patterns.length} patterns, ${first.issues.length} issue${first.issues.length === 1 ? "" : "s"}`
        : `${draft.patterns.length} patterns, all checks passed`,
      ms: now() - t0,
    });

    let finalDraft = draft;
    if (first.issues.length > 0 && limits.maxRepairCalls > 0) {
      emit({ kind: "repair", label: "repair round", detail: first.issues.map((i) => `#${i.pattern + 1}: ${i.problem}`).join("; ").slice(0, 300), ms: 0 });
      const repaired = await answerWithReport({ used: 0, max: limits.maxRepairCalls }, repairPrompt(first.issues)).catch((err) => {
        // A repair that runs out of tokens keeps the first draft: the final verification
        // below still removes whatever fails.
        if (err instanceof StopRun && (err.code === "call_limit" || err.code === "token_limit")) return null;
        throw err;
      });
      if (repaired) finalDraft = repaired;
    }

    t0 = now();
    const final = first.issues.length === 0 ? { ...first, dropped: [], trimmed: [] } : await verifyReport(ctx, finalDraft, log, { final: true });
    if (first.issues.length > 0) {
      emit({
        kind: "verify",
        label: "verifier",
        detail: `kept ${final.passed.length} of ${finalDraft.patterns.length}${final.dropped.length ? `, dropped ${final.dropped.length}` : ""}${final.trimmed.length ? `, trimmed evidence in ${final.trimmed.length}` : ""}`,
        ms: now() - t0,
      });
    }

    return {
      status: "done",
      report: {
        patterns: final.passed,
        ...(finalDraft.notEnoughData ? { notEnoughData: finalDraft.notEnoughData } : {}),
        dropped: final.dropped,
        trimmed: final.trimmed,
      },
      usage,
      durationMs: now() - started,
      trace,
    };
  } catch (err) {
    const stop = err instanceof StopRun ? err : new StopRun("model_error", `Unexpected error: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
    return { status: "failed", error: { code: stop.code, message: stop.message }, usage, durationMs: now() - started, trace };
  }
}
