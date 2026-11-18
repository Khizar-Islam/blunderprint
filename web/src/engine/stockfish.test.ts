import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { ENGINE_URL, EngineError, StockfishEngine } from "./stockfish";

// StockfishEngine against a fake Web Worker: Node has no Worker of the browser's kind, and the
// real engine is 1.8 MB of WASM. What is tested is our side of the conversation: the UCI lines
// we post, one search at a time, and that a crashed, silent or stopped worker REJECTS the call
// that is waiting (and every later one) instead of leaving the analysis hanging for ever.

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const INFO = "info depth 12 seldepth 16 multipv 1 score cp 31 nodes 100000 nps 700000 time 143 pv e2e4 e7e5";

class FakeWorker {
  static last: FakeWorker;
  posted: string[] = [];
  terminated = false;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null = null;
  // What the "engine" answers to a command; a test replaces it to stay silent or answer late.
  reply: (line: string) => string[] | null = (line) => {
    if (line === "uci") return ["id name Stockfish", "uciok"];
    if (line === "isready") return ["readyok"];
    if (line.startsWith("go ")) return [INFO, "bestmove e2e4 ponder e7e5"];
    return null;
  };

  constructor(readonly url: string) {
    FakeWorker.last = this;
  }
  postMessage(line: string) {
    this.posted.push(line);
    const lines = this.reply(line);
    // Like a real worker: the answer arrives later, never inside postMessage.
    if (lines) queueMicrotask(() => this.say(...lines));
  }
  say(...lines: string[]) {
    for (const line of lines) this.onmessage?.({ data: line });
  }
  crash(message: string) {
    this.onerror?.({ message, preventDefault() {} });
  }
  terminate() {
    this.terminated = true;
  }
}

const realWorker = (globalThis as { Worker?: unknown }).Worker;
beforeEach(() => {
  (globalThis as { Worker?: unknown }).Worker = FakeWorker;
});
afterEach(() => {
  (globalThis as { Worker?: unknown }).Worker = realWorker;
  mock.timers.reset();
});

// Lets queued promise callbacks run (the engine's call queue is a promise chain).
const settle = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("StockfishEngine: the UCI conversation", () => {
  test("init does the handshake and sets one thread and a small hash before isready", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    assert.equal(worker.url, ENGINE_URL);
    await engine.init();
    assert.deepEqual(worker.posted, ["uci", "setoption name Threads value 1", "setoption name Hash value 16", "isready"]);
  });

  test("evaluate sends the start position with the moves and a node budget, and returns the score and best move", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    const result = await engine.evaluate(START, ["e2e4", "e7e5"], 100_000);
    assert.deepEqual(worker.posted, [`position fen ${START} moves e2e4 e7e5`, "go nodes 100000"]);
    assert.deepEqual(result, { score: { cp: 31 }, best: "e2e4" });
  });

  test("no moves: just the FEN; a mated position has no best move", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = (line) => (line.startsWith("go ") ? ["info depth 0 score mate 0", "bestmove (none)"] : null);
    const result = await engine.evaluate(START, [], 100_000);
    assert.equal(worker.posted[0], `position fen ${START}`);
    assert.deepEqual(result, { score: { mate: 0 }, best: null });
  });

  test("several lines in one message are read one by one", async () => {
    const engine = new StockfishEngine();
    FakeWorker.last.reply = (line) => (line.startsWith("go ") ? [`${INFO}\nbestmove g1f3`] : null);
    assert.deepEqual(await engine.evaluate(START, [], 1_000), { score: { cp: 31 }, best: "g1f3" });
  });

  test("a search that ends without any score is an error, not a made-up eval", async () => {
    const engine = new StockfishEngine();
    FakeWorker.last.reply = (line) => (line.startsWith("go ") ? ["bestmove e2e4"] : null);
    await assert.rejects(engine.evaluate(START, [], 1_000), /without a score/);
  });

  test("newGame clears the engine's memory and waits until it is ready", async () => {
    const engine = new StockfishEngine();
    await engine.newGame();
    assert.deepEqual(FakeWorker.last.posted, ["ucinewgame", "isready"]);
  });
});

