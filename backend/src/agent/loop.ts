import { logger } from "../lib/logger.js";
import { sleep as realSleep, type Sleep } from "../lib/sleep.js";
import { BudgetRefused } from "./budget.js";
import type { AgentContext } from "./context.js";
import { functionCallsOf, ModelError, textOf, userInput, type Model, type ModelErrorKind, type ModelResponse, type Step } from "./model.js";
import type { Pacer } from "./pacer.js";
import { buildSystemPrompt, FINAL_PROMPT, FORMAT_RETRY_PROMPT, repairPrompt, TASK_PROMPT } from "./prompts.js";
import { parseReport, REPORT_JSON_SCHEMA, type DraftReport } from "./schema.js";
import { declaredTools, runTool, summarizeResult } from "./tools/index.js";
import { verifyReport, type DroppedPattern, type ToolLog, type VerifiedPattern, type VerificationIssue } from "./verifier.js";

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
// WHAT the run produces is a task (AgentTask below): its prompts, its answer schema and its
// verifier. The report (reportTask) is the default; an "Ask the coach" question (ask.ts, Stage 6)
// is the other. The loop itself (phases, retries, limits, trace) is the same for both.
//
// Limits: maxCalls model calls for 1-2 (two of them kept back for the answer), maxRepairCalls
// more for 3, a total token budget, a per-call timeout (in the model) and a deadline for the
// whole run. Every model call waits for the process-wide pacer first (pacer.ts).
//
// maxCalls / maxRepairCalls count LOGICAL calls (one model turn); its retries don't use them up.
// Every real request (retries included) counts against maxRequests, a hard ceiling per run, and
// the investigation must leave ANSWER_RESERVE_REQUESTS of it for the answer (one call and its
// retries), so a stormy investigation can't starve the answer.
//
// Overload (Google's 503 "high demand"): up to 3 retries with backoff (~2 s, 6 s, 15 s, jitter).
// After 2 overloaded responses in a row on one call, the rest of the run switches to the
// fallback model, if there is one.

export interface AgentLimits {
  maxCalls: number;
  maxRepairCalls: number;
  maxTokens: number;
  runTimeoutMs: number;
  // Every request of the run, retries included (COACH_MAX_REQUESTS).
  maxRequests: number;
}

export type TraceKind = "model" | "tool" | "verify" | "repair" | "retry" | "switch";

// Which part of the run a model call belongs to (logged with every model error).
export type RunPhase = "investigate" | "answer" | "repair";

// One line of the live "agent trace" the coach page shows.
export interface TraceStep {
  n: number;
  kind: TraceKind;
  label: string; // "get_mistake_breakdown(groupBy: phase)", "gemini-3.5-flash-lite"
  detail: string; // "3 rows by phase", "asked for 2 tools", "1 issue"
  ms: number;
  tokens?: number;
}

export type StopCode =
  | "time_limit"
  | "token_limit"
  | "call_limit"
  | "model_error"
  | "no_answer"
  | "aborted"
  // The AI guards (budget.ts) refused a request: the kill switch, or today's budget is used up.
  | "ai_disabled"
  | "ai_budget_exhausted";

// How a run failed. `message` is for the logs only: it can carry an upstream or unexpected
// error's text. Visitors only ever see agent/friendly.ts's message for the code.
export interface AgentError {
  code: StopCode;
  message: string;
  // For model_error: what kind of failure (busy, down, our request was rejected...).
  modelErrorKind?: ModelErrorKind;
  // An error that wasn't one of ours (a bug or a DB failure).
  unexpected?: boolean;
  // Where in the run it stopped.
  phase?: RunPhase;
}

export interface AgentReport {
  patterns: VerifiedPattern[];
  notEnoughData?: string;
  dropped: DroppedPattern[];
  trimmed: DroppedPattern[];
}

export interface TaskResult<Output> {
  status: "done" | "failed";
  output?: Output;
  error?: AgentError;
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  trace: TraceStep[];
  // The model that wrote the answer the run ended with (the fallback, if the run switched).
  answerModel?: string;
}

export interface AgentResult {
  status: "done" | "failed";
  report?: AgentReport;
  error?: AgentError;
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
  trace: TraceStep[];
  // The model that wrote the report the run ended with (the fallback, if the run switched).
  answerModel?: string;
}

