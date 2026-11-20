import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { AgentRun } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Job } from "../db/models/job.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { EVICT_GATE_MARGIN_MB, EVICT_PROTECT_VIEWED_MS, createEvictor, tombstone, type EvictStep, type EvictorOptions } from "./eviction.js";
import type { StorageGate } from "./storage.js";

// The storage eviction against a real (in-memory) MongoDB. Documents are inserted through the
// driver (Model.collection), so a test controls every field, including createdAt, and a game
// can be padded to a known size.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

const DAY = 24 * 60 * 60_000;
const MB = 1024 * 1024;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

// A storage gate whose reading the test sets; counts how often its cache was cleared.
function gate(usedMb: number | null, limitMb = 120) {
  const g = {
    limitMb,
    resets: 0,
    usedMb: async () => usedMb,
    full: async () => usedMb !== null && usedMb >= limitMb,
    reset() {
      g.resets++;
    },
  };
  return g satisfies StorageGate;
}

const evictor = (storage: StorageGate, opts: Partial<EvictorOptions> = {}) =>
  createEvictor({ storage, evictToMb: storage.limitMb - EVICT_GATE_MARGIN_MB, demoKeys: [], ...opts });

let seq = 0;
// A stored player with `games` games of `gameBytes` each (1 MB in all by default), one report,
// one answer and one finished coach run.
async function player(username: string, viewedDaysAgo: number | null, { games = 4, gameBytes = MB / 4 }: { games?: number; gameBytes?: number } = {}) {
  const _id = new Types.ObjectId();
  await Player.collection.insertOne({
    _id,
    platform: "lichess",
    username,
    usernameLower: username.toLowerCase(),
    importState: "ready",
    ...(viewedDaysAgo === null ? {} : { lastViewedAt: daysAgo(viewedDaysAgo) }),
    createdAt: daysAgo(30),
    updatedAt: daysAgo(30),
  });
  if (games > 0) {
    await Game.collection.insertMany(
      Array.from({ length: games }, () => ({
        playerId: _id,
        platform: "lichess",
        sourceId: `g${seq++}`,
        playedAt: daysAgo(40),
        analysis: { status: "done" },
        pgn: "x".repeat(Math.max(1, Math.round(gameBytes) - 200)),
      })),
    );
  }
  await Report.collection.insertOne({ playerId: _id, analysedGamesHash: "h", promptVersion: 1, model: "m" });
  await Answer.collection.insertOne({ playerId: _id, questionKey: "q", analysedGamesHash: "h", promptVersion: 1, model: "m" });
  await AgentRun.collection.insertOne({ playerId: _id, kind: "report", status: "done", model: "m" });
  return _id;
}

const stored = async () => (await Player.find({}, { username: 1 }).sort({ username: 1 }).lean()).map((p) => p.username);
const leftOf = async (playerId: Types.ObjectId) => ({
  player: await Player.countDocuments({ _id: playerId }),
  games: await Game.countDocuments({ playerId }),
  reports: await Report.countDocuments({ playerId }),
  answers: await Answer.countDocuments({ playerId }),
  runs: await AgentRun.countDocuments({ playerId }),
});
const NOTHING = { player: 0, games: 0, reports: 0, answers: 0, runs: 0 };
const job = (fields: Record<string, unknown>) => Job.collection.insertOne({ attempts: 0, maxAttempts: 3, runAfter: new Date(), ...fields });