describe("StockfishEngine: one search at a time", () => {
  test("a second evaluate isn't sent until the first has its bestmove", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = () => null; // the test answers by hand
    const first = engine.evaluate(START, ["e2e4"], 1_000);
    const second = engine.evaluate(START, ["d2d4"], 1_000);
    await settle();
    assert.deepEqual(worker.posted, [`position fen ${START} moves e2e4`, "go nodes 1000"], "only the first search is with the engine");

    worker.say(INFO, "bestmove e7e5");
    assert.deepEqual(await first, { score: { cp: 31 }, best: "e7e5" });
    await settle();
    assert.deepEqual(worker.posted.slice(2), [`position fen ${START} moves d2d4`, "go nodes 1000"]);
    worker.say("info depth 10 score cp -12 nodes 1000 pv d7d5", "bestmove d7d5");
    assert.deepEqual(await second, { score: { cp: -12 }, best: "d7d5" });
  });

  test("one failed call (no score) doesn't block the next", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = (line) => (line.startsWith("go ") ? ["bestmove e2e4"] : null);
    await assert.rejects(engine.evaluate(START, [], 1_000), EngineError);
    worker.reply = (line) => (line.startsWith("go ") ? [INFO, "bestmove e2e4"] : null);
    assert.deepEqual(await engine.evaluate(START, [], 1_000), { score: { cp: 31 }, best: "e2e4" });
  });
});

describe("StockfishEngine: a worker that fails", () => {
  test("the worker crashes mid-search: the waiting call rejects, and so does every later call", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = () => null;
    const waiting = engine.evaluate(START, [], 1_000);
    const queued = engine.evaluate(START, ["e2e4"], 1_000);
    await settle();
    worker.crash("out of memory");
    await assert.rejects(waiting, (err: unknown) => err instanceof EngineError && /Engine worker failed: out of memory/.test(err.message));
    await assert.rejects(queued, /out of memory/);
    await assert.rejects(engine.newGame(), /out of memory/);
    // Nothing was sent to the dead worker after the crash.
    assert.deepEqual(worker.posted, [`position fen ${START}`, "go nodes 1000"]);
  });

  test("a silent worker: the search gives up after 30 s and the engine is failed for good", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = () => null;
    const waiting = engine.evaluate(START, [], 1_000);
    let settled = false;
    const outcome = waiting.then(
      () => ((settled = true), "resolved"),
      (err: Error) => ((settled = true), err.message),
    );
    await settle();
    mock.timers.tick(29_999);
    await settle();
    assert.equal(settled, false, "still waiting just before the limit");
    mock.timers.tick(1);
    assert.equal(await outcome, `The engine didn't answer "go nodes 1000" within 30 s`);
    // A late answer from the frozen worker changes nothing, and later calls fail fast.
    worker.say(INFO, "bestmove e2e4");
    await assert.rejects(engine.evaluate(START, [], 1_000), /didn't answer/);
  });

  test("the handshake has its own limit: an engine file that never loads fails init after 20 s", async () => {
    mock.timers.enable({ apis: ["setTimeout"] });
    const engine = new StockfishEngine();
    FakeWorker.last.reply = () => null;
    const outcome = engine.init().then(
      () => "resolved",
      (err: Error) => err.message,
    );
    await settle();
    mock.timers.tick(20_000);
    assert.equal(await outcome, `The engine didn't answer "uci" within 20 s`);
  });

  test("terminate during a search: the waiting call rejects with 'Engine stopped' and the worker is terminated", async () => {
    const engine = new StockfishEngine();
    const worker = FakeWorker.last;
    worker.reply = () => null;
    const waiting = engine.evaluate(START, [], 1_000);
    await settle();
    engine.terminate();
    await assert.rejects(waiting, /Engine stopped/);
    assert.equal(worker.terminated, true);
    await assert.rejects(engine.init(), /Engine stopped/);
  });

  test("the first failure is the one reported: a crash, then terminate, still says why it crashed", async () => {
    const engine = new StockfishEngine();
    FakeWorker.last.crash("");
    engine.terminate();
    await assert.rejects(engine.init(), /Engine worker failed: unknown error/);
  });
});