// One kind of run: what the model is told, the shape of its answer, and how code checks it.
//   verify(final=false) lists every problem (for the repair round) and the output to use if
//   there are none; verify(final=true) is the last word: it removes what still fails.
export interface AgentTask<Draft, Output> {
  system: string;
  // The first user message, and the one that starts the answer phase.
  taskPrompt: string;
  finalPrompt: string;
  formatRetryPrompt(error: string): string;
  responseSchema: Record<string, unknown>;
  parse(text: string): { ok: true; draft: Draft } | { ok: false; error: string };
  verify(draft: Draft, log: ToolLog, opts: { final: boolean }): Promise<TaskVerification<Output>>;
  repairPrompt(issues: string[]): string;
  // Trace wording: "wrote the report" / "wrote the answer", and "no usable report: ...".
  noun: string;
}

export interface TaskVerification<Output> {
  // One line per problem, for the trace and the repair prompt.
  issues: string[];
  output: Output;
  // The verifier's trace line.
  detail: string;
}

export interface RunAgentOptions {
  ctx: AgentContext;
  model: Model;
  // Used for the rest of the run after the main model is overloaded twice in a row.
  fallback?: Model;
  pacer: Pacer;
  limits: AgentLimits;
  signal?: AbortSignal;
  onStep?: (step: TraceStep) => void;
  now?: () => number;
  sleep?: Sleep;
  // For the backoff jitter (tests pass a fixed one).
  random?: () => number;
}

// Internal: the investigation reached the requests kept back for the answer.
class InvestigationCut extends Error {}

class StopRun extends Error {
  constructor(
    readonly code: StopCode,
    message: string,
    readonly extra: { modelErrorKind?: ModelErrorKind; unexpected?: boolean; phase?: RunPhase } = {},
  ) {
    super(message);
  }
}

// Retries inside one logical call: 429s wait (Google's delay when it gives one); an overloaded
// model gets up to 3 more tries with a growing wait; a timeout, network or other server error
// gets one more try. Each retry is a real request: it counts against maxRequests and the budget.
const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_OVERLOAD_RETRIES = 3;
const OVERLOAD_BACKOFF_MS = [2_000, 6_000, 15_000];
// Overloaded responses in a row (on one logical call) before switching to the fallback model.
const SWITCH_AFTER_OVERLOADS = 2;
const MAX_TRANSIENT_RETRIES = 1;
const BACKOFF_BASE_MS = 5_000;
// Requests the investigation must leave for the answer: the call plus its overload retries.
export const ANSWER_RESERVE_REQUESTS = 1 + MAX_OVERLOAD_RETRIES;
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

// The coach report as a task: the Stage 5 prompts, schema and verifier, unchanged.
export function reportTask(ctx: AgentContext): AgentTask<DraftReport, AgentReport> {
  // The weakness rules (gap, minimum sample) come with the player's context, so the prompt and
  // the candidate scan always state the same ones.
  return {
    system: buildSystemPrompt(ctx.rules),
    taskPrompt: TASK_PROMPT,
    finalPrompt: FINAL_PROMPT,
    formatRetryPrompt: FORMAT_RETRY_PROMPT,
    responseSchema: REPORT_JSON_SCHEMA,
    noun: "report",
    parse(text) {
      const parsed = parseReport(text);
      return parsed.ok ? { ok: true, draft: parsed.report } : parsed;
    },
    // The repair prompt names each issue's pattern, so the issues travel as JSON lines here and
    // are read back in repairPrompt (the loop only needs them as text for the trace).
    async verify(draft, log, { final }) {
      const v = await verifyReport(ctx, draft, log, { final });
      const n = draft.patterns.length;
      const detail = final
        ? `kept ${v.passed.length} of ${n}${v.dropped.length ? `, dropped ${v.dropped.length}` : ""}${v.trimmed.length ? `, trimmed evidence in ${v.trimmed.length}` : ""}`
        : v.issues.length
          ? `${n} patterns, ${v.issues.length} issue${v.issues.length === 1 ? "" : "s"}`
          : `${n} patterns, all checks passed`;
      return {
        issues: v.issues.map((i) => JSON.stringify(i)),
        detail,
        output: {
          patterns: v.passed,
          ...(draft.notEnoughData ? { notEnoughData: draft.notEnoughData } : {}),
          dropped: final ? v.dropped : [],
          trimmed: final ? v.trimmed : [],
        },
      };
    },
    repairPrompt: (issues) => repairPrompt(issues.map((i) => JSON.parse(i) as VerificationIssue)),
  };
}

// The repair round's trace line for a report: "#1: problem; #2: problem".
const issueLine = (issue: string) => {
  try {
    const i = JSON.parse(issue) as VerificationIssue;
    return typeof i.pattern === "number" ? `#${i.pattern + 1}: ${i.problem}` : issue;
  } catch {
    return issue;
  }
};

// A coach report run (Stage 5's entry point, unchanged for its callers).
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const { output, ...rest } = await runTask({ ...opts, task: reportTask(opts.ctx) });
  return { ...rest, ...(output ? { report: output } : {}) };
}

