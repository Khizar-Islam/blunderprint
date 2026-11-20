// The model behind the coach, as the agent loop sees it. gemini.ts implements it against the
// real API; tests use scripts/fakeModel.ts, which plays back scripted turns. The loop never
// knows which one it has.
//
// The shapes follow Google's Interactions API (POST /v1beta/interactions), stateless
// (store: false): we keep the whole conversation and send it every time, as a list of steps.

export interface TextContent {
  type: "text";
  text: string;
}

// The steps the coach uses. A model's steps are sent back EXACTLY as they came, including the
// thought step's `signature`: an encrypted record of the model's reasoning that lets it pick
// up where it left off. Unknown step types are kept and passed through untouched too.
export type Step =
  | { type: "user_input"; content: TextContent[] }
  | { type: "thought"; signature?: string; summary?: unknown }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: TextContent[]; is_error?: boolean }
  | { type: "model_output"; content?: TextContent[] }
  | { type: string; [key: string]: unknown };

export interface FunctionTool {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

// How much the model may reason before it answers (Interactions API generation_config
// .thinking_level). Thinking is billed as output tokens. Not every model takes every level:
// gemini-3.8-flash takes low / medium / high and thinks at medium when nothing is sent.
export const THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface ModelRequest {
  system: string;
  input: Step[];
  // Absent or empty: the model can't call tools and must answer.
  tools?: FunctionTool[];
  // A JSON Schema the answer must follow (structured output).
  responseSchema?: Record<string, unknown>;
  // Left out = nothing is sent and the model uses its own default.
  thinking?: ThinkingLevel;
  signal: AbortSignal;
}

export interface ModelUsage {
  input: number;
  output: number;
  // Tokens spent thinking, reported separately from the output (0 or absent when it didn't).
  thought?: number;
  total: number;
}

export interface ModelResponse {
  // "requires_action" (it called tools), "completed", or a failure such as "incomplete".
  status: string;
  steps: Step[];
  usage: ModelUsage;
}

export interface Model {
  name: string;
  call(request: ModelRequest): Promise<ModelResponse>;
}

// Why a call failed, in the terms the loop decides on:
//   rate_limited → wait (retryAfterMs when Google said how long) and try again
//   overloaded → the model is overloaded (503 "high demand"): up to 3 tries with a growing wait,
//                then the fallback model
//   timeout / server / network → one more try
//   bad_request / auth → stop: trying again won't help
//   out_of_credit → stop at once: the prepaid credit is used up (HTTP 402). No retry and no
//                   fallback model (the same account pays for both); see agent/credit.ts
export type ModelErrorKind = "rate_limited" | "overloaded" | "timeout" | "server" | "network" | "bad_request" | "auth" | "out_of_credit";

export class ModelError extends Error {
  constructor(
    readonly kind: ModelErrorKind,
    message: string,
    readonly details: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.name = "ModelError";
  }
}

// Helpers for reading and building steps.
export const textOf = (steps: Step[]): string =>
  steps
    .filter((s): s is { type: "model_output"; content?: TextContent[] } => s.type === "model_output")
    .flatMap((s) => s.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");

export const functionCallsOf = (steps: Step[]) =>
  steps.filter((s): s is { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> } => s.type === "function_call");

export const userInput = (text: string): Step => ({ type: "user_input", content: [{ type: "text", text }] });
