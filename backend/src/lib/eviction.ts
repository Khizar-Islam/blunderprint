import type { Types } from "mongoose";
import { AgentRun } from "../db/models/agentRun.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { ACTIVE_JOB_STATUSES, Job } from "../db/models/job.js";
import { Player, type Platform } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { extractJobKey } from "../jobs/handlers/extract.js";
import { importJobKey } from "../jobs/handlers/import.js";
import { demoChecker, demoKeyParts } from "./demo.js";
import { errorMessage, logger, withoutLogContext } from "./logger.js";
import type { StorageGate } from "./storage.js";

// Storage eviction (CLAUDE.md §7 "Storage budget"): when the database is full, make room for a
// new player by deleting the players nobody has looked at for the longest time.
//
// When it runs: only when POST import finds the storage gate full for a NEW player, and only
// after every other check of that route has passed (queue cap, the visitor's limits, the
// new-player cap), so a request that would be refused anyway never deletes anything
// (routes/players.ts). There is no job and no timer: below the gate this code never runs.
//
// Two parts, one round:
// - In the request: evict until the ESTIMATE is under the gate by a small margin, then the
//   import goes through. If that can't be reached, the visitor gets today's "storage full".
// - In the background (not awaited by the request): keep going down to STORAGE_EVICT_TO_MB, so
//   the next ~20 new players need no eviction at all.
// One round at a time per process (`active`): a second call while one runs gets "busy".
//
// The estimate: the gate's reading (dbStats, cached 5 minutes) minus the BSON size of each
// evicted player's games. Games are ~95% of a player; reports, answers and runs are not
// counted, so the estimate errs on the side of evicting a little more, never less. After a
// round the gate's cache is cleared, so the next reading is a real one.
//
// Who is never evicted:
// - a demo player (DEMO_PLAYERS): left out of the query, and checked again in code;
// - a player viewed in the last 7 days (lastViewedAt, hour precision);
// - a player with a queued or running job (import, extract, report, ask);
// - a player with a queued or running coach run;
// - a player with games a browser's engine has claimed and whose claim hasn't expired.
//
// One player, in this order, so a crash at any point leaves nothing half-shown:
// 1. MARK: one atomic update sets evictingAt and replaces usernameLower with a tombstone
//    ("~evicting:<id>"; "~" can't be in a username). Every route finds a player by
//    { platform, usernameLower }, so from this moment the player is 404 everywhere, and an
//    import of the same username simply creates a new player (no clash on the unique index).
//    The update's filter repeats "not viewed in 7 days", so a view that lands first wins.
// 2. RE-CHECK the jobs, runs and claims (one may have started between the check and the mark).
//    If so, the mark is undone.
// 3. Delete answers, reports, agent runs, then games, then the player document LAST.
// A crash in between leaves a marked player; every round finishes those first (step 2 on).
// Jobs are not deleted: active ones block eviction, finished ones expire by TTL after 7 days.
//
// Not closed (no transactions on this path): a request that read the player just before the
// mark and enqueues a job just after the re-check. That job finds no player and fails with the
// usual "player not found"; nothing is left half-written.

const DAY_MS = 24 * 60 * 60_000;
const MB = 1024 * 1024;

// A player viewed this recently is never evicted. 7 days, not 1: a recruiter who imports their
// own account often comes back to it days later (after an interview, or to show someone), and
// finding it gone would look like a bug.
export const EVICT_PROTECT_VIEWED_MS = 7 * DAY_MS;
// The request evicts until the estimate is this far UNDER the gate, so the import it lets
// through (~1 MB) doesn't land straight back on the gate.
export const EVICT_GATE_MARGIN_MB = 2;
// At most this many players per round (request + background together): a bound on how much one
// request can ever delete, whatever the numbers say.
export const EVICT_MAX_PER_ROUND = 25;

export type RoomResult = "ok" | "full" | "busy";
export type SkipReason = "demo" | "viewed" | "active_job" | "coach_run" | "claimed_games";
// The points between two deletes, for tests that simulate a crash there.
export type EvictStep = "marked" | "answers" | "reports" | "runs" | "games";

export interface EvictorOptions {
  storage: StorageGate;
  // Background target (STORAGE_EVICT_TO_MB).
  evictToMb: number;
  // "platform:usernamelower" keys (config/env.ts parseDemoPlayers).
  demoKeys: readonly string[];
  now?: () => Date;
  maxPerRound?: number;
  // Tests only: called after each step of one player's eviction; throwing simulates a crash.
  afterStep?: (step: EvictStep, playerId: Types.ObjectId) => void | Promise<void>;
}

