import type { AnalysisClaim, MoveClass } from "@/lib/api";
import { analyseGame, type AnalysisResult } from "./analyseGame";
import type { EngineLike } from "./stockfish";
import type { WhiteEval } from "./uci";

// Runs the browser side of CLAUDE.md 8.2: claim games from the server, analyse them with 1–2
// engines, post the results, and claim more until none are left.
//
// One "session" = take the lock → start engines → claim/analyse/post until there's no work
// (or a pause) → hand back unfinished games → stop engines → free the lock.
//
// - Web Locks: navigator.locks is a browser API for locks shared by every tab of the same site.
//   Only the tab holding "blunderprint:engine" runs engines, so two open tabs never fight over
//   the CPU. The second tab waits, and takes over by itself when the first closes or pauses.
// - Leases: every claimed game is "held" until its result is posted. Pausing hands the held
//   games back with a normal request; closing the tab (pagehide) uses sendBeacon, which the
//   browser still delivers after the page is gone. If even that's lost, the 10-minute lease
//   on the server frees them.
// - Everything outside (engine, API, locks, page events, timers) is passed in, so the tests
//   run this in Node with fakes.

export const DEFAULT_NODES = 100_000; // measured 1 Nov 2026: ~150 ms per position on my laptop
export const LOCK_NAME = "blunderprint:engine";

// More engines than this would slow the page itself down; most phones get one.
export function defaultEngineCount(hardwareConcurrency = globalThis.navigator?.hardwareConcurrency ?? 2): number {
  return hardwareConcurrency >= 4 ? 2 : 1;
}

export type SchedulerState = "stopped" | "waiting" | "running" | "idle";

export type SchedulerEvent =
  | { type: "state"; state: SchedulerState }
  | { type: "game-start"; gameId: string; plies: number }
  | { type: "ply"; gameId: string; ply: number; eval: WhiteEval }
  | { type: "game-done"; gameId: string; classifications?: MoveClass[]; accuracy?: number }
  | { type: "game-unanalysable"; gameId: string }
  | { type: "game-lost"; gameId: string } // another tab reclaimed it (409); not an error
  | { type: "error"; message: string };

export interface SchedulerApi {
  claim(prefer: string | undefined, signal: AbortSignal): Promise<AnalysisClaim>;
  postResult(claimId: string, result: AnalysisResult): Promise<{ classifications?: MoveClass[]; accuracy?: number }>;
  release(claimId: string, gameIds: string[], options: { beacon: boolean }): void;
}

// The subset of the Web Locks API we use (navigator.locks in a browser).
export interface LockManagerLike {
  request(
    name: string,
    options: { ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<void>,
  ): Promise<unknown>;
}

export interface SchedulerOptions {
  api: SchedulerApi;
  createEngine: () => EngineLike;
  onEvent: (event: SchedulerEvent) => void;
  nodes?: number;
  engines?: number;
  prefer?: string; // the game the review page is showing goes first
  locks?: LockManagerLike | null; // null: no Web Locks (old browser): run without one
  onPageHide?: (handler: () => void) => () => void; // subscribe; returns unsubscribe
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

// Thrown by the API client for non-2xx answers; only the status matters here.
const statusOf = (err: unknown) => (err && typeof err === "object" && "status" in err ? Number(err.status) : 0);
const isAbort = (err: unknown) => err instanceof DOMException && err.name === "AbortError";
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

// Network errors (status 0: no answer, or the free API is waking up) and 5xx are worth
// retrying. 4xx are answers: retrying won't change them.
const retryable = (err: unknown) => statusOf(err) === 0 || statusOf(err) >= 500;
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

export class AnalysisScheduler {
  private readonly opts: Required<Omit<SchedulerOptions, "prefer" | "onPageHide" | "locks">> &
    Pick<SchedulerOptions, "prefer" | "onPageHide" | "locks">;
  private session: { abort: AbortController; done: Promise<void> } | null = null;
  private state: SchedulerState = "stopped";

  constructor(options: SchedulerOptions) {
    this.opts = {
      nodes: DEFAULT_NODES,
      engines: defaultEngineCount(),
      sleep: defaultSleep,
      ...options,
    };
  }

  get currentState(): SchedulerState {
    return this.state;
  }

  // Starts a session unless one is already running. Also the way to say "there may be new
  // games now" (e.g. the import added some): an idle scheduler claims again.
  start(): void {
    if (this.session) return;
    const abort = new AbortController();
    const done = this.runLocked(abort.signal)
      .catch((err) => {
        if (!isAbort(err)) this.emit({ type: "error", message: message(err) });
      })
      .finally(() => {
        this.session = null;
        // A pause ends in "stopped"; running out of work ends in "idle" (set by the session).
        if (abort.signal.aborted || this.state !== "idle") this.setState("stopped");
      });
    this.session = { abort, done };
  }

  // Pauses: aborts the current games (their results are dropped), hands them back, stops the
  // engines. Resolves once everything is wound down.
  async stop(): Promise<void> {
    const session = this.session;
    if (!session) return;
    session.abort.abort();
    await session.done;
  }

  private emit(event: SchedulerEvent) {
    this.opts.onEvent(event);
  }

  private setState(state: SchedulerState) {
    if (state === this.state) return;
    this.state = state;
    this.emit({ type: "state", state });
  }

  private async runLocked(signal: AbortSignal): Promise<void> {
    const { locks } = this.opts;
    if (!locks) return this.runSession(signal);
    // Try without waiting first, so the UI only says "waiting for another tab" when it is.
    let ran = false;
    await locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      ran = true;
      await this.runSession(signal);
    });
    if (ran) return;
    this.setState("waiting");
    // Rejects with an AbortError if we're paused while still waiting.
    await locks.request(LOCK_NAME, { signal }, () => this.runSession(signal));
  }

