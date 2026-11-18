import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import { ApiError, askQuestion, fetchGames, fetchPlayer, GAMES_PAGE_SIZE, releaseAnalysis, retryAfterMsOf, runStreamUrl, startImport, startReport } from "./api";
import { isWakingError } from "./waking";

describe("runStreamUrl", () => {
  test("a report run: no query string", () => {
    assert.match(runStreamUrl("6af545db4bd658825893842f"), /\/api\/runs\/6af545db4bd658825893842f\/stream$/);
    assert.ok(!runStreamUrl("abc", null).includes("?"));
  });
  test("an ask run: the token goes in ?token=, encoded", () => {
    assert.match(runStreamUrl("r1", "3f2b-9c"), /\/api\/runs\/r1\/stream\?token=3f2b-9c$/);
    assert.match(runStreamUrl("r1", "a b&c=d"), /\?token=a%20b%26c%3Dd$/);
  });
});

describe("retryAfterMsOf", () => {
  test("seconds → ms; absent or not a number of seconds → undefined", () => {
    assert.equal(retryAfterMsOf("60"), 60_000);
    assert.equal(retryAfterMsOf(" 5 "), 5_000);
    assert.equal(retryAfterMsOf(null), undefined);
    assert.equal(retryAfterMsOf("Wed, 21 Oct 2026 07:28:00 GMT"), undefined);
    assert.equal(retryAfterMsOf("-3"), undefined);
  });
});

// ---- The requests themselves, against a fake fetch ---------------------------------------------
// Every page's error handling rests on how getJson turns a failed request into an ApiError.

interface Call {
  url: string;
  init: RequestInit;
}
// Replaces fetch for one test; `respond` gets each call and returns the Response (or throws).
function fakeFetch(t: TestContext, respond: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return respond(call);
  });
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const signal = () => new AbortController().signal;
const failure = async (p: Promise<unknown>): Promise<unknown> => p.then(() => assert.fail("expected a rejection"), (err: unknown) => err);

describe("API errors", () => {
  test("no answer at all (network, CORS, sleeping server) → ApiError status 0, which the waking retry understands", async (t) => {
    fakeFetch(t, () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await failure(fetchPlayer("lichess", "alice", signal()));
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.message, err.code], [0, "Can't reach the API", undefined]);
    assert.equal(isWakingError(err), true);
  });

  test("a cancelled request rethrows the abort itself, so callers can tell cancelled from failed", async (t) => {
    const controller = new AbortController();
    const abort = new DOMException("The operation was aborted", "AbortError");
    fakeFetch(t, () => {
      controller.abort();
      throw abort;
    });
    const err = await failure(fetchPlayer("lichess", "alice", controller.signal));
    assert.equal(err, abort);
    assert.ok(!(err instanceof ApiError));
  });

  test("the API's { error, code } and Retry-After become the error's message, code and retryAfterMs", async (t) => {
    fakeFetch(t, () => json({ error: "You've asked a lot of questions. Try again in about 40 minutes.", code: "limit_questions" }, 429, { "retry-after": "2400" }));
    const err = await failure(askQuestion("lichess", "alice", "Why?"));
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.code, err.retryAfterMs], [429, "limit_questions", 2_400_000]);
    assert.match(err.message, /about 40 minutes/);
    assert.equal(isWakingError(err), false);
  });

  test("a 502 HTML page from Render's proxy: a fallback message, no code, so it IS retried as waking", async (t) => {
    fakeFetch(t, () => new Response("<html>Bad Gateway</html>", { status: 502, headers: { "content-type": "text/html" } }));
    const err = await failure(fetchPlayer("lichess", "alice", signal()));
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.status, err.message, err.code, err.retryAfterMs], [502, "The API returned 502", undefined, undefined]);
    assert.equal(isWakingError(err), true);
  });

  test("a 503 with our code (busy) is NOT a waking error: the page shows it instead of retrying for a minute", async (t) => {
    fakeFetch(t, () => json({ error: "The coach is busy.", code: "busy" }, 503, { "retry-after": "60" }));
    const err = await failure(startReport("lichess", "alice"));
    assert.ok(err instanceof ApiError);
    assert.deepEqual([err.code, err.retryAfterMs], ["busy", 60_000]);
    assert.equal(isWakingError(err), false);
  });
});

