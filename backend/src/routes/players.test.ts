import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Types } from "mongoose";
import { createApp } from "../app.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { createQueue } from "../jobs/queue.js";
import { encodeCursor } from "../lib/cursor.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { startTestServer } from "../../scripts/testServer.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
let server: Awaited<ReturnType<typeof startTestServer>>;
before(async () => {
  db = await startTestDb();
  server = await startTestServer(
    createApp({ corsOrigins: [], trustProxyHops: 0, getDbStatus: () => true, queue: createQueue(), version: "test" }),
  );
});
after(async () => {
  await server.close();
  await db.stop();
});
beforeEach(clearDb);

const api = (path: string, init?: RequestInit) => fetch(`${server.baseUrl}/api${path}`, init);
const post = (path: string) => api(path, { method: "POST" });

async function makePlayer(username = "Alice") {
  return Player.create({
    platform: "lichess",
    username,
    usernameLower: username.toLowerCase(),
    importState: "ready",
    gamesCount: 25,
    importMeta: { newestGameAt: new Date("2026-10-01T00:00:00Z"), monthEtags: { "2026/10": '"abc"' } },
    lastViewedAt: new Date("2026-01-01T00:00:00Z"),
  });
}

// 25 games, newest first by index; games 10–14 share one playedAt to exercise the _id tie-break.
async function makeGames(playerId: Types.ObjectId) {
  const base = Date.parse("2026-10-01T00:00:00Z");
  await Game.insertMany(
    Array.from({ length: 25 }, (_, i) => ({
      playerId,
      platform: "lichess",
      sourceId: `g${String(i).padStart(2, "0")}`,
      playedAt: new Date(i >= 10 && i < 15 ? base - 10 * 60_000 : base - i * 60_000),
      color: i % 2 === 0 ? "white" : "black",
      result: i % 3 === 0 ? "win" : "loss",
      speed: i < 20 ? "blitz" : "rapid",
      pgn: "1. e4 e5",
      plies: 2,
      clocks: [180, 179],
      // The newest game is analysed, to check what the list leaves out.
      analysis:
        i === 0
          ? {
              status: "done",
              evals: [{ cp: 30 }, { cp: 20 }],
              best: ["e2e4", "c7c5"],
              classifications: ["best", "good"],
              accuracy: 97.5,
            }
          : { status: "pending" },
    })),
  );
}

test("import: invalid platform or username is a 400", async () => {
  for (const path of ["/players/fide/alice/import", "/players/lichess/a/import", "/players/chesscom/al!ce/import"]) {
    const res = await post(path);
    assert.equal(res.status, 400, path);
    assert.deepEqual(await res.json(), { error: "Invalid platform or username" });
  }
  assert.equal(await Job.countDocuments(), 0);
});

test("import is idempotent: the same job comes back while it's active, case-insensitively", async () => {
  const first = await post("/players/lichess/Alice/import");
  assert.equal(first.status, 202);
  const a = (await first.json()) as { jobId: string; created: boolean; status: string };
  assert.equal(a.created, true);
  assert.equal(a.status, "queued");

  const b = (await (await post("/players/lichess/alice/import")).json()) as { jobId: string; created: boolean };
  assert.equal(b.created, false);
  assert.equal(b.jobId, a.jobId);
  assert.equal(await Job.countDocuments(), 1);
});

const hoursAgo = (h: number) => new Date(Date.now() - h * 60 * 60_000);

test("import: a successful import under 6 h old is up to date, unless an import is already active", async () => {
  const player = await makePlayer();

  await Player.updateOne({ _id: player._id }, { $set: { lastImportedAt: hoursAgo(5) } });
  const fresh = await post("/players/lichess/alice/import");
  assert.equal(fresh.status, 200);
  assert.deepEqual(await fresh.json(), { upToDate: true });
  assert.equal(await Job.countDocuments(), 0);

  // An active import is always rejoined, even when the last one was recent.
  const { job } = await createQueue().enqueue({
    type: "import",
    key: "import:lichess:alice",
    payload: { platform: "lichess", username: "alice" },
  });
  const rejoined = (await (await post("/players/lichess/alice/import")).json()) as { jobId: string; created: boolean };
  assert.deepEqual([rejoined.jobId, rejoined.created], [String(job._id), false]);
  await Job.deleteMany({});

  // Older than 6 h, or never imported successfully (lastImportedAt unset): a new import starts.
  await Player.updateOne({ _id: player._id }, { $set: { lastImportedAt: hoursAgo(7) } });
  assert.equal((await post("/players/lichess/alice/import")).status, 202);
  await Job.deleteMany({});
  await Player.updateOne({ _id: player._id }, { $unset: { lastImportedAt: 1 } });
  assert.equal((await post("/players/lichess/alice/import")).status, 202);
});