export interface Evictor {
  // Called when the gate is full for a new player. "ok" = there is room now (by the estimate);
  // "full" = not enough could be evicted; "busy" = another round is running.
  makeRoom(): Promise<RoomResult>;
  // Resolves when no round is running (tests, and anything that wants to wait for the background part).
  idle(): Promise<void>;
}

interface Candidate {
  _id: Types.ObjectId;
  platform: Platform;
  username: string;
  lastViewedAt?: Date | null;
}

interface Round {
  estimateMb: number;
  evicted: number;
  recovered: boolean;
  candidates: Candidate[] | null;
}

export const tombstone = (id: Types.ObjectId | string) => `~evicting:${String(id)}`;
const round1 = (n: number) => Math.round(n * 10) / 10;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function createEvictor({ storage, evictToMb, demoKeys, now = () => new Date(), maxPerRound = EVICT_MAX_PER_ROUND, afterStep }: EvictorOptions): Evictor {
  const isDemo = demoChecker(demoKeys);
  const demoPairs = demoKeys.map(demoKeyParts);
  let active = false;
  let background: Promise<void> | null = null;

  // "Not viewed in the last 7 days". A player with no lastViewedAt (none should exist: the
  // import sets it) counts from when it was created.
  const notViewedSince = (cutoff: Date) => ({
    $or: [{ lastViewedAt: { $lt: cutoff } }, { lastViewedAt: null, createdAt: { $lt: cutoff } }],
  });

  // Why this player can't be evicted right now, or null.
  async function busyReason(p: Candidate): Promise<SkipReason | null> {
    const id = String(p._id);
    const [job, run, claimed] = await Promise.all([
      // Import jobs are keyed by name, extract by id, report and ask by model + id.
      Job.exists({
        status: { $in: [...ACTIVE_JOB_STATUSES] },
        $or: [
          { key: importJobKey(p.platform, p.username) },
          { key: extractJobKey(p._id) },
          { key: { $regex: `^(report|ask):[^:]+:${escapeRegex(id)}(:|$)` } },
        ],
      }),
      AgentRun.exists({ playerId: p._id, status: { $in: ["queued", "running"] } }),
      Game.exists({ playerId: p._id, "analysis.status": "claimed", "analysis.claimExpiresAt": { $gt: now() } }),
    ]);
    return job ? "active_job" : run ? "coach_run" : claimed ? "claimed_games" : null;
  }

  // Steps 2 and 3 for a MARKED player. Returns the bytes its games took, or why it was put back.
  async function finish(p: Candidate): Promise<{ bytes: number } | { skipped: SkipReason }> {
    const started = Date.now();
    const busy = await busyReason(p);
    if (busy) {
      // Undo the mark. If the name has been taken meanwhile (a new import created a fresh
      // player), the unique index refuses: the old one stays marked and a later round finishes it.
      await Player.updateOne(
        { _id: p._id, evictingAt: { $ne: null } },
        { $set: { usernameLower: p.username.toLowerCase() }, $unset: { evictingAt: 1 } },
        { timestamps: false },
      ).catch((err: unknown) => {
        if ((err as { code?: number }).code !== 11000) throw err;
      });
      return { skipped: busy };
    }
    const [sized] = await Game.aggregate<{ bytes: number }>([
      { $match: { playerId: p._id } },
      { $group: { _id: null, bytes: { $sum: { $bsonSize: "$$ROOT" } } } },
    ]);
    const answers = await Answer.deleteMany({ playerId: p._id });
    await afterStep?.("answers", p._id);
    const reports = await Report.deleteMany({ playerId: p._id });
    await afterStep?.("reports", p._id);
    const runs = await AgentRun.deleteMany({ playerId: p._id });
    await afterStep?.("runs", p._id);
    const games = await Game.deleteMany({ playerId: p._id });
    await afterStep?.("games", p._id);
    await Player.deleteOne({ _id: p._id, evictingAt: { $ne: null } });
    const bytes = sized?.bytes ?? 0;
    logger.info("player_evicted", {
      platform: p.platform,
      username: p.username,
      lastViewedAt: p.lastViewedAt ?? null,
      games: games.deletedCount,
      reports: reports.deletedCount,
      answers: answers.deletedCount,
      runs: runs.deletedCount,
      freedMb: round1(bytes / MB),
      ms: Date.now() - started,
    });
    return { bytes };
  }

  async function evictOne(p: Candidate): Promise<{ bytes: number } | { skipped: SkipReason }> {
    if (isDemo(p.platform, p.username)) return { skipped: "demo" };
    const busy = await busyReason(p);
    if (busy) return { skipped: busy };
    const cutoff = new Date(now().getTime() - EVICT_PROTECT_VIEWED_MS);
    const marked = await Player.updateOne(
      { _id: p._id, evictingAt: null, ...notViewedSince(cutoff) },
      { $set: { evictingAt: now(), usernameLower: tombstone(p._id) } },
      { timestamps: false },
    );
    if (marked.modifiedCount === 0) return { skipped: "viewed" };
    await afterStep?.("marked", p._id);
    return finish(p);
  }

  // Evicts until the estimate is under targetMb, the round's cap is reached, or nobody is left.
  async function evictDown(round: Round, targetMb: number, phase: "request" | "background"): Promise<void> {
    const started = Date.now();
    const before = round.evicted;
    const startMb = round.estimateMb;
    const skipped: Partial<Record<SkipReason, number>> = {};
    const count = (r: { bytes: number } | { skipped: SkipReason }) => {
      if ("skipped" in r) skipped[r.skipped] = (skipped[r.skipped] ?? 0) + 1;
      else {
        round.evicted++;
        round.estimateMb -= r.bytes / MB;
      }
    };

    // Players a crashed round left marked come first, whatever the numbers say: they are
    // already invisible, so finishing them is pure clean-up.
    if (!round.recovered) {
      round.recovered = true;
      const marked = await Player.find({ evictingAt: { $ne: null } }, { platform: 1, username: 1, lastViewedAt: 1 }).lean<Candidate[]>();
      for (const p of marked) count(await finish(p));
    }
    if (round.candidates === null) {
      const cutoff = new Date(now().getTime() - EVICT_PROTECT_VIEWED_MS);
      // Oldest view first, on the { lastViewedAt: 1 } index. More than the cap, because some
      // will be skipped (busy).
      round.candidates = await Player.find(
        { evictingAt: null, ...notViewedSince(cutoff), ...(demoPairs.length ? { $nor: demoPairs } : {}) },
        { platform: 1, username: 1, lastViewedAt: 1 },
      )
        .sort({ lastViewedAt: 1 })
        .limit(maxPerRound * 4)
        .lean<Candidate[]>();
    }
    logger.info("eviction_started", { phase, usedMb: round1(round.estimateMb), targetMb, candidates: round.candidates.length });
    while (round.estimateMb >= targetMb && round.evicted < maxPerRound && round.candidates.length > 0) {
      count(await evictOne(round.candidates.shift()!));
    }
    if (Object.keys(skipped).length > 0) logger.info("eviction_skipped", { phase, ...skipped });
    logger.info("eviction_done", {
      phase,
      evicted: round.evicted - before,
      freedMb: round1(startMb - round.estimateMb),
      estimateMb: round1(round.estimateMb),
      targetMb,
      reached: round.estimateMb < targetMb,
      ms: Date.now() - started,
    });
  }

  async function makeRoom(): Promise<RoomResult> {
    if (active) return "busy";
    active = true;
    let handedOver = false;
    const round: Round = { estimateMb: 0, evicted: 0, recovered: false, candidates: null };
    try {
      const used = await storage.usedMb();
      // No reading: like the gate itself, don't block the import on it.
      if (used === null) return "ok";
      round.estimateMb = used;
      const gateTarget = storage.limitMb - EVICT_GATE_MARGIN_MB;
      await evictDown(round, gateTarget, "request");
      const room = round.estimateMb < gateTarget;
      const target = Math.min(evictToMb, gateTarget);
      if (room && round.estimateMb >= target && round.evicted < maxPerRound && (round.candidates?.length ?? 0) > 0) {
        handedOver = true;
        // Not awaited: the request answers now. withoutLogContext, so these lines never carry
        // whatever context the triggering call had.
        background = withoutLogContext(() => evictDown(round, target, "background"))
          .catch((err: unknown) => logger.error("eviction_failed", { phase: "background", error: errorMessage(err) }))
          .finally(() => {
            storage.reset();
            active = false;
            background = null;
          });
      }
      return room ? "ok" : "full";
    } catch (err) {
      // A database error mid-eviction: whatever was marked is finished by the next round.
      logger.error("eviction_failed", { phase: "request", error: errorMessage(err) });
      return "full";
    } finally {
      if (!handedOver) {
        if (round.evicted > 0) storage.reset();
        active = false;
      }
    }
  }

  return {
    makeRoom,
    async idle() {
      while (background) await background;
    },
  };
}
