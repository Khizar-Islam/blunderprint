import { parseBestMove, SearchCollector, type EngineScore } from "./uci";

// One Stockfish engine in one Web Worker. A Web Worker is a script the browser runs on its
// own thread, so the engine's heavy search never freezes the page. We talk to it only by
// posting UCI text lines and listening for the lines it posts back; this class turns that
// conversation into awaitable calls.
//
// The file is the lite single-threaded build copied into public/engine/ by
// scripts/copy-engine.mjs. It finds its .wasm by swapping ".js" for ".wasm" in its own URL,
// so the two files only have to sit next to each other.

export const ENGINE_URL = "/engine/stockfish-19-lite-single.js";
export const ENGINE_ID = "sf19-lite"; // what the API stores as analysis.engine

// One search should take well under a second at our node budgets. If the worker goes silent
// for this long (crashed, or the tab was frozen and the worker died), give up on it.
const SEARCH_TIMEOUT_MS = 30_000;
const HANDSHAKE_TIMEOUT_MS = 20_000; // first load: download + compile the 1.8 MB .wasm

export interface Evaluation {
  score: EngineScore; // from the side to move's point of view, as Stockfish reports it
  best: string | null; // null when there is no legal move (checkmate / stalemate)
}

export class EngineError extends Error {}

// What the analysis code needs from an engine. The scheduler's tests pass a fake with these
// methods, so they run in Node without a Web Worker.
export type EngineLike = Pick<StockfishEngine, "init" | "newGame" | "evaluate" | "terminate">;

export class StockfishEngine {
  private worker: Worker;
  private listener: ((line: string) => void) | null = null;
  private failed: EngineError | null = null;
  // Calls are queued: UCI is one conversation, so a second search must wait for the first.
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    this.worker = new Worker(ENGINE_URL);
    this.worker.onmessage = (e: MessageEvent) => {
      // The worker posts one line per message (sometimes a few joined by newlines).
      const text = typeof e.data === "string" ? e.data : String(e.data);
      for (const line of text.split("\n")) if (line) this.listener?.(line);
    };
    this.worker.onerror = (e) => {
      e.preventDefault();
      this.fail(new EngineError(`Engine worker failed: ${e.message || "unknown error"}`));
    };
  }

  // The UCI handshake: "uci" → "uciok", then "isready" → "readyok" once it's loaded.
  init(): Promise<void> {
    return this.enqueue(async () => {
      await this.sendAndWait("uci", (l) => l === "uciok", HANDSHAKE_TIMEOUT_MS);
      // Defaults made explicit: 1 thread (this build has no others) and a small hash table,
      // because up to two engines run at once on visitors' laptops and phones.
      this.post("setoption name Threads value 1");
      this.post("setoption name Hash value 16");
      await this.sendAndWait("isready", (l) => l === "readyok", HANDSHAKE_TIMEOUT_MS);
    });
  }

  // Clears the engine's memory of the previous game, so evals don't depend on what it saw before.
  newGame(): Promise<void> {
    return this.enqueue(async () => {
      this.post("ucinewgame");
      await this.sendAndWait("isready", (l) => l === "readyok", SEARCH_TIMEOUT_MS);
    });
  }

  // Evaluates the position reached after `moves` from `startFen`, searching exactly `nodes`
  // nodes (positions visited). A node budget instead of a time limit or a depth makes the
  // cost per position predictable on any machine, and the result the same on fast and slow
  // ones. The moves (not just the final FEN) are sent so the engine sees repetitions.
  evaluate(startFen: string, moves: string[], nodes: number): Promise<Evaluation> {
    return this.enqueue(async () => {
      this.post(`position fen ${startFen}${moves.length ? ` moves ${moves.join(" ")}` : ""}`);
      const collector = new SearchCollector();
      let best: string | null | undefined;
      await this.sendAndWait(
        `go nodes ${nodes}`,
        (line) => {
          collector.push(line);
          best = parseBestMove(line);
          return best !== undefined;
        },
        SEARCH_TIMEOUT_MS,
      );
      const score = collector.score;
      if (!score) throw new EngineError("The engine finished without a score");
      return { score, best: best ?? null };
    });
  }

  terminate(): void {
    this.fail(new EngineError("Engine stopped"));
    this.worker.terminate();
  }

  private post(line: string) {
    this.worker.postMessage(line);
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (this.failed) throw this.failed;
      return task();
    });
    this.queue = run.catch(() => undefined); // one failed call doesn't block the queue
    return run;
  }

  private fail(err: EngineError) {
    this.failed ??= err;
    this.listener?.("\u0000fail"); // wake whoever is waiting; sendAndWait checks this.failed
  }

  // Posts a command and resolves on the first line `done` accepts.
  private sendAndWait(command: string, done: (line: string) => boolean, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listener = null;
        this.fail(new EngineError(`The engine didn't answer "${command}" within ${timeoutMs / 1000} s`));
        reject(this.failed);
      }, timeoutMs);
      this.listener = (line) => {
        if (this.failed) {
          clearTimeout(timer);
          this.listener = null;
          reject(this.failed);
          return;
        }
        if (done(line)) {
          clearTimeout(timer);
          this.listener = null;
          resolve();
        }
      };
      this.post(command);
    });
  }
}
