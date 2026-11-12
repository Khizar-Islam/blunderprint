import type { Types } from "mongoose";
import { AgentRun, RUN_TTL_MS } from "../db/models/agentRun.js";
import { Answer, ANSWER_TTL_MS } from "../db/models/answer.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { demoKeyParts } from "../lib/demo.js";

// Which runs MongoDB may delete (the TTL index on agentRuns.expiresAt):
// - KEPT (no expiresAt): the run behind each demo player's current report, so the demo's
//   "How this report was made" never expires, and (Stage 6 chunk C) the run behind each of a demo
//   player's kept answers (answers without expiresAt: the pre-answers of npm run demo:answers),
//   so "How this answer was made" never expires either.
// - DATED: every other run without an expiresAt gets createdAt + 14 days, the same lifetime the
//   old { createdAt } TTL gave. That covers runs saved before expiresAt existed, and a run that
//   was kept for a player who is no longer in DEMO_PLAYERS (or whose report was replaced).
// New runs are created with an expiresAt (jobs/handlers/report.ts startReportRun), so this only
// has work to do at startup and right after a demo player's report is saved.
//
// Idempotent: a second call changes nothing. Two small queries + two updateMany; agentRuns is a
// few hundred documents at most (14-day TTL), so the unindexed { expiresAt: missing } scan is
// cheap.
export async function syncRunExpiry(demoKeys: readonly string[]): Promise<{ kept: number; dated: number }> {
  const players = demoKeys.length
    ? await Player.find({ $or: demoKeys.map(demoKeyParts) }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()
    : [];
  const ids = players.map((p) => p._id);
  const [reports, answers] = ids.length
    ? await Promise.all([
        Report.find({ playerId: { $in: ids } }, { runId: 1 }).lean<{ runId: Types.ObjectId }[]>(),
        Answer.find({ playerId: { $in: ids }, expiresAt: { $exists: false } }, { runId: 1 }).lean<{ runId: Types.ObjectId }[]>(),
      ])
    : [[], []];
  const keep = [...reports, ...answers].map((r) => r.runId);

  const kept = keep.length
    ? await AgentRun.updateMany({ _id: { $in: keep }, expiresAt: { $exists: true } }, { $unset: { expiresAt: 1 } }, { timestamps: false })
    : { modifiedCount: 0 };
  // An update pipeline ([...]) so the date can be computed from each run's own createdAt.
  // timestamps: false: dating a run isn't a change to it (updatedAt stays).
  const dated = await AgentRun.updateMany(
    { expiresAt: { $exists: false }, _id: { $nin: keep } },
    [{ $set: { expiresAt: { $add: ["$createdAt", RUN_TTL_MS] } } }],
    { updatePipeline: true, timestamps: false },
  );
  return { kept: kept.modifiedCount, dated: dated.modifiedCount };
}

// Kept answers (no expiresAt) of players who are no longer demo players get their 30-day expiry
// back, counted from when they were written: the same rule syncRunExpiry applies to runs. A demo
// player's kept answers are left alone. Idempotent; an unindexed scan of { expiresAt: missing },
// which only kept answers match (a handful).
export async function syncAnswerExpiry(demoKeys: readonly string[]): Promise<{ dated: number }> {
  const players = demoKeys.length
    ? await Player.find({ $or: demoKeys.map(demoKeyParts) }, { _id: 1 }).lean<{ _id: Types.ObjectId }[]>()
    : [];
  const res = await Answer.updateMany(
    { expiresAt: { $exists: false }, playerId: { $nin: players.map((p) => p._id) } },
    [{ $set: { expiresAt: { $add: ["$createdAt", ANSWER_TTL_MS] } } }],
    { updatePipeline: true, timestamps: false },
  );
  return { dated: res.modifiedCount };
}
