import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

export const RUN_STATUSES = ["queued", "running", "done", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

// One coach run (CLAUDE.md §7 "agentRuns"): the live trace the coach page streams, the usage,
// and how it ended. The report job (jobs/handlers/report.ts) writes it; GET /api/runs/:id/stream
// reads it.
const agentRunSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, enum: ["report"], default: "report" },
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
  },
  { timestamps: true, minimize: false },
);

// TTL: runs disappear 14 days after they were created, so the traces never pile up in the free
// 512 MB. The report itself lives in `reports` and isn't affected.
agentRunSchema.index({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });

export const MAX_RUN_STEPS = 60;

export type AgentRunFields = InferSchemaType<typeof agentRunSchema>;
export type AgentRunDoc = HydratedDocument<AgentRunFields>;
export const AgentRun = model("AgentRun", agentRunSchema);
