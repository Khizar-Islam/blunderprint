import { after, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { fakeStorage, testGuards } from "../../scripts/testGuards.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { startTestServer } from "../../scripts/testServer.js";
import { createApp, type AppOptions } from "../app.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { Usage } from "../db/models/usage.js";
import { createQueue } from "../jobs/queue.js";
import { demoChecker } from "../lib/demo.js";
import { createEvictor, type Evictor } from "../lib/eviction.js";
import type { GuardLimits } from "../lib/guards.js";
import type { StorageGate } from "../lib/storage.js";

// The Stage 6 guards end to end (CLAUDE.md §10 "Guards"): the import limits per visitor, the
// storage gate and the new-player cap, the import queue cap, the flood guard, and which visitor
// a request belongs to behind Render's proxies (TRUST_PROXY_HOPS).

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

interface Opts {
  limits?: Partial<GuardLimits>;
  storage?: StorageGate;
  evictor?: Evictor;
  hops?: number;
  queue?: AppOptions["queue"];
}

async function withApp({ limits, storage, evictor, hops = 0, queue }: Opts, fn: (api: string) => Promise<void>): Promise<void> {
  const server = await startTestServer(
    createApp({
      corsOrigins: ["http://localhost:3000"],
      trustProxyHops: hops,
      getDbStatus: () => true,
      queue: queue ?? createQueue(),
      version: "test",
      isDemo: demoChecker(["lichess:demoguy"]),
      guards: testGuards(limits, storage, undefined, evictor),
    }),
  );
  try {
    await fn(`${server.baseUrl}/api`);
  } finally {
    await server.close();
  }
}

const importUrl = (api: string, user: string, platform = "lichess") => `${api}/players/${platform}/${user}/import`;
const postImport = (api: string, user: string, headers: Record<string, string> = {}) =>
  fetch(importUrl(api, user), { method: "POST", headers });
const DAY = 24 * 60 * 60_000;

// A stored player whose last import is old enough (> 6 h) for a re-import to start.
const storedPlayer = (username: string, importedAgoMs = 2 * DAY) =>
  Player.create({ platform: "lichess", username, usernameLower: username.toLowerCase(), importState: "ready", lastImportedAt: new Date(Date.now() - importedAgoMs) });

// Access-Control-Expose-Headers as a sorted, lower-case list.
const exposed = (res: Response) =>
  (res.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .sort();

async function body(res: Response): Promise<{ code: string; error: string }> {
  return (await res.json()) as { code: string; error: string };
}

describe("import limits per visitor", () => {
  it("only an import that starts counts; past the hourly limit: 429 limit_imports with Retry-After", async () => {
    await withApp({ limits: { importsPerHour: 2 } }, async (api) => {
      await storedPlayer("fresh", 60_000); // imported a minute ago: up to date
      await storedPlayer("demoguy", 30 * DAY); // a frozen demo player

      assert.equal((await postImport(api, "alice")).status, 202); // 1
      // Free: rejoining alice's queued import, an up-to-date player, a frozen demo player.
      assert.equal((await postImport(api, "alice")).status, 202);
      assert.deepEqual(await (await postImport(api, "fresh")).json(), { upToDate: true });
      assert.deepEqual(await (await postImport(api, "demoguy")).json(), { upToDate: true, frozen: true });
      assert.equal((await postImport(api, "bob")).status, 202); // 2

      const refused = await postImport(api, "carol");
      assert.equal(refused.status, 429);
      const retryAfter = Number(refused.headers.get("retry-after"));
      assert.ok(retryAfter >= 1 && retryAfter <= 3600, String(retryAfter));
      const b = await body(refused);
      assert.equal(b.code, "limit_imports");
      assert.match(b.error, /You can start another in (a minute|about \d+ minutes)\. Players already imported can still be opened\./);
      assert.equal(await Job.countDocuments({ type: "import" }), 2);
      // Still free once refused: rejoining an import already queued.
      assert.equal((await postImport(api, "bob")).status, 202);
    });
  });

  it("the counters are stored under the visitor's hash, never the IP", async () => {
    await withApp({}, async (api) => {
      await postImport(api, "alice");
      const ids = (await Usage.find({}, { _id: 1 }).lean()).map((d) => String(d._id));
      assert.equal(ids.filter((id) => /^ip:[0-9a-f]{32}\|imports\|/.test(id)).length, 2, ids.join()); // hour + day
      assert.ok(ids.every((id) => !/127\.0\.0\.1|::1/.test(id)), ids.join());
    });
  });

  it("an enqueue that fails gives the visitor's import back", async () => {
    const queue: AppOptions["queue"] = {
      depth: async () => 0,
      enqueue: async () => {
        throw new Error("db write failed");
      },
    };
    await withApp({ limits: { importsPerHour: 1 }, queue }, async (api) => {
      assert.equal((await postImport(api, "alice")).status, 500);
      const counts = (await Usage.find({}).lean()).map((d) => d.count);
      assert.ok(counts.every((c) => c === 0), JSON.stringify(counts));
    });
  });
});

describe("automatic refreshes of stored players don't count (trigger=auto)", () => {
  const auto = (api: string, user: string, headers: Record<string, string> = {}) =>
    fetch(`${importUrl(api, user)}?trigger=auto`, { method: "POST", headers });
  const visitorImportCounts = async () =>
    (await Usage.find({ _id: /^ip:.*\|imports\|/ }).lean()).map((d) => d.count);

  it("7 automatic stale refreshes of different stored players in one hour all go through", async () => {
    await withApp({ limits: { importsPerHour: 5, importsPerDay: 15 } }, async (api) => {
      for (let i = 1; i <= 7; i++) await storedPlayer(`stale${i}`);
      for (let i = 1; i <= 7; i++) assert.equal((await auto(api, `stale${i}`)).status, 202, `stale${i}`);
      assert.equal(await Job.countDocuments({ type: "import" }), 7);
      assert.deepEqual(await visitorImportCounts(), [], "nothing counted against the visitor");
    });
  });

  it("a 6th new-player import in an hour is refused with 429, even when the dashboard says auto", async () => {
    await withApp({ limits: { importsPerHour: 5, importsPerDay: 15 } }, async (api) => {
      for (let i = 1; i <= 5; i++) assert.equal((await auto(api, `new${i}`)).status, 202, `new${i}`);
      const refused = await auto(api, "new6");
      assert.equal(refused.status, 429);
      assert.equal((await body(refused)).code, "limit_imports");
      // An automatic refresh of a stored player still goes through for this visitor.
      await storedPlayer("stale");
      assert.equal((await auto(api, "stale")).status, 202);
    });
  });

  it("an explicit refresh of a stored player (trigger=user, or no trigger) counts", async () => {
    await withApp({ limits: { importsPerHour: 1 } }, async (api) => {
      await storedPlayer("alice");
      await storedPlayer("bob");
      assert.equal((await fetch(`${importUrl(api, "alice")}?trigger=user`, { method: "POST" })).status, 202);
      assert.equal((await postImport(api, "bob")).status, 429);
    });
  });

  it("still once per player per 6 h: after a failed automatic refresh the next automatic one is a no-op, a click retries (and counts)", async () => {
    await withApp({ limits: { importsPerHour: 5 } }, async (api) => {
      await storedPlayer("alice");
      assert.equal((await auto(api, "alice")).status, 202);
      await Job.updateMany({}, { $set: { status: "failed" } }); // lastImportedAt stays old
      assert.deepEqual(await (await auto(api, "alice")).json(), { upToDate: true });
      assert.equal(await Job.countDocuments(), 1);
      assert.equal((await fetch(`${importUrl(api, "alice")}?trigger=user`, { method: "POST" })).status, 202);
      assert.deepEqual(await visitorImportCounts(), [1, 1]);
      // 6 h later an automatic refresh may run again.
      await Job.updateMany({}, { $set: { status: "failed" } });
      await Player.updateOne({ usernameLower: "alice" }, { $set: { "importMeta.lastAutoRefreshAt": new Date(Date.now() - 6 * 3_600_000 - 1_000) } });
      assert.equal((await auto(api, "alice")).status, 202);
    });
  });

  it("two tabs at once: one automatic refresh starts; the stamp never shows in GET player", async () => {
    await withApp({}, async (api) => {
      await storedPlayer("alice");
      const results = await Promise.all([auto(api, "alice"), auto(api, "alice"), auto(api, "alice")]);
      assert.equal(await Job.countDocuments(), 1);
      assert.ok(results.every((r) => r.status === 202 || r.status === 200));
      const got = (await (await fetch(`${api}/players/lichess/alice`)).json()) as { player: Record<string, unknown> };
      assert.equal(got.player.importMeta, undefined);
    });
  });

  it("a refused automatic refresh (queue full) gives its 6-hour slot back", async () => {
    await withApp({ limits: { importQueueMax: 1 } }, async (api) => {
      await storedPlayer("alice");
      assert.equal((await postImport(api, "someone")).status, 202); // fills the queue
      assert.equal((await auto(api, "alice")).status, 503);
      await Job.updateMany({}, { $set: { status: "done" } });
      assert.equal((await auto(api, "alice")).status, 202);
    });
  });

  it("an unknown trigger or query key is a 400", async () => {
    await withApp({}, async (api) => {
      assert.equal((await fetch(`${importUrl(api, "alice")}?trigger=robot`, { method: "POST" })).status, 400);
      assert.equal((await fetch(`${importUrl(api, "alice")}?free=1`, { method: "POST" })).status, 400);
    });
  });
});

describe("storage gate and the new-player cap", () => {
  it("database at the limit: a NEW player gets 503 storage_full; a stored player and a demo player still import", async () => {
    const storage = fakeStorage(120, 120);
    await withApp({ storage }, async (api) => {
      await storedPlayer("alice");
      const refused = await postImport(api, "newbie");
      assert.equal(refused.status, 503);
      const b = await body(refused);
      assert.equal(b.code, "storage_full");
      assert.match(b.error, /Players already imported still work/);
      assert.equal((await postImport(api, "alice")).status, 202, "a stored player's re-import");
      assert.equal((await postImport(api, "demoguy")).status, 202, "a demo player's first import seeds it");
      // A refusal for a full database doesn't use up the visitor's imports.
      const ids = (await Usage.find({}).lean()).map((d) => `${d._id}=${d.count}`);
      assert.equal(ids.filter((id) => id.endsWith("=1")).length, 2, ids.join()); // alice's hour + day only
      storage.set(119.9);
      assert.equal((await postImport(api, "newbie")).status, 202);
    });
  });

  it("/api/health shows the storage reading and the limit", async () => {
    await withApp({ storage: fakeStorage(42.5, 120) }, async (api) => {
      const health = (await (await fetch(`${api}/health`)).json()) as Record<string, unknown>;
      assert.equal(health.storageMb, 42.5);
      assert.equal(health.storageLimitMb, 120);
    });
  });

  it("past the new players per day: 503 limit_new_players, the visitor's import is given back, re-imports go on", async () => {
    await withApp({ limits: { newPlayersPerDay: 1 } }, async (api) => {
      await storedPlayer("alice");
      assert.equal((await postImport(api, "newbie")).status, 202);
      const refused = await postImport(api, "another");
      assert.equal(refused.status, 503);
      assert.ok(Number(refused.headers.get("retry-after")) > 0);
      assert.equal((await body(refused)).code, "limit_new_players");
      assert.equal((await postImport(api, "alice")).status, 202);
      const visitorDay = (await Usage.find({ _id: /^ip:.*\|imports\|\d{4}-\d{2}-\d{2}$/ }).lean())[0];
      assert.equal(visitorDay!.count, 2, "newbie + alice; the refused one was refunded");
    });
  });
});

describe("the import queue cap", () => {
  it("with IMPORT_QUEUE_MAX imports already queued, a new one gets 503 busy (Retry-After 60)", async () => {
    await withApp({ limits: { importQueueMax: 2 } }, async (api) => {
      assert.equal((await postImport(api, "a1")).status, 202);
      assert.equal((await postImport(api, "a2")).status, 202);
      const refused = await postImport(api, "a3");
      assert.equal(refused.status, 503);
      assert.equal(refused.headers.get("retry-after"), "60");
      assert.equal((await body(refused)).code, "busy");
      // From the site's origin: the 503 is readable, Retry-After included (the "Try again" waits for it).
      const fromSite = await postImport(api, "a3", { Origin: "http://localhost:3000" });
      assert.equal(fromSite.status, 503);
      assert.equal(fromSite.headers.get("access-control-allow-origin"), "http://localhost:3000");
      assert.ok(exposed(fromSite).includes("retry-after"));
      // Another origin gets no CORS headers at all: nothing is exposed to it.
      const elsewhere = await postImport(api, "a3", { Origin: "https://evil.example" });
      assert.equal(elsewhere.headers.get("access-control-allow-origin"), null);
      assert.equal(elsewhere.headers.get("access-control-expose-headers"), null);
      // A running import doesn't count: only the queue's backlog does.
      await Job.updateOne({ key: "import:lichess:a1" }, { $set: { status: "running" } });
      assert.equal((await postImport(api, "a3")).status, 202);
    });
  });
});

describe("the flood guard", () => {
  it("past the per-minute limit: 429 limit_requests with Retry-After and CORS headers; /api/health is never limited", async () => {
    await withApp({ limits: { requestsPerMinute: 3 } }, async (api) => {
      const get = () => fetch(`${api}/players/lichess/nobody`, { headers: { Origin: "http://localhost:3000" } });
      for (let i = 0; i < 3; i++) assert.equal((await get()).status, 404);
      const refused = await get();
      assert.equal(refused.status, 429);
      assert.ok(Number(refused.headers.get("retry-after")) > 0);
      assert.equal(refused.headers.get("access-control-allow-origin"), "http://localhost:3000");
      // A cross-origin page can read Retry-After and the RateLimit headers only if they're exposed.
      assert.deepEqual(exposed(refused), ["ratelimit", "ratelimit-policy", "retry-after"]);
      assert.ok(refused.headers.get("ratelimit"));
      const b = await body(refused);
      assert.equal(b.code, "limit_requests");
      for (let i = 0; i < 5; i++) assert.equal((await fetch(`${api}/health`)).status, 200);
    });
  });
});

describe("which visitor is it, behind proxies (TRUST_PROXY_HOPS)", () => {
  // Render's chain: visitor → Cloudflare → Render's proxy → us. Each proxy appends the address
  // it got the request from to X-Forwarded-For, so with 3 hops the visitor is the 3rd address
  // from the right (counting the connection itself as the first). Anything further left was
  // written by the client and can be faked.
  const xff = (leftmost: string, visitor: string) => ({ "X-Forwarded-For": `${leftmost}, ${visitor}, 10.0.0.1, 10.0.0.2` });

  it("hops 3: the real visitor counts, a faked leftmost address is ignored, another visitor has its own counter", async () => {
    await withApp({ hops: 3, limits: { importsPerHour: 1 } }, async (api) => {
      assert.equal((await postImport(api, "p1", xff("1.1.1.1", "203.0.113.7"))).status, 202);
      // Same visitor, faking a different address in front: still the same counter.
      assert.equal((await postImport(api, "p2", xff("9.9.9.9", "203.0.113.7"))).status, 429);
      // Another visitor.
      assert.equal((await postImport(api, "p3", xff("1.1.1.1", "198.51.100.4"))).status, 202);
      // IPv6 visitors are counted per /64.
      assert.equal((await postImport(api, "p4", xff("1.1.1.1", "2001:db8:1:2::5"))).status, 202);
      assert.equal((await postImport(api, "p5", xff("1.1.1.1", "2001:db8:1:2::abcd"))).status, 429);
    });
  });

  it("hops 0: X-Forwarded-For is ignored, so faking it doesn't make a new visitor", async () => {
    await withApp({ hops: 0, limits: { importsPerHour: 1 } }, async (api) => {
      assert.equal((await postImport(api, "p1", xff("1.1.1.1", "203.0.113.7"))).status, 202);
      assert.equal((await postImport(api, "p2", xff("1.1.1.1", "198.51.100.4"))).status, 429);
    });
  });

  it("the visitor's IP never reaches the logs, not even on a refusal", async () => {
    const lines: string[] = [];
    const log = mock.method(console, "log", (line: string) => void lines.push(String(line)));
    const warn = mock.method(console, "error", (line: string) => void lines.push(String(line)));
    try {
      await withApp({ hops: 3, limits: { importsPerHour: 1 } }, async (api) => {
        await postImport(api, "p1", xff("1.1.1.1", "203.0.113.7"));
        await postImport(api, "p2", xff("1.1.1.1", "203.0.113.7"));
      });
    } finally {
      log.mock.restore();
      warn.mock.restore();
    }
    assert.ok(lines.some((l) => l.includes('"limit_refused"')), "the refusal was logged");
    assert.ok(lines.every((l) => !l.includes("203.0.113.7") && !l.includes("1.1.1.1")), lines.join("\n"));
  });
});

describe("storage eviction at the gate (lib/eviction.ts)", () => {
  const MB = 1024 * 1024;
  // A stored player with that many MB of games, last viewed that many days ago.
  async function oldPlayer(username: string, viewedDaysAgo: number, mb = 1) {
    const p = await Player.create({
      platform: "lichess",
      username,
      usernameLower: username.toLowerCase(),
      importState: "ready",
      lastImportedAt: new Date(Date.now() - 2 * DAY),
      lastViewedAt: new Date(Date.now() - viewedDaysAgo * DAY),
    });
    await Game.collection.insertOne({ playerId: p._id, platform: "lichess", sourceId: username, playedAt: new Date(), analysis: { status: "done" }, pgn: "x".repeat(mb * MB) });
    return p;
  }
  const names = async () => (await Player.find({}, { username: 1 }).sort({ username: 1 }).lean()).map((p) => p.username);

  it("gate full with an evictable player: the old player goes and the new import is accepted", async () => {
    // 120.5 MB at a 120 MB gate: under the gate by the 2 MB margin takes 3 MB.
    const storage = fakeStorage(120.5, 120);
    const evictor = createEvictor({ storage, evictToMb: 100, demoKeys: ["lichess:demoguy"] });
    await withApp({ storage, evictor }, async (api) => {
      await oldPlayer("ancient", 90, 3);
      await oldPlayer("recent", 1);
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 202);
      await evictor.idle();
      assert.deepEqual(await names(), ["recent"]);
      assert.equal(await Game.countDocuments({}), 1);
      assert.equal(await Job.countDocuments({ key: "import:lichess:newbie", status: "queued" }), 1);
      // The evicted player's own page is an ordinary "not found" now.
      assert.equal((await fetch(`${api}/players/lichess/ancient`)).status, 404);
    });
  });

  it("gate full with nobody evictable: 503 storage_full, nothing deleted, no import counted", async () => {
    const storage = fakeStorage(120, 120);
    const evictor = createEvictor({ storage, evictToMb: 100, demoKeys: ["lichess:demoguy"] });
    await withApp({ storage, evictor }, async (api) => {
      await oldPlayer("recent", 1);
      await oldPlayer("DemoGuy", 400);
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 503);
      assert.equal((await body(res)).code, "storage_full");
      assert.deepEqual(await names(), ["DemoGuy", "recent"]);
      assert.equal(await Usage.countDocuments({ count: { $gt: 0 } }), 0, "nothing stays counted");
    });
  });

  it("a stored player's refresh, a demo player and a gate that isn't full never trigger an eviction", async () => {
    let calls = 0;
    const spy: Evictor = {
      makeRoom: async () => {
        calls++;
        return "ok";
      },
      idle: async () => {},
    };
    const storage = fakeStorage(120, 120);
    await withApp({ storage, evictor: spy }, async (api) => {
      await storedPlayer("alice");
      assert.equal((await postImport(api, "alice")).status, 202);
      assert.equal((await postImport(api, "demoguy")).status, 202);
      assert.equal(calls, 0);
      storage.set(50);
      assert.equal((await postImport(api, "newbie")).status, 202);
      assert.equal(calls, 0);
      storage.set(120);
      assert.equal((await postImport(api, "another")).status, 202);
      assert.equal(calls, 1);
    });
  });

  // Every counter is back at 0 (a refunded counter's document stays, with count 0).
  const countersInUse = () => Usage.countDocuments({ count: { $gt: 0 } });

  it("an eviction already running: 503 busy in its own words, Retry-After, and the counters are refunded", async () => {
    const busy: Evictor = { makeRoom: async () => "busy", idle: async () => {} };
    await withApp({ storage: fakeStorage(120, 120), evictor: busy }, async (api) => {
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 503);
      const b = await body(res);
      assert.equal(b.code, "busy");
      assert.equal(b.error, "We're making room for new players. Try again in a minute.");
      assert.equal(res.headers.get("retry-after"), "60");
      assert.equal(await Usage.countDocuments({}), 3, "the visitor's hour + day and the new-player day were taken...");
      assert.equal(await countersInUse(), 0, "...and all handed back");
    });
  });

  // The eviction deletes other players' data, so it runs LAST: a request another check refuses
  // must never get that far.
  it("visitor over their import limit + gate full: 429 limit_imports and NOTHING evicted", async () => {
    const storage = fakeStorage(120.5, 120);
    let calls = 0;
    const real = createEvictor({ storage, evictToMb: 100, demoKeys: [] });
    const evictor: Evictor = { makeRoom: () => (calls++, real.makeRoom()), idle: real.idle };
    await withApp({ storage, evictor, limits: { importsPerHour: 1 } }, async (api) => {
      await oldPlayer("ancient", 90, 3);
      // The visitor's one import this hour: a stored player's refresh (no eviction for those).
      await storedPlayer("alice");
      assert.equal((await postImport(api, "alice")).status, 202);
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 429);
      assert.equal((await body(res)).code, "limit_imports");
      assert.equal(calls, 0, "the evictor wasn't even asked");
      assert.deepEqual(await names(), ["alice", "ancient"]);
      assert.equal(await Game.countDocuments({}), 1);
    });
  });

  it("new-player cap reached + gate full: 503 limit_new_players and nothing evicted", async () => {
    const storage = fakeStorage(50, 120);
    let calls = 0;
    const real = createEvictor({ storage, evictToMb: 100, demoKeys: [] });
    const evictor: Evictor = { makeRoom: () => (calls++, real.makeRoom()), idle: real.idle };
    await withApp({ storage, evictor, limits: { newPlayersPerDay: 1 } }, async (api) => {
      await oldPlayer("ancient", 90, 3);
      assert.equal((await postImport(api, "first")).status, 202, "the day's one new player, with room to spare");
      storage.set(120.5);
      const res = await postImport(api, "second");
      assert.equal(res.status, 503);
      assert.equal((await body(res)).code, "limit_new_players");
      assert.equal(calls, 0);
      assert.deepEqual(await names(), ["ancient"]);
      assert.equal(await Game.countDocuments({}), 1);
    });
  });

  it("import queue full + gate full: 503 busy (imports) and nothing evicted", async () => {
    const storage = fakeStorage(120.5, 120);
    let calls = 0;
    const evictor: Evictor = { makeRoom: async () => (calls++, "ok"), idle: async () => {} };
    await withApp({ storage, evictor, limits: { importQueueMax: 1 } }, async (api) => {
      await Job.create({ type: "import", key: "import:lichess:waiting", payload: {}, status: "queued", runAfter: new Date() });
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 503);
      assert.match((await body(res)).error, /A lot of imports are waiting/);
      assert.equal(calls, 0);
    });
  });

  it("eviction can't make room after the counters were taken: 503 storage_full and the counters are refunded", async () => {
    const storage = fakeStorage(120.5, 120);
    const evictor = createEvictor({ storage, evictToMb: 100, demoKeys: [] });
    await withApp({ storage, evictor }, async (api) => {
      await oldPlayer("recent", 1); // nobody evictable
      const res = await postImport(api, "newbie");
      assert.equal(res.status, 503);
      assert.equal((await body(res)).code, "storage_full");
      assert.equal(await Usage.countDocuments({}), 3, "hour + day + new players were taken...");
      assert.equal(await countersInUse(), 0, "...and all handed back");
      assert.deepEqual(await names(), ["recent"]);
      assert.equal(await Job.countDocuments({}), 0);
      // The refund is real: with a limit of one import an hour, the visitor can still import.
    });
    await clearDb();
    await withApp({ storage, evictor, limits: { importsPerHour: 1, newPlayersPerDay: 1 } }, async (api) => {
      await oldPlayer("recent", 1);
      assert.equal((await postImport(api, "newbie")).status, 503);
      storage.set(50);
      assert.equal((await postImport(api, "newbie")).status, 202, "neither the visitor's hour nor the day's new-player slot was used up");
    });
  });

  it("a player left marked by a crash is 404 on its pages, and importing the name again works", async () => {
    const storage = fakeStorage(118.5, 118.5);
    const crashing = createEvictor({
      storage,
      evictToMb: 100,
      demoKeys: [],
      afterStep: (step) => {
        if (step === "games") throw new Error("crash");
      },
    });
    await withApp({ storage, evictor: crashing }, async (api) => {
      await oldPlayer("ancient", 90);
      // The crash leaves the round unfinished, so this import is refused...
      assert.equal((await postImport(api, "newbie")).status, 503);
      assert.equal(await Player.countDocuments({ evictingAt: { $ne: null } }), 1);
      // ...and the half-evicted player is simply "not found" everywhere.
      for (const path of ["", "/games", "/summary"]) {
        assert.equal((await fetch(`${api}/players/lichess/ancient${path}`)).status, 404, path || "player");
      }
      // Its name is free: a new import of it is an ordinary new-player import.
      storage.set(50);
      assert.equal((await postImport(api, "ancient")).status, 202);
    });
  });
});
