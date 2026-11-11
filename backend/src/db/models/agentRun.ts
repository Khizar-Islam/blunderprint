import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// One coach run (CLAUDE.md §7 "agentRuns"): the live trace the coach page streams, the usage,
// and how it ended. The report job (jobs/handlers/report.ts) writes it; GET /api/runs/:id/stream
// reads it.
const agentRunSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, required: true },
    // "ask": an "Ask the coach" question (Stage 6 chunk B), with its question, its answer and
    // the hashes of its secret tokens below.
    kind: { type: String, enum: ["report", "ask"], default: "report" },
    question: String,
    answerId: Schema.Types.ObjectId,
    // Ask runs only: SHA-256 hashes of the secret tokens handed out for this run, one per
    // requester (the asker, and anyone who asked the same question while it ran), at most
    // MAX_RUN_TOKENS. Streaming an ask run needs one of the tokens; the tokens themselves are
    // never stored, so reading the database doesn't give them away.
    tokenHashes: { type: [String], default: undefined },
    jobId: Schema.Types.ObjectId,
    status: { type: String, enum: RUN_STATUSES, default: "queued" },
    // +1 on every change a viewer can see; the SSE event id, like jobs.rev.
    rev: { type: Number, default: 0 },
    // Which try this is (a server restart mid-run starts the run again from scratch).
    attempt: { type: Number, default: 0 },
    model: { type: String, required: true },
    promptVersion: { type: Number, required: true },
    analysedGamesHash: String,
    // TraceStep[] (agent/loop.ts), capped at MAX_RUN_STEPS.
    steps: { type: [Schema.Types.Mixed], default: [] },
    usage: { calls: Number, inputTokens: Number, outputTokens: Number, totalTokens: Number },
    reportId: Schema.Types.ObjectId,
    // Always a friendly pair from agent/friendly.ts, never an internal error message.
    error: { code: String, message: String },
    startedAt: Date,
    finishedAt: Date,
    // When MongoDB deletes the run (TTL below). Set to created + RUN_TTL_MS for every run; left
    // out (never deleted) only for the run behind a demo player's current report
    // (agent/runExpiry.ts), so its "How this report was made" stays.
    expiresAt: Date,
  },
  { timestamps: true, minimize: false },
);

// TTL on expiresAt: MongoDB's background task deletes a run once expiresAt has passed
// (expireAfterSeconds 0 = "at the date in the field"), so the traces never pile up in the free
// 512 MB. A run WITHOUT expiresAt is never deleted: that's how demo traces are kept. The report
// itself lives in `reports` and isn't affected.
// Replaced { createdAt: 1 } (expireAfterSeconds 14 days) in Stage 7: a TTL on createdAt can't
// spare single runs. The old index must be dropped by hand on Atlas (Mongoose never drops one).
agentRunSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RUN_TTL_MS = 14 * 24 * 60 * 60_000;
export const runExpiresAt = (from = new Date()) => new Date(from.getTime() + RUN_TTL_MS);

export const MAX_RUN_STEPS = 60;
export const MAX_RUN_TOKENS = 20;

export type AgentRunFields = InferSchemaType<typeof agentRunSchema>;
export type AgentRunDoc = HydratedDocument<AgentRunFields>;
export const AgentRun = model("AgentRun", agentRunSchema);