describe("who goes, and who never does", () => {
  it("the least recently viewed player goes first, and eviction stops once under the gate", async () => {
    await player("old", 40);
    await player("older", 60);
    await player("oldest", 90);
    // 119.5 MB against a 120 MB gate: under the gate by the 2 MB margin means < 118, so two
    // players (1 MB each) must go: 119.5 → 118.5 → 117.5.
    const g = gate(119.5);
    assert.equal(await evictor(g).makeRoom(), "ok");
    assert.deepEqual(await stored(), ["old"]);
    assert.equal(g.resets, 1, "the gate's cached reading is cleared after an eviction");
  });

  it("everything of an evicted player is gone; another player's data is untouched", async () => {
    const gone = await player("gone", 90);
    const kept = await player("kept", 1);
    assert.equal(await evictor(gate(118.5)).makeRoom(), "ok");
    assert.deepEqual(await leftOf(gone), NOTHING);
    assert.deepEqual(await leftOf(kept), { player: 1, games: 4, reports: 1, answers: 1, runs: 1 });
  });

  it("a demo player is never evicted, even as the oldest and only candidate", async () => {
    const demo = await player("DemoGuy", 400);
    assert.equal(await evictor(gate(125), { demoKeys: ["lichess:demoguy"] }).makeRoom(), "full");
    assert.equal((await leftOf(demo)).games, 4);
    // Also when the query lets it through (a demo list that changed under a running round is
    // not a real case; this pins the second, in-code check).
    await player("other", 90);
    assert.equal(await evictor(gate(118.5), { demoKeys: ["lichess:demoguy"] }).makeRoom(), "ok");
    assert.deepEqual(await stored(), ["DemoGuy"]);
  });

  it("a player viewed within the last 7 days isn't evicted; one viewed 8 days ago is", async () => {
    assert.equal(EVICT_PROTECT_VIEWED_MS, 7 * DAY);
    await player("now", 0);
    await player("sixdays", 6);
    await player("eightdays", 8);
    assert.equal(await evictor(gate(125)).makeRoom(), "full", "one evictable player frees 1 MB of the 7 needed");
    assert.deepEqual(await stored(), ["now", "sixdays"]);
  });

  it("a player with no lastViewedAt counts from its creation (30 days ago here)", async () => {
    await player("noview", null);
    assert.equal(await evictor(gate(118.5)).makeRoom(), "ok");
    assert.deepEqual(await stored(), []);
  });

  for (const status of ["queued", "running"]) {
    it(`a player with a ${status} import, extract, report or ask job is not evicted`, async () => {
      const ids = {
        imp: await player("Importing", 90),
        ext: await player("extracting", 90),
        rep: await player("reporting", 90),
        ask: await player("asking", 90),
      };
      await job({ type: "import", key: "import:lichess:importing", status });
      await job({ type: "extract", key: `extract:${ids.ext}`, status });
      await job({ type: "report", key: `report:gemini-3.5-flash-lite:${ids.rep}`, status });
      await job({ type: "ask", key: `ask:gemini-3.5-flash-lite:${ids.ask}:abc123`, status });
      await player("free", 50);
      assert.equal(await evictor(gate(125)).makeRoom(), "full");
      assert.deepEqual(await stored(), ["Importing", "asking", "extracting", "reporting"]);
    });
  }

  it("a FINISHED job doesn't protect a player", async () => {
    const id = await player("done", 90);
    await job({ type: "extract", key: `extract:${id}`, status: "done" });
    await job({ type: "import", key: "import:lichess:done", status: "failed" });
    assert.equal(await evictor(gate(118.5)).makeRoom(), "ok");
    assert.deepEqual(await stored(), []);
  });

  it("a player with a queued or running coach run is not evicted", async () => {
    const queued = await player("queuedrun", 90);
    const running = await player("runningrun", 90);
    await AgentRun.collection.insertOne({ playerId: queued, kind: "ask", status: "queued", model: "m" });
    await AgentRun.collection.insertOne({ playerId: running, kind: "report", status: "running", model: "m" });
    assert.equal(await evictor(gate(125)).makeRoom(), "full");
    assert.deepEqual(await stored(), ["queuedrun", "runningrun"]);
  });

  it("a player whose games a browser has claimed is not evicted; an expired claim doesn't count", async () => {
    const claimed = await player("claimed", 90);
    const expired = await player("expired", 80);
    await Game.collection.updateOne({ playerId: claimed }, { $set: { "analysis.status": "claimed", "analysis.claimExpiresAt": new Date(Date.now() + 60_000) } });
    await Game.collection.updateOne({ playerId: expired }, { $set: { "analysis.status": "claimed", "analysis.claimExpiresAt": new Date(Date.now() - 60_000) } });
    assert.equal(await evictor(gate(125)).makeRoom(), "full");
    assert.deepEqual(await stored(), ["claimed"]);
  });

  it("nobody evictable: nothing is deleted and the answer is full", async () => {
    await player("fresh", 1);
    const g = gate(121);
    assert.equal(await evictor(g).makeRoom(), "full");
    assert.deepEqual(await stored(), ["fresh"]);
    assert.equal(g.resets, 0);
  });

  it("no storage reading: like the gate, it doesn't block and deletes nothing", async () => {
    await player("old", 90);
    assert.equal(await evictor(gate(null)).makeRoom(), "ok");
    assert.deepEqual(await stored(), ["old"]);
  });

  it("at most maxPerRound players in one round", async () => {
    for (let i = 0; i < 5; i++) await player(`p${i}`, 90 - i, { games: 1, gameBytes: 1000 });
    assert.equal(await evictor(gate(125), { maxPerRound: 3 }).makeRoom(), "full");
    assert.deepEqual(await stored(), ["p3", "p4"]);
  });
});

