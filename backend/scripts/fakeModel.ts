import type { Model, ModelRequest, ModelResponse, Step } from "../src/agent/model.js";

// A model for tests: plays back a script of turns and records every request, so a test can
// say "the model asks for these tools, then answers this" and check exactly what the loop
// sent. A turn can be a fixed response, an error to throw, or a function of the request
// (to answer with numbers taken from the tool results the loop really sent).

export type Turn = ModelResponse | Error | ((request: ModelRequest, index: number) => ModelResponse | Error | Promise<ModelResponse | Error>);

export function scriptedModel(turns: Turn[], name = "fake-model") {
  // Snapshots: the loop keeps appending to the same input array, so each request is copied
  // as it was when sent.
  const requests: ModelRequest[] = [];
  const model: Model = {
    name,
    async call(request) {
      const index = requests.length;
      requests.push({ ...request, input: structuredClone(request.input) });
      const turn = turns[index];
      if (turn === undefined) throw new Error(`fake model: the script has no turn ${index + 1}`);
      const result = typeof turn === "function" ? await turn(request, index) : turn;
      if (result instanceof Error) throw result;
      return structuredClone(result);
    },
  };
  return { model, requests };
}

let callCounter = 0;

export const thought = (signature = "sig-opaque-1"): Step => ({ type: "thought", signature });

// The model asks for tools: [name, args] pairs, with a thought step first like the real model.
export function callTools(...calls: [string, Record<string, unknown>][]): ModelResponse {
  return {
    status: "requires_action",
    steps: [thought(), ...calls.map(([name, args]) => ({ type: "function_call", id: `call_${++callCounter}`, name, arguments: args }))],
    usage: { input: 1_000, output: 50, total: 1_050 },
  };
}

// The model answers: an object becomes its JSON text; a string is sent as it is.
export function answer(report: unknown, usage = { input: 2_000, output: 400, total: 2_400 }): ModelResponse {
  return {
    status: "completed",
    steps: [{ type: "model_output", content: [{ type: "text", text: typeof report === "string" ? report : JSON.stringify(report) }] }],
    usage,
  };
}

// What the loop sent back for tool step `step`: the { step, result } payload's result.
export function toolResult<T = Record<string, unknown>>(request: ModelRequest, step: number): T {
  for (const s of request.input) {
    if (s.type !== "function_result") continue;
    const text = (s as { result: { text: string }[] }).result[0]!.text;
    const payload = JSON.parse(text) as { step: number; result?: T };
    if (payload.step === step && payload.result !== undefined) return payload.result;
  }
  throw new Error(`fake model: no tool result for step ${step}`);
}

// The last user message in a request (the task, a repair note or a format retry).
export function lastUserText(request: ModelRequest): string {
  const users = request.input.filter((s) => s.type === "user_input") as { content: { text: string }[] }[];
  return users.at(-1)?.content[0]?.text ?? "";
}