test("player: lastViewedAt is written at most once an hour, and a view never bumps updatedAt", async () => {
  const player = await makePlayer();
  const recent = hoursAgo(0.5);
  await Player.updateOne({ _id: player._id }, { $set: { lastViewedAt: recent } });
  const before = (await Player.findById(player._id).lean())!;

  assert.equal((await api("/players/lichess/alice")).status, 200);
  let stored = (await Player.findById(player._id).lean())!;
  assert.equal(stored.lastViewedAt!.getTime(), recent.getTime());

  await Player.updateOne({ _id: player._id }, { $set: { lastViewedAt: hoursAgo(2) } }, { timestamps: false });
  await api("/players/lichess/alice");
  stored = (await Player.findById(player._id).lean())!;
  assert.ok(stored.lastViewedAt! > hoursAgo(0.01));
  assert.equal(stored.updatedAt.getTime(), before.updatedAt.getTime());
});

test("player: 404 when unknown, activeJob only while the first import is queued", async () => {
  assert.equal((await api("/players/lichess/alice")).status, 404);

  const { jobId } = (await (await post("/players/lichess/alice/import")).json()) as { jobId: string };
  const body = (await (await api("/players/lichess/alice")).json()) as { player: unknown; activeJob: { id: string; status: string } };
  assert.equal(body.player, null);
  assert.equal(body.activeJob.id, jobId);
  assert.equal(body.activeJob.status, "queued");
});

test("player: public fields only, and viewing bumps lastViewedAt", async () => {
  const created = await makePlayer();
  const res = await api("/players/lichess/ALICE");
  assert.equal(res.status, 200);
  const { player, activeJob } = (await res.json()) as { player: Record<string, unknown>; activeJob: unknown };
  assert.equal(activeJob, null);
  assert.equal(player.id, String(created._id));
  assert.equal(player.username, "Alice");
  assert.equal(player.gamesCount, 25);
  for (const hidden of ["_id", "importMeta", "lastViewedAt", "__v"]) assert.equal(hidden in player, false, hidden);

  const stored = await Player.findById(created._id);
  assert.ok(stored!.lastViewedAt! > new Date("2026-01-01T00:00:00Z"));
});

test("games: cursor pages walk every game exactly once, newest first, ties broken by _id", async () => {
  const player = await makePlayer();
  await makeGames(player._id);
  const expected = (await Game.find({ playerId: player._id }).sort({ playedAt: -1, _id: -1 }).lean()).map((g) => String(g._id));

  const seen: string[] = [];
  const pageSizes: number[] = [];
  let cursor: string | null = null;
  do {
    const query: string = cursor ? `?limit=10&cursor=${cursor}` : "?limit=10";
    const res = await api(`/players/lichess/alice/games${query}`);
    assert.equal(res.status, 200);
    const page = (await res.json()) as { games: Array<Record<string, unknown>>; nextCursor: string | null };
    pageSizes.push(page.games.length);
    seen.push(...page.games.map((g) => g.id as string));
    // The list view leaves the heavy fields out.
    for (const hidden of ["pgn", "clocks", "playerId", "_id"]) assert.equal(hidden in page.games[0]!, false, hidden);
    cursor = page.nextCursor;
  } while (cursor);

  assert.deepEqual(pageSizes, [10, 10, 5]);
  assert.deepEqual(seen, expected);
});

test("games: the list sends classifications and accuracy, not evals or best moves", async () => {
  const player = await makePlayer();
  await makeGames(player._id);
  const page = (await (await api("/players/lichess/alice/games?limit=1")).json()) as {
    games: Array<{ sourceId: string; analysis: Record<string, unknown> }>;
  };
  assert.equal(page.games[0]!.sourceId, "g00");
  assert.deepEqual(page.games[0]!.analysis, { status: "done", classifications: ["best", "good"], accuracy: 97.5 });
});

test("games: filters combine with the cursor", async () => {
  const player = await makePlayer();
  await makeGames(player._id);
  const res = await api("/players/lichess/alice/games?speed=blitz&color=white&limit=4");
  const first = (await res.json()) as { games: Array<{ speed: string; color: string }>; nextCursor: string };
  assert.equal(first.games.length, 4);
  assert.ok(first.games.every((g) => g.speed === "blitz" && g.color === "white"));

  const rest = (await (await api(`/players/lichess/alice/games?speed=blitz&color=white&limit=50&cursor=${first.nextCursor}`)).json()) as {
    games: unknown[];
    nextCursor: string | null;
  };
  // 10 white blitz games in total (even indexes 0–18).
  assert.equal(rest.games.length, 6);
  assert.equal(rest.nextCursor, null);
});

test("games: bad query values and cursors are 400, unknown player is 404", async () => {
  await makePlayer();
  const forged = Buffer.from(JSON.stringify({ t: "soon", id: "x" })).toString("base64url");
  for (const query of ["?limit=0", "?limit=51", "?speed=hyper", "?cursor=garbage", `?cursor=${forged}`]) {
    const res = await api(`/players/lichess/alice/games${query}`);
    assert.equal(res.status, 400, query);
  }
  const valid = encodeCursor({ playedAt: new Date(), id: (await Player.findOne())!._id });
  assert.equal((await api(`/players/lichess/alice/games?cursor=${valid}`)).status, 200);
  assert.equal((await api("/players/lichess/nobody/games")).status, 404);
});