  private async runSession(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.setState("running");

    const queue: { claimId: string; game: AnalysisClaim["games"][number] }[] = [];
    const held = new Map<string, string>(); // gameId → claimId, until its result is posted
    const posting = new Set<string>(); // finished games whose result is on its way to the server
    let exhausted = false;
    let claiming: Promise<void> | null = null;
    let prefer = this.opts.prefer;

    // Hands back the games we hold but won't finish. Never one whose result is being posted:
    // the release could reach the server first, and the finished result would then get a 409
    // and be lost.
    const releaseHeld = (beacon: boolean) => {
      const byClaim = new Map<string, string[]>();
      for (const [gameId, claimId] of held) {
        if (posting.has(gameId)) continue;
        byClaim.set(claimId, [...(byClaim.get(claimId) ?? []), gameId]);
        held.delete(gameId);
      }
      for (const [claimId, gameIds] of byClaim) this.opts.api.release(claimId, gameIds, { beacon });
      queue.length = 0;
    };

    // The tab is closing (or going into the back/forward cache): hand the unfinished games back
    // now, with a beacon, because a normal request may never leave a page that's going away.
    // A result already being posted is left to finish (the API client sends it with keepalive).
    const internal = new AbortController();
    const onAbort = () => internal.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const unsubscribe = this.opts.onPageHide?.(() => {
      releaseHeld(true);
      internal.abort(new DOMException("Page hidden", "AbortError"));
    });
    const sig = internal.signal;

    const claimMore = async () => {
      const claim = await this.withRetry(() => this.opts.api.claim(prefer, sig), sig);
      prefer = undefined; // only the first claim asks for it
      if (claim.games.length === 0) exhausted = true;
      for (const game of claim.games) {
        held.set(game.id, claim.claimId);
        queue.push({ claimId: claim.claimId, game });
      }
    };

    // Workers share one queue; when it's empty, one of them claims more and the others wait
    // for that same claim instead of each sending their own.
    const next = async () => {
      for (;;) {
        sig.throwIfAborted();
        const item = queue.shift();
        if (item) return item;
        if (exhausted) return null;
        claiming ??= claimMore().finally(() => (claiming = null));
        await claiming;
      }
    };

    const work = async (engine: EngineLike) => {
      await engine.init();
      for (let item = await next(); item; item = await next()) {
        const { claimId, game } = item;
        this.emit({ type: "game-start", gameId: game.id, plies: game.plies });
        const result = await analyseGame(engine, game, {
          nodes: this.opts.nodes,
          signal: sig,
          onPly: (ply, e) => this.emit({ type: "ply", gameId: game.id, ply, eval: e }),
        });
        posting.add(game.id);
        try {
          await this.post(claimId, result, sig);
        } finally {
          posting.delete(game.id);
        }
        // Posted (or answered for good). If the post failed outright, the game stays held and
        // the finally below hands it back.
        held.delete(game.id);
      }
    };

    const engines = Array.from({ length: this.opts.engines }, () => this.opts.createEngine());
    try {
      // If one engine fails, abort the other too: the session ends and its games go back.
      // allSettled, not all: Promise.all would reject on the first error (or the AbortError of a
      // pause) while the other worker may still be posting a finished result. The finally below
      // must only release games once every worker has stopped, or that result gets a 409.
      const outcomes = await Promise.allSettled(
        engines.map((engine) =>
          work(engine).catch((err) => {
            internal.abort(err);
            throw err;
          }),
        ),
      );
      const failures = outcomes.flatMap((o) => (o.status === "rejected" ? [o.reason as unknown] : []));
      // The first real error, not the AbortErrors it caused in the other worker; else the abort.
      const failure = failures.find((err) => !isAbort(err)) ?? failures[0];
      if (failure !== undefined) throw failure;
      this.setState("idle");
    } finally {
      releaseHeld(false); // after a clean finish nothing is held; after a pagehide, only leftovers
      for (const engine of engines) engine.terminate();
      unsubscribe?.();
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async post(claimId: string, result: AnalysisResult, signal: AbortSignal) {
    try {
      // The post itself isn't aborted by a pause (a finished game is worth keeping), but
      // retries stop.
      const res = await this.withRetry(() => this.opts.api.postResult(claimId, result), signal);
      if ("error" in result) this.emit({ type: "game-unanalysable", gameId: result.gameId });
      else
        this.emit({
          type: "game-done",
          gameId: result.gameId,
          classifications: res.classifications,
          accuracy: res.accuracy,
        });
    } catch (err) {
      const status = statusOf(err);
      if (status === 409) {
        this.emit({ type: "game-lost", gameId: result.gameId });
        return;
      }
      // Any other 4xx means the server rejected our result: a bug on one side. Say so and move
      // on. The game isn't released: it's the newest pending one, so we'd reclaim it at once and
      // loop. Its lease runs out in 10 minutes instead.
      if (status >= 400 && status < 500) {
        this.emit({ type: "error", message: `Result for game ${result.gameId} rejected: ${message(err)}` });
        return;
      }
      throw err;
    }
  }

  private async withRetry<T>(call: () => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (err) {
        if (isAbort(err) || !retryable(err) || attempt >= RETRY_DELAYS_MS.length) throw err;
        await this.opts.sleep(RETRY_DELAYS_MS[attempt]!, signal);
      }
    }
  }
}