describe("API requests", () => {
  test("fetchGames asks for the whole list (limit 200), never from the browser cache; the cursor and username are encoded", async (t) => {
    const calls = fakeFetch(t, () => json({ games: [], nextCursor: null }));
    const s = signal();
    await fetchGames("chesscom", "a b", null, s);
    await fetchGames("chesscom", "a b", "abc+/=", s);
    assert.equal(GAMES_PAGE_SIZE, 200);
    assert.match(calls[0]!.url, /\/api\/players\/chesscom\/a%20b\/games\?limit=200$/);
    assert.match(calls[1]!.url, /\/games\?limit=200&cursor=abc%2B%2F%3D$/);
    assert.equal(calls[0]!.init.cache, "no-store");
    assert.equal(calls[0]!.init.signal, s);
  });

  test("startImport: the trigger travels in the query string with no body or content type (no CORS preflight)", async (t) => {
    const calls = fakeFetch(t, (call) => (call.url.includes("trigger=auto") ? json({ upToDate: true, frozen: true }) : json({ jobId: "j1" }, 202)));
    assert.deepEqual(await startImport("lichess", "alice", signal(), "auto"), { kind: "upToDate" });
    assert.deepEqual(await startImport("lichess", "alice", signal()), { kind: "job", jobId: "j1" });
    assert.match(calls[0]!.url, /\/api\/players\/lichess\/alice\/import\?trigger=auto$/);
    assert.match(calls[1]!.url, /\?trigger=user$/, "a call without a trigger counts as the visitor's");
    for (const call of calls) {
      assert.equal(call.init.method, "POST");
      assert.equal(call.init.body, undefined);
      assert.equal(call.init.headers, undefined);
    }
  });

  test("askQuestion: 202 → a run with its token; 200 → the cached answer (trace null when its run expired)", async (t) => {
    let reply = json({ runId: "r1", token: "t1" }, 202);
    const calls = fakeFetch(t, () => reply);
    assert.deepEqual(await askQuestion("lichess", "alice", "Do I play worse with Black?"), { kind: "run", runId: "r1", token: "t1" });
    assert.equal(calls[0]!.init.body, JSON.stringify({ question: "Do I play worse with Black?" }));
    assert.ok(!calls[0]!.url.includes("Black"), "the question is in the body, never the URL");

    reply = json({ answer: { id: "a1" }, cached: true });
    assert.deepEqual(await askQuestion("lichess", "alice", "x"), { kind: "cached", answer: { id: "a1" }, trace: null });
  });

  test("startReport: 202 → the run to watch; 200 → the cached report", async (t) => {
    let reply = json({ runId: "r9" }, 202);
    fakeFetch(t, () => reply);
    assert.deepEqual(await startReport("lichess", "alice"), { kind: "run", runId: "r9" });
    reply = json({ report: { id: "rep" }, cached: true });
    assert.deepEqual(await startReport("lichess", "alice"), { kind: "cached", report: { id: "rep" } });
  });

  test("releaseAnalysis: nothing to hand back → no request; otherwise a text/plain keepalive POST (a simple request)", (t) => {
    const calls = fakeFetch(t, () => json({ ok: true }));
    releaseAnalysis("c1", []);
    assert.equal(calls.length, 0);
    releaseAnalysis("c1", ["g1", "g2"]);
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/analysis\/release$/);
    assert.deepEqual(calls[0]!.init.headers, { "Content-Type": "text/plain" });
    assert.equal(calls[0]!.init.keepalive, true);
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { claimId: "c1", gameIds: ["g1", "g2"] });
  });
});