describe("the mark, and a crash in the middle", () => {
  it("a marked player can't be found by name, and its name is free for a new import", async () => {
    const id = await player("Ghost", 90);
    const crash = evictor(gate(118.5), {
      afterStep: (step) => {
        if (step === "marked") throw new Error("crash");
      },
    });
    assert.equal(await crash.makeRoom(), "full", "a failed round answers full");
    assert.equal(await Player.findOne({ platform: "lichess", usernameLower: "ghost" }), null);
    const marked = await Player.findById(id).lean();
    assert.equal(marked?.usernameLower, tombstone(id));
    assert.ok(marked?.evictingAt instanceof Date);
    // What the import job does for a new player: an upsert by { platform, usernameLower }.
    await Player.updateOne({ platform: "lichess", usernameLower: "ghost" }, { $set: { username: "Ghost" }, $setOnInsert: { lastViewedAt: new Date() } }, { upsert: true });
    assert.equal(await Player.countDocuments({}), 2);
    // The next round finishes the old one and leaves the new one alone.
    assert.equal(await evictor(gate(118.5)).makeRoom(), "ok");
    assert.deepEqual(await leftOf(id), NOTHING);
    assert.deepEqual(await stored(), ["Ghost"]);
  });

  for (const at of ["marked", "answers", "reports", "runs", "games"] satisfies EvictStep[]) {
    it(`a crash after "${at}": the player stays invisible, and the next round finishes it first`, async () => {
      const id = await player("victim", 90);
      await player("bystander", 50);
      const crash = evictor(gate(118.5), {
        afterStep: (step) => {
          if (step === at) throw new Error("crash");
        },
      });
      assert.equal(await crash.makeRoom(), "full");
      assert.equal((await leftOf(id)).player, 1, "the player document is deleted last");
      assert.equal(await Player.findOne({ platform: "lichess", usernameLower: "victim" }), null);
      // The next round is under no pressure at all (10 MB), and still cleans up the marked player.
      assert.equal(await evictor(gate(10)).makeRoom(), "ok");
      assert.deepEqual(await leftOf(id), NOTHING);
      assert.deepEqual(await stored(), ["bystander"]);
    });
  }

  it("a marked player that turns out to have an active job is put back, findable again", async () => {
    const id = await player("Busy", 90);
    const crash = evictor(gate(118.5), {
      afterStep: (step) => {
        if (step === "marked") throw new Error("crash");
      },
    });
    await crash.makeRoom();
    await job({ type: "extract", key: `extract:${id}`, status: "running" });
    assert.equal(await evictor(gate(118.5)).makeRoom(), "full");
    const back = await Player.findOne({ platform: "lichess", usernameLower: "busy" }).lean();
    assert.equal(String(back?._id), String(id));
    assert.equal(back?.evictingAt, undefined);
    assert.equal((await leftOf(id)).games, 4);
  });

  it("a view that lands between choosing a player and marking it saves the player", async () => {
    await player("first", 90);
    const second = await player("second", 80);
    // While "first" is being evicted, someone opens "second"'s dashboard.
    const e = evictor(gate(125), {
      afterStep: async (step) => {
        if (step === "marked") await Player.updateOne({ _id: second }, { $set: { lastViewedAt: new Date() } }, { timestamps: false });
      },
    });
    assert.equal(await e.makeRoom(), "full");
    assert.deepEqual(await stored(), ["second"]);
    assert.equal((await leftOf(second)).games, 4);
  });
});

