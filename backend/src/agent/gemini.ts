import { ModelError, type Model, type ModelRequest, type ModelResponse, type Step } from "./model.js";

// The real model: Google's Interactions API over plain fetch (see model.ts for the shapes).
//
// Why fetch and not the @google/genai SDK: one create() call in the SDK can send several billed
// requests on its own (automatic continuation of long answers) and retries by its own policy,
// and its errors keep only status + message, losing the retry delay Google sends with a 429.
// Here every call is exactly one HTTP request, so the loop and the daily budget can count
// them, and every retry decision is ours (agent/loop.ts, agent/pacer.ts).

export const INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
// The API revision the REST docs use (structured output page, Nov 2026). Pinned, so a new
// revision can't change response shapes under us.
const API_REVISION = "2026-05-20";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface GeminiOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  fetch?: FetchLike;
}

interface ApiErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { "@type"?: string; retryDelay?: string }[] };
}

// Google's RetryInfo delay ("23s", "1.5s") → ms. The Retry-After header (seconds) as backup.
export function retryAfterMs(body: ApiErrorBody | undefined, header: string | null): number | undefined {
  const delay = body?.error?.details?.find((d) => d["@type"]?.endsWith("google.rpc.RetryInfo"))?.retryDelay;
  const fromBody = delay && /^\d+(\.\d+)?s$/.test(delay) ? Math.round(parseFloat(delay) * 1000) : undefined;
  if (fromBody !== undefined) return fromBody;
  const seconds = header && /^\d+$/.test(header.trim()) ? Number(header.trim()) : undefined;
  return seconds !== undefined ? seconds * 1000 : undefined;
}

// A short, safe description of a failed call: Google's message, cut short. It never includes
// the request (which carries the key in a header) or the conversation.
const describe = (status: number, body: ApiErrorBody | undefined) =>
  `Gemini ${status}${body?.error?.status ? ` ${body.error.status}` : ""}: ${(body?.error?.message ?? "no message").slice(0, 200)}`;

export function createGeminiModel({ apiKey, model, timeoutMs, fetch = globalThis.fetch }: GeminiOptions): Model {
  return {
    name: model,
    async call(request: ModelRequest): Promise<ModelResponse> {
      const body = {
        model,
        store: false,
        system_instruction: request.system,
        input: request.input,
        ...(request.tools?.length ? { tools: request.tools } : {}),
        ...(request.responseSchema
          ? { response_format: { type: "text", mime_type: "application/json", schema: request.responseSchema } }
          : {}),
      };

      // The run's signal (shutdown, run deadline) or this call's own timeout, whichever first.
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await fetch(INTERACTIONS_URL, {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "content-type": "application/json", "api-revision": API_REVISION },
          body: JSON.stringify(body),
          signal: AbortSignal.any([request.signal, timeout]),
        });
      } catch (err) {
        if (request.signal.aborted) throw request.signal.reason;
        if (timeout.aborted) throw new ModelError("timeout", `Gemini call timed out after ${timeoutMs} ms`);
        throw new ModelError("network", `Gemini request failed: ${String((err as Error)?.message ?? err).slice(0, 200)}`);
      }

      const text = await res.text().catch(() => "");
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }

      if (!res.ok) {
        const errBody = json as ApiErrorBody | undefined;
        const message = describe(res.status, errBody);
        if (res.status === 429) {
          throw new ModelError("rate_limited", message, { status: 429, retryAfterMs: retryAfterMs(errBody, res.headers.get("retry-after")) });
        }
        if (res.status === 401 || res.status === 403) throw new ModelError("auth", message, { status: res.status });
        if (res.status >= 500) throw new ModelError("server", message, { status: res.status });
        throw new ModelError("bad_request", message, { status: res.status });
      }

      const data = json as { status?: string; steps?: Step[]; usage?: { total_input_tokens?: number; total_output_tokens?: number; total_tokens?: number } } | undefined;
      if (!data || typeof data.status !== "string") throw new ModelError("server", "Gemini returned a response without a status");
      const input = data.usage?.total_input_tokens ?? 0;
      const output = data.usage?.total_output_tokens ?? 0;
      return {
        status: data.status,
        steps: Array.isArray(data.steps) ? data.steps : [],
        usage: { input, output, total: data.usage?.total_tokens ?? input + output },
      };
    },
  };
}
