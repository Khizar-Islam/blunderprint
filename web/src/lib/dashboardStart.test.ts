import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError, type Player } from "./api";
import { startDashboard, type StartDeps } from "./dashboardStart";

// A promise we settle by hand, to see what has started while a request is still out.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

const player = { username: "DrNykterstein" } as unknown as Player;

function fakes() {
  const log: string[] = [];
  const playerReq = deferred<Awaited<ReturnType<StartDeps["fetchPlayer"]>>>();
  const importReq = deferred<Awaited<ReturnType<StartDeps["startImport"]>>>();
  const deps: StartDeps = {
    prefetchSummary: (_p, u, q) => void log.push(`summary ${u} "${q}"`),
    fetchPlayer: () => (log.push("player"), playerReq.promise),
    startImport: () => (log.push("import"), importReq.promise),
  };
  return { log, deps, playerReq, importReq };
}

test("the summary starts in parallel: before the player lookup answers, not after the import check", async () => {
  const { log, deps, playerReq, importReq } = fakes();
  const done = startDashboard("lichess", "DrNykterstein", "speed=blitz", new AbortController().signal, deps);
  // Nothing has answered yet, and the summary request is already out, alongside the player lookup.
  assert.deepEqual(log, ['summary DrNykterstein "speed=blitz"', "player"]);
  playerReq.resolve({ player, activeJob: null } as never);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(log, ['summary DrNykterstein "speed=blitz"', "player", "import"]);
  importReq.resolve({ kind: "upToDate" } as never); // a frozen demo player: 200 { upToDate, frozen }
  assert.deepEqual(await done, { player, jobId: null });
});

test("unchanged: an active import is followed, with no new import request", async () => {
  const { log, deps, playerReq } = fakes();
  const done = startDashboard("lichess", "x", "", new AbortController().signal, deps);
  playerReq.resolve({ player, activeJob: { id: "job-1" } } as never);
  assert.deepEqual(await done, { player, jobId: "job-1" });
  assert.equal(log.includes("import"), false);
});

test("unchanged: a player never imported (404) gets a first import", async () => {
  const { deps, playerReq, importReq } = fakes();
  const done = startDashboard("chesscom", "newcomer", "", new AbortController().signal, deps);
  playerReq.reject(new ApiError(404, "Player not found"));
  await new Promise((r) => setTimeout(r, 0));
  importReq.resolve({ kind: "job", jobId: "job-2" } as never);
  assert.deepEqual(await done, { player: null, jobId: "job-2" });
});

test("unchanged: any other error is thrown, so the waking hook retries", async () => {
  const { deps, playerReq } = fakes();
  const done = startDashboard("lichess", "x", "", new AbortController().signal, deps);
  playerReq.reject(new ApiError(503, "Unavailable"));
  await assert.rejects(done, /Unavailable/);
});