describe("the background continuation", () => {
  // 12 players of 1 MB, oldest p00. Gate 120, reading 121: the request must get under 118
  // (4 players: 121 → 117), the background under 114 (4 more: → 113).
  const seed = async () => {
    for (let i = 0; i < 12; i++) await player(`p${String(i).padStart(2, "0")}`, 100 - i);
  };

  it("the request evicts only down to the gate; the background stops at its target; never two rounds at once", async () => {
    await seed();
    const g = gate(121);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let marks = 0;
    const e = evictor(g, {
      evictToMb: 114,
      // Hold the 5th player (the background's first) right after its mark.
      afterStep: async (step) => {
        if (step === "marked" && ++marks === 5) await held;
      },
    });
    assert.equal(await e.makeRoom(), "ok");
    // The request has answered with exactly 4 gone; the background is still on its way.
    assert.equal(await Player.countDocuments({}), 8);
    // Wait for the background to reach the 5th player: marked, but not yet deleted.
    while (marks < 5) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(await Player.countDocuments({ evictingAt: null }), 7);
    assert.equal(await Game.countDocuments({}), 8 * 4);
    assert.equal(g.resets, 0, "the gate's cache is cleared when the whole round ends");
    // A second new player arriving now doesn't start a second round.
    assert.equal(await e.makeRoom(), "busy");
    assert.equal(marks, 5);
    release();
    await e.idle();
    assert.deepEqual(await stored(), ["p08", "p09", "p10", "p11"]);
    assert.equal(g.resets, 1);
    // The flag is free again: with the reading under the gate there is nothing more to do.
    assert.equal(await evictor(gate(113)).makeRoom(), "ok");
    assert.equal(await Player.countDocuments({}), 4);
  });

  it("no background part when the request already reached the target", async () => {
    await seed();
    const e = evictor(gate(121)); // the target is the gate's own 118
    assert.equal(await e.makeRoom(), "ok");
    await e.idle();
    assert.equal(await Player.countDocuments({}), 8);
  });

  it("a background failure is logged, not thrown, and frees the flag", async () => {
    await seed();
    let marks = 0;
    const g = gate(121);
    const e = evictor(g, {
      evictToMb: 114,
      afterStep: (step) => {
        if (step === "marked" && ++marks === 5) throw new Error("crash in the background");
      },
    });
    assert.equal(await e.makeRoom(), "ok");
    await e.idle();
    assert.equal(g.resets, 1);
    // The marked player is finished by the next round.
    assert.equal(await Player.countDocuments({ evictingAt: { $ne: null } }), 1);
    assert.equal(await e.makeRoom(), "ok");
    await e.idle();
    assert.equal(await Player.countDocuments({ evictingAt: { $ne: null } }), 0);
  });
});

describe("how long one player takes", () => {
  it("a full player (200 games of ~5.4 KB, about 1 MB) is evicted", async (t) => {
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const id = await player(`full${i}`, 90, { games: 200, gameBytes: 5400 });
      const started = performance.now();
      assert.equal(await evictor(gate(118.5)).makeRoom(), "ok");
      times.push(Math.round(performance.now() - started));
      assert.deepEqual(await leftOf(id), NOTHING);
    }
    t.diagnostic(`one 200-game player, in-memory MongoDB, ms per eviction (first is cold): ${times.join(", ")}`);
  });
});
