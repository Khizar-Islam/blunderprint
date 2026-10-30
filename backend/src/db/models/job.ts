import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const JOB_TYPES = ["import", "extract", "aggregate", "report"] as const;
export const JOB_STATUSES = ["queued", "running", "done", "failed"] as const;
export const ACTIVE_JOB_STATUSES = ["queued", "running"] as const;

export type JobType = (typeof JOB_TYPES)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

const jobSchema = new Schema(
  {
    type: { type: String, enum: JOB_TYPES, required: true },
    // Idempotency key, e.g. "import:chesscom:hikaru". Only one active job per key (index below).
    key: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: JOB_STATUSES, default: "queued" },
    // Counted when a worker claims the job, so a job that keeps crashing the process still runs out.
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    // Not before this time: used for retry backoff.
    runAfter: { type: Date, required: true },
    // The lease: the worker owns the job until leaseUntil and must keep renewing it.
    // If the process dies, the lease runs out and the reaper puts the job back in the queue.
    leaseUntil: Date,
    workerId: String,
    progress: { done: { type: Number, default: 0 }, total: Number, message: String },
    // Handler-specific resume point, e.g. which Chess.com months are already imported.
    checkpoint: Schema.Types.Mixed,
    // Safe-to-show error. code is machine-readable (e.g. "user_not_found").
    error: { code: String, message: String },
  },
  { timestamps: true, minimize: false },
);

// Claiming: "oldest queued job whose runAfter has passed". The reaper's
// { status: "running", leaseUntil < now } query also uses the status prefix of this index.
jobSchema.index({ status: 1, runAfter: 1 });

// Idempotency: a unique index that only covers active jobs (a partial index ignores documents
// that don't match the filter). Enqueueing "import:chesscom:hikaru" twice while one is queued
// or running hits a duplicate-key error, and we return the existing job. Finished jobs are
// outside the index, so the same key can run again later. $in here needs MongoDB 6.0+.
jobSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { status: { $in: [...ACTIVE_JOB_STATUSES] } } },
);

export type JobFields = InferSchemaType<typeof jobSchema>;
export type JobDoc = HydratedDocument<JobFields>;
export const Job = model("Job", jobSchema);