export async function runTask<Draft, Output>(opts: RunAgentOptions & { task: AgentTask<Draft, Output> }): Promise<TaskResult<Output>> {
  const { ctx, pacer, limits, onStep, fallback, task } = opts;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  // The model in use: the main one, or the fallback after an overload switch.
  let model = opts.model;
  let answerModel: string | undefined;
  const started = now();
  const deadline = started + limits.runTimeoutMs;
  const outer = opts.signal ?? new AbortController().signal;

  const tools = declaredTools();
  const SYSTEM_PROMPT = task.system;
  const input: Step[] = [userInput(task.taskPrompt)];
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

  // One logical model call, with its retries. Investigation calls offer the tools; answer and
  // repair calls ask for the report schema instead. `budget` is the phase's allowance of logical
  // calls (retries don't use it); every request counts against limits.maxRequests.
  async function callModel(phase: RunPhase, budget: { used: number; max: number }): Promise<ModelResponse> {
    const withTools = phase === "investigate";
    let rateLimited = 0;
    let overloaded = 0;
    let overloadStreak = 0;
    let transient = 0;
    let first = true;
    for (;;) {
      checkAborted();
      if (first && budget.used >= budget.max) throw new StopRun("call_limit", `Used all ${budget.max} model calls for this part of the run.`, { phase });
      if (usage.calls >= limits.maxRequests) throw new StopRun("call_limit", `Used all ${limits.maxRequests} requests of the run.`, { phase });
      // The investigation leaves the last requests for the answer.
      if (withTools && limits.maxRequests - usage.calls <= ANSWER_RESERVE_REQUESTS) throw new InvestigationCut();
      const estimate = estimateTokens(withTools);
      if (usage.totalTokens + estimate > limits.maxTokens) {
        throw new StopRun("token_limit", `The next call would pass the ${limits.maxTokens}-token budget.`, { phase });
      }

      const slot = await pacer.acquire(estimate, outer).catch((err) => {
        throw outer.aborted ? new StopRun("aborted", "The run was stopped.", { phase }) : err;
      });
      checkAborted();
      if (first) budget.used++;
      first = false;
      usage.calls++;
      const t0 = now();
      // The run's deadline also cuts a call short; the model adds its own per-call timeout.
      const callSignal = AbortSignal.any([outer, AbortSignal.timeout(Math.max(1, deadline - now()))]);
      try {
        const res = await model.call({
          system: SYSTEM_PROMPT,
          input,
          ...(withTools ? { tools } : { responseSchema: task.responseSchema }),
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
          detail: asked.length ? `asked for ${asked.join(", ")}` : withTools ? "done investigating" : `wrote the ${task.noun}`,
          ms: now() - t0,
          tokens: res.usage.total,
        });
        return res;
      } catch (err) {
        if (outer.aborted) throw new StopRun("aborted", "The run was stopped.", { phase });
        if (err instanceof BudgetRefused) throw new StopRun(err.code, err.message, { phase });
        if (!(err instanceof ModelError)) {
          if (now() > deadline) throw new StopRun("time_limit", `The run passed its ${Math.round(limits.runTimeoutMs / 1000)} s limit.`, { phase });
          throw err;
        }
        logger.warn("Coach model error", {
          phase,
          model: model.name,
          kind: err.kind,
          status: err.details.status,
          request: usage.calls,
          error: err.message,
        });
        overloadStreak = err.kind === "overloaded" ? overloadStreak + 1 : 0;

        if (err.kind === "rate_limited" && rateLimited < MAX_RATE_LIMIT_RETRIES) {
          rateLimited++;
          const wait = err.details.retryAfterMs ?? BACKOFF_BASE_MS * 2 ** (rateLimited - 1);
          if (now() + wait > deadline) throw new StopRun("time_limit", `Rate limited, and the wait (${Math.round(wait / 1000)} s) would pass the run's limit.`, { phase });
          pacer.backoff(wait);
          emit({ kind: "retry", label: model.name, detail: `rate limited: waiting ${Math.round(wait / 1000)} s`, ms: now() - t0 });
          continue;
        }
        if (err.kind === "overloaded" && overloaded < MAX_OVERLOAD_RETRIES) {
          overloaded++;
          // Two overloaded answers in a row: this model is struggling. The rest of the run uses
          // the fallback, which can be tried at once (it's a different model's capacity).
          if (fallback && model !== fallback && overloadStreak >= SWITCH_AFTER_OVERLOADS) {
            const from = model.name;
            model = fallback;
            overloadStreak = 0;
            emit({ kind: "switch", label: model.name, detail: `switched to ${model.name}: ${from} overloaded twice in a row`, ms: now() - t0 });
            logger.warn("Coach switched to the fallback model", { phase, from, to: model.name });
            continue;
          }
          const base = OVERLOAD_BACKOFF_MS[overloaded - 1]!;
          const wait = Math.round(base * (0.8 + 0.4 * random()));
          if (now() + wait > deadline) throw new StopRun("time_limit", `Overloaded, and the wait (${Math.round(wait / 1000)} s) would pass the run's limit.`, { phase });
          emit({ kind: "retry", label: model.name, detail: `model overloaded: waiting ${Math.round(wait / 1000)} s`, ms: now() - t0 });
          await sleep(wait, outer).catch(() => undefined);
          continue;
        }
        if ((err.kind === "timeout" || err.kind === "server" || err.kind === "network") && transient < MAX_TRANSIENT_RETRIES) {
          transient++;
          emit({ kind: "retry", label: model.name, detail: `${err.kind}: trying once more`, ms: now() - t0 });
          await sleep(1_000, outer).catch(() => undefined);
          continue;
        }
        throw new StopRun("model_error", err.message, { modelErrorKind: err.kind, phase });
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
      let res: ModelResponse;
      try {
        res = await callModel("investigate", budget);
      } catch (err) {
        // Out of requests for investigating: answer with what has been found so far.
        if (err instanceof InvestigationCut) {
          emit({ kind: "model", label: model.name, detail: "stopped investigating: the rest of the requests are kept for the answer", ms: 0 });
          return;
        }
        throw err;
      }
      input.push(...res.steps);
      if (functionCallsOf(res.steps).length === 0) return;
      await runToolCalls(res);
    }
  }

  // Phase 2: `prompt`, then one answer call for the JSON answer. If it can't be read and the
  // budget allows, one more call asking for just the JSON.
  async function answerWithReport(budget: { used: number; max: number }, prompt: string, phase: "answer" | "repair"): Promise<Draft | null> {
    input.push(userInput(prompt));
    let res = await callModel(phase, budget);
    input.push(...res.steps);
    let parsed = task.parse(textOf(res.steps));
    if (!parsed.ok && budget.max - budget.used >= 1) {
      input.push(userInput(task.formatRetryPrompt(parsed.error)));
      res = await callModel(phase, budget);
      input.push(...res.steps);
      parsed = task.parse(textOf(res.steps));
    }
    if (parsed.ok) {
      answerModel = model.name;
      return parsed.draft;
    }
    emit({ kind: "model", label: model.name, detail: `no usable ${task.noun}: ${parsed.error}`, ms: 0 });
    return null;
  }

  try {
    const mainBudget = { used: 0, max: limits.maxCalls };
    // Two calls kept back: the answer, and one format retry if it's needed.
    await investigate(mainBudget, 2);
    const draft = await answerWithReport(mainBudget, task.finalPrompt, "answer");
    if (!draft) throw new StopRun("no_answer", `The model didn't produce a usable ${task.noun}.`, { phase: "answer" });

    // Verify; one repair round if anything failed.
    let t0 = now();
    const first = await task.verify(draft, log, { final: false });
    emit({ kind: "verify", label: "verifier", detail: first.detail, ms: now() - t0 });

    let finalDraft = draft;
    if (first.issues.length > 0 && limits.maxRepairCalls > 0) {
      emit({ kind: "repair", label: "repair round", detail: first.issues.map(issueLine).join("; ").slice(0, 300), ms: 0 });
      const firstAnswerModel = answerModel;
      const repaired = await answerWithReport({ used: 0, max: limits.maxRepairCalls }, task.repairPrompt(first.issues), "repair").catch((err) => {
        // A repair that runs out of tokens keeps the first draft: the final verification
        // below still removes whatever fails.
        if (err instanceof StopRun && (err.code === "call_limit" || err.code === "token_limit")) return null;
        throw err;
      });
      if (repaired) finalDraft = repaired;
      else answerModel = firstAnswerModel;
    }

    t0 = now();
    const final = first.issues.length === 0 ? first : await task.verify(finalDraft, log, { final: true });
    if (first.issues.length > 0) emit({ kind: "verify", label: "verifier", detail: final.detail, ms: now() - t0 });

    return {
      status: "done",
      output: final.output,
      usage,
      durationMs: now() - started,
      trace,
      ...(answerModel ? { answerModel } : {}),
    };
  } catch (err) {
    const stop =
      err instanceof StopRun ? err : new StopRun("model_error", `Unexpected error: ${String((err as Error)?.message ?? err).slice(0, 200)}`, { unexpected: true });
    return { status: "failed", error: { code: stop.code, message: stop.message, ...stop.extra }, usage, durationMs: now() - started, trace };
  }
}
