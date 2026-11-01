import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AnalysisClaim } from "@/lib/api";
import type { AnalysisResult } from "./analyseGame";
import { AnalysisScheduler, defaultEngineCount, type LockManagerLike, type SchedulerEvent } from "./scheduler";
import type { EngineLike, Evaluation } from "./stockfish";

const PGN = "1. e4 e5 2. Nf3 Nc6 *"; // 4 plies

class HttpErr extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

// An engine that answers instantly (or after `delayMs`), so tests are about the scheduling.
function fakeEngine(log: string[], delayMs = 0): EngineLike {
  return {
    init: async () => void log.push("init"),
    newGame: async () => {},
    evaluate: async (): Promise<Evaluation> => {
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return { score: { cp: 20 }, best: "e2e4" };
    },
    terminate: () => void log.push("terminate"),
  };
}

// A server holding `count` pending games, handing out up to 3 per claim like the real route.
function fakeApi(count: number) {
  const pending = Array.from({ length: count }, (_, i) => `g${i}`);
  const posted: { claimId: string; result: AnalysisResult }[] = [];
  const released: { claimId: string; gameIds: string[]; beacon: boolean }[] = [];
  let claims = 0;
  const api = {
    postFails: [] as number[], // statuses to throw on the next posts, in order
    async claim(): Promise<AnalysisClaim> {
      const claimId = `c${claims++}`;
      const games = pending.splice(0, 3).map((id) => ({ id, pgn: PGN, plies: 4, color: "white" as const }));
      return { claimId, expiresAt: "", engine: "sf19-lite", games };
    },
    async postResult(claimId: string, result: AnalysisResult) {
      const status = api.postFails.shift();
      if (status) throw new HttpErr(status);
      posted.push({ claimId, result });
      return { classifications: [] };
    },
    release(claimId: string, gameIds: string[], { beacon }: { beacon: boolean }) {
      released.push({ claimId, gameIds, beacon });
    },
  };
  return { api, posted, released, claimCount: () => claims };
}

function setup(count: number, extra: { delayMs?: number; engines?: number; locks?: LockManagerLike | null } = {}) {
  const server = fakeApi(count);
  const log: string[] = [];
  const events: SchedulerEvent[] = [];
  let pageHide: (() => void) | null = null;
  const scheduler = new AnalysisScheduler({
    api: server.api,
    createEngine: () => fakeEngine(log, extra.delayMs),
    onEvent: (e) => events.push(e),
    engines: extra.engines ?? 2,
    locks: extra.locks ?? null,
    sleep: async () => {}, // retries without waiting
    onPageHide: (handler) => {
      pageHide = handler;
      return () => (pageHide = null);
    },
  });
  const idle = () => waitFor(events, (e) => e.type === "state" && (e.state === "idle" || e.state === "stopped"));
  return { ...server, log, events, scheduler, idle, firePageHide: () => pageHide?.() };
}

