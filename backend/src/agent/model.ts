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

export interface ModelRequest {
  system: string;
  input: Step[];
  // Absent or empty: the model can't call tools and must answer.
  tools?: FunctionTool[];
  // A JSON Schema the answer must follow (structured output).
  responseSchema?: Record<string, unknown>;
  signal: AbortSignal;
}

export interface ModelUsage {
  input: number;
  output: number;
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
//   timeout / server / network → one more try
//   bad_request / auth → stop: trying again won't help
export type ModelErrorKind = "rate_limited" | "timeout" | "server" | "network" | "bad_request" | "auth";

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
