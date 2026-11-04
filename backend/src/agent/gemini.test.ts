import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { jsonResponse, recordingFetch } from "../../scripts/fakeFetch.js";
import { createGeminiModel, INTERACTIONS_URL, retryAfterMs } from "./gemini.js";
import { ModelError, userInput, type ModelRequest } from "./model.js";

const KEY = "test-key-never-printed-123";

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  system: "be a coach",
  input: [userInput("go")],
  tools: [{ type: "function", name: "get_player_profile", description: "d", parameters: { type: "object", properties: {} } }],
  responseSchema: { type: "object" },
  signal: new AbortController().signal,
  ...overrides,
});

const OK = {
  status: "requires_action",
  steps: [
    { type: "thought", signature: "abc" },
    { type: "function_call", id: "call_1", name: "get_player_profile", arguments: {} },
  ],
  usage: { total_input_tokens: 76, total_output_tokens: 18, total_tokens: 94 },
};

// A fetch that never answers: it settles only when its signal aborts. AbortSignal.timeout's
// timer doesn't keep Node's event loop alive, so this holds an ordinary timer meanwhile;
// otherwise the test runner sees nothing pending and cancels the test.
const hangUntilAborted = (_url: string, init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    const keepAlive = setTimeout(() => undefined, 10_000);
    init.signal!.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(init.signal!.reason);
    });
  });

const errorBody = (code: number, status: string, message: string, details: unknown[] = []) => ({ error: { code, status, message, details } });

async function failure(respond: () => Response | Promise<Response>, timeoutMs = 5_000): Promise<ModelError> {
  const { fetch } = recordingFetch(respond);
  const model = createGeminiModel({ apiKey: KEY, model: "gemini-3.5-flash-lite", timeoutMs, fetch });
  const err = await model.call(request()).then(
    () => assert.fail("expected an error"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof ModelError, String(err));
  assert.doesNotMatch(err.message, new RegExp(KEY), "the key never appears in an error");
  return err;
}

describe("gemini client", () => {
  it("one POST to the Interactions API: stateless, system instruction, tools, response format", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(OK));
    const model = createGeminiModel({ apiKey: KEY, model: "gemini-3.5-flash-lite", timeoutMs: 5_000, fetch });
    const res = await model.call(request());

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, INTERACTIONS_URL);
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers["x-goog-api-key"], KEY);
    const body = JSON.parse(calls[0]!.body!);
    assert.equal(body.model, "gemini-3.5-flash-lite");
    assert.equal(body.store, false);
    assert.equal(body.system_instruction, "be a coach");
    assert.deepEqual(body.input, [{ type: "user_input", content: [{ type: "text", text: "go" }] }]);
    assert.equal(body.tools[0].type, "function");
    assert.deepEqual(body.response_format, { type: "text", mime_type: "application/json", schema: { type: "object" } });
    assert.equal(JSON.stringify(body).includes(KEY), false, "the key goes in a header only");

    assert.equal(res.status, "requires_action");
    assert.deepEqual(res.steps, OK.steps);
    assert.deepEqual(res.usage, { input: 76, output: 18, total: 94 });
  });

  it("no tools: the field is left out, so the model must answer", async () => {
    const { fetch, calls } = recordingFetch(() => jsonResponse(OK));
    await createGeminiModel({ apiKey: KEY, model: "m", timeoutMs: 5_000, fetch }).call(request({ tools: undefined }));
    assert.equal("tools" in JSON.parse(calls[0]!.body!), false);
  });

  it("429: rate_limited with Google's RetryInfo delay", async () => {
    const err = await failure(() =>
      jsonResponse(
        errorBody(429, "RESOURCE_EXHAUSTED", "Quota exceeded", [
          { "@type": "type.googleapis.com/google.rpc.QuotaFailure" },
          { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "23s" },
        ]),
        { status: 429 },
      ),
    );
    assert.equal(err.kind, "rate_limited");
    assert.equal(err.details.retryAfterMs, 23_000);
    assert.match(err.message, /Gemini 429 RESOURCE_EXHAUSTED: Quota exceeded/);
  });

  it("retry delay: RetryInfo, then the Retry-After header, else unknown", () => {
    assert.equal(retryAfterMs({ error: { details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "1.5s" }] } }, null), 1_500);
    assert.equal(retryAfterMs(undefined, "7"), 7_000);
    assert.equal(retryAfterMs({ error: { details: [{ "@type": "x", retryDelay: "soon" }] } }, null), undefined);
  });

  it("401/403 auth, 400 bad request, 5xx server", async () => {
    assert.equal((await failure(() => jsonResponse(errorBody(403, "PERMISSION_DENIED", "API key not valid"), { status: 403 }))).kind, "auth");
    const bad = await failure(() => jsonResponse(errorBody(400, "INVALID_ARGUMENT", "Unknown field 'schema'"), { status: 400 }));
    assert.equal(bad.kind, "bad_request");
    assert.equal(bad.message, "Gemini 400 INVALID_ARGUMENT: Unknown field 'schema'");
    assert.equal((await failure(() => new Response("upstream sad", { status: 503 }))).kind, "server");
  });

  it("a network failure and a 200 without a status", async () => {
    assert.equal((await failure(() => Promise.reject(new TypeError("fetch failed")))).kind, "network");
    assert.equal((await failure(() => jsonResponse({ nothing: true }))).kind, "server");
  });

  it("the call's own timeout", async () => {
    const hang = hangUntilAborted;
    const model = createGeminiModel({ apiKey: KEY, model: "m", timeoutMs: 20, fetch: hang });
    const err = await model.call(request()).catch((e: unknown) => e);
    assert.ok(err instanceof ModelError);
    assert.equal(err.kind, "timeout");
  });

  it("the run's signal: its own reason comes through, not a timeout", async () => {
    const hang = hangUntilAborted;
    const controller = new AbortController();
    const model = createGeminiModel({ apiKey: KEY, model: "m", timeoutMs: 5_000, fetch: hang });
    const pending = model.call(request({ signal: controller.signal }));
    const reason = new Error("shutting down");
    controller.abort(reason);
    assert.equal(await pending.catch((e: unknown) => e), reason);
  });
});