async function waitFor(events: SchedulerEvent[], match: (e: SchedulerEvent) => boolean, from = 0) {
  for (let i = 0; i < 500; i++) {
    if (events.slice(from).some(match)) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("timed out waiting for an event");
}

const states = (events: SchedulerEvent[]) => events.flatMap((e) => (e.type === "state" ? [e.state] : []));

describe("AnalysisScheduler", () => {
  test("analyses every game exactly once across 2 engines, then goes idle", async () => {
    const t = setup(7);
    t.scheduler.start();
    await t.idle();
    const ids = t.posted.map((p) => p.result.gameId).sort();
    assert.deepEqual(ids, ["g0", "g1", "g2", "g3", "g4", "g5", "g6"]);
    for (const { result } of t.posted) {
      assert.ok(!("error" in result));
      assert.equal(result.evals.length, 4);
      assert.equal(result.best.length, 4);
      assert.deepEqual(result.moves, ["e2e4", "e7e5", "g1f3", "b8c6"]);
      assert.equal(result.nodes, 100_000);
    }
    // 7 games in claims of 3 → 3 claims with games + 1 empty claim that ends the session
    assert.equal(t.claimCount(), 4);
    assert.deepEqual(states(t.events), ["running", "idle"]);
    assert.equal(t.log.filter((l) => l === "terminate").length, 2); // engines stopped when idle
    assert.deepEqual(t.released, []); // nothing left to hand back
  });

  test("results go to the claim that leased the game", async () => {
    const t = setup(4, { engines: 1 });
    t.scheduler.start();
    await t.idle();
    assert.deepEqual(
      t.posted.map((p) => `${p.claimId}:${p.result.gameId}`),
      ["c0:g0", "c0:g1", "c0:g2", "c1:g3"],
    );
  });

  test("ply events stream for each game", async () => {
    const t = setup(1, { engines: 1 });
    t.scheduler.start();
    await t.idle();
    const plies = t.events.flatMap((e) => (e.type === "ply" ? [e.ply] : []));
    assert.deepEqual(plies, [1, 2, 3, 4]);
    assert.ok(t.events.some((e) => e.type === "game-done" && e.gameId === "g0"));
  });

  test("pausing mid-game hands the unfinished games back and stops", async () => {
    const t = setup(3, { engines: 1, delayMs: 5 });
    t.scheduler.start();
    await waitFor(t.events, (e) => e.type === "ply");
    await t.scheduler.stop();
    assert.deepEqual(t.posted, []); // the aborted game's partial result is never posted
    assert.deepEqual(t.released, [{ claimId: "c0", gameIds: ["g0", "g1", "g2"], beacon: false }]);
    assert.equal(t.scheduler.currentState, "stopped");
    assert.ok(t.log.includes("terminate"));
  });

  // Worker B finishes a short game (g0) and starts posting it; the post is held open by a gate.
  // Meanwhile worker A is halfway through a longer game (g1), and g2 waits in the queue.
  function postInFlight() {
    const SHORT = "1. e4 e5 *"; // 2 plies
    const LONG = "1. e4 e5 2. Nf3 Nc6 3. Bc4 Bc5 4. c3 Nf6 5. d4 exd4 *"; // 10 plies
    const t = setup(0, { engines: 2, delayMs: 5 });
    let claims = 0;
    t.api.claim = async () => ({
      claimId: `c${claims}`,
      expiresAt: "",
      engine: "sf19-lite",
      games: claims++
        ? []
        : [
            { id: "g0", pgn: SHORT, plies: 2, color: "white" as const },
            { id: "g1", pgn: LONG, plies: 10, color: "white" as const },
            { id: "g2", pgn: LONG, plies: 10, color: "white" as const },
          ],
    });
    let postStarted!: () => void;
    let openGate!: () => void;
    const started = new Promise<void>((r) => (postStarted = r));
    const gate = new Promise<void>((r) => (openGate = r));
    const realPost = t.api.postResult;
    t.api.postResult = async (claimId, result) => {
      if (result.gameId === "g0") {
        postStarted();
        await gate;
      }
      return realPost(claimId, result);
    };
    return { t, started, openGate };
  }

  test("pause while the other worker is posting a finished game: it's stored, only unfinished games go back", async () => {
    const { t, started, openGate } = postInFlight();
    t.scheduler.start();
    await started;
    const stopping = t.scheduler.stop();
    await new Promise((r) => setTimeout(r, 50)); // worker A has long since stopped on the abort
    // Nothing is handed back while g0's result is still on its way (Promise.all released it here).
    assert.deepEqual(t.released, []);
    openGate();
    await stopping;
    assert.deepEqual(
      t.posted.map((p) => p.result.gameId),
      ["g0"],
    );
    assert.deepEqual(t.released, [{ claimId: "c0", gameIds: ["g1", "g2"], beacon: false }]);
    assert.ok(!t.events.some((e) => e.type === "game-lost"));
    assert.ok(t.events.some((e) => e.type === "game-done" && e.gameId === "g0"));
    assert.equal(t.scheduler.currentState, "stopped");
  });

  test("pagehide while a result is being posted: the beacon leaves that game out", async () => {
    const { t, started, openGate } = postInFlight();
    t.scheduler.start();
    await started;
    t.firePageHide();
    // The beacon goes at once (the page is closing), without g0.
    assert.deepEqual(t.released, [{ claimId: "c0", gameIds: ["g1", "g2"], beacon: true }]);
    openGate();
    await t.idle();
    assert.deepEqual(
      t.posted.map((p) => p.result.gameId),
      ["g0"],
    );
    assert.equal(t.released.length, 1); // g0 is never released afterwards either
  });

  test("pagehide hands games back with a beacon", async () => {
    const t = setup(3, { engines: 1, delayMs: 5 });
    t.scheduler.start();
    await waitFor(t.events, (e) => e.type === "ply");
    t.firePageHide();
    await t.idle();
    assert.deepEqual(t.released, [{ claimId: "c0", gameIds: ["g0", "g1", "g2"], beacon: true }]);
    assert.equal(t.scheduler.currentState, "stopped");
  });

  test("a 409 (another tab took the game) is dropped and the rest carries on", async () => {
    const t = setup(2, { engines: 1 });
    t.api.postFails.push(409);
    t.scheduler.start();
    await t.idle();
    assert.ok(t.events.some((e) => e.type === "game-lost" && e.gameId === "g0"));
    assert.deepEqual(
      t.posted.map((p) => p.result.gameId),
      ["g1"],
    );
    assert.deepEqual(states(t.events), ["running", "idle"]);
  });

  test("a network error or 5xx on a result is retried", async () => {
    const t = setup(1, { engines: 1 });
    t.api.postFails.push(0, 503);
    t.scheduler.start();
    await t.idle();
    assert.deepEqual(
      t.posted.map((p) => p.result.gameId),
      ["g0"],
    );
  });

  test("a 400 on a result is reported, not retried, and not released (no reclaim loop)", async () => {
    const t = setup(2, { engines: 1 });
    t.api.postFails.push(400);
    t.scheduler.start();
    await t.idle();
    assert.ok(t.events.some((e) => e.type === "error" && e.message.includes("g0")));
    assert.deepEqual(
      t.posted.map((p) => p.result.gameId),
      ["g1"],
    );
    assert.deepEqual(t.released, []);
  });

  test("an engine crash stops the session and hands its games back", async () => {
    const t = setup(3, { engines: 1 });
    const crashing = new AnalysisScheduler({
      api: t.api,
      createEngine: () => ({ ...fakeEngine(t.log), init: async () => Promise.reject(new Error("wasm failed")) }),
      onEvent: (e) => t.events.push(e),
      engines: 1,
      locks: null,
    });
    crashing.start();
    await t.idle();
    assert.ok(t.events.some((e) => e.type === "error" && e.message === "wasm failed"));
    assert.equal(crashing.currentState, "stopped");
  });

  test("an unreplayable PGN is reported as illegal_pgn", async () => {
    const t = setup(0, { engines: 1 });
    let claims = 0;
    // First claim: one game with an illegal move (2. Ke3); then no more games.
    t.api.claim = async () => ({
      claimId: "cx",
      expiresAt: "",
      engine: "sf19-lite",
      games: claims++ ? [] : [{ id: "bad", pgn: "1. e4 e5 2. Ke3 *", plies: 4, color: "white" }],
    });
    t.scheduler.start();
    await t.idle();
    assert.deepEqual(t.posted[0]?.result, { gameId: "bad", error: "illegal_pgn", atPly: undefined });
    assert.ok(t.events.some((e) => e.type === "game-unanalysable"));
  });

  test("with the lock held by another tab: waits, then runs when it's free", async () => {
    let release!: () => void;
    let held = true;
    const locks: LockManagerLike = {
      async request(_name, options, callback) {
        if (options.ifAvailable && held) return callback(null);
        if (held) await new Promise<void>((r) => (release = () => ((held = false), r())));
        return callback({});
      },
    };
    const t = setup(1, { engines: 1, locks });
    t.scheduler.start();
    await waitFor(t.events, (e) => e.type === "state" && e.state === "waiting");
    assert.deepEqual(t.posted, []);
    release();
    await t.idle();
    assert.deepEqual(states(t.events), ["waiting", "running", "idle"]);
    assert.equal(t.posted.length, 1);
  });

  test("start() while running is a no-op; start() when idle claims again", async () => {
    const t = setup(1, { engines: 1 });
    t.scheduler.start();
    t.scheduler.start();
    await t.idle();
    assert.equal(t.claimCount(), 2);
    const from = t.events.length;
    t.scheduler.start(); // e.g. the import added games
    await waitFor(t.events, (e) => e.type === "state" && e.state === "idle", from);
    assert.equal(t.claimCount(), 3);
    assert.deepEqual(states(t.events.slice(from)), ["running", "idle"]);
  });
});

describe("defaultEngineCount", () => {
  test("2 engines on 4+ cores, otherwise 1", () => {
    assert.equal(defaultEngineCount(8), 2);
    assert.equal(defaultEngineCount(4), 2);
    assert.equal(defaultEngineCount(2), 1);
    assert.equal(defaultEngineCount(1), 1);
  });
});
