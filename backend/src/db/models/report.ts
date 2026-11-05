import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// A finished coach report (CLAUDE.md §7 "reports"). Only the newest report per player and model
// is kept: the handler deletes the older ones after the new one is saved.
//
// The cache key is (playerId, analysedGamesHash, promptVersion, model): the same analysed games,
// asked of the same prompt and model, would get the same answer, so it's served without any AI
// call. Any change (a newly analysed game, a new prompt version, another model) misses the
// cache, and GET shows the old report marked stale.
const reportSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, required: true },
    // agent/basis.ts: SHA-1 of the analysed games' ids (and FEATURES_VERSION) the run started with.
    analysedGamesHash: { type: String, required: true },
    promptVersion: { type: Number, required: true },
    model: { type: String, required: true },
    runId: { type: Schema.Types.ObjectId, required: true },
    // "none": the run worked, but no pattern survived the verifier.
    outcome: { type: String, enum: ["patterns", "none"], required: true },
    // The verified patterns, exactly as the coach page shows them (agent/reportStore.ts
    // StoredPattern): stat, evidence positions with FEN, moves in SAN and UCI, and facts.
    patterns: { type: [Schema.Types.Mixed], default: [] },
    analysedGames: { type: Number, required: true },
    usage: { calls: Number, inputTokens: Number, outputTokens: Number, totalTokens: Number },
    durationMs: Number,
    // For the logs and the README; never sent to visitors.
    dropped: { type: [Schema.Types.Mixed], default: [] },
    trimmed: { type: [Schema.Types.Mixed], default: [] },
  },
  { timestamps: true, minimize: false },
);

// The cache lookup (and the upsert key when a report is saved).
reportSchema.index({ playerId: 1, analysedGamesHash: 1, promptVersion: 1, model: 1 }, { unique: true });
// "The player's newest report for this model" (GET /report).
reportSchema.index({ playerId: 1, model: 1, createdAt: -1 });

export type ReportFields = InferSchemaType<typeof reportSchema>;
export type ReportDoc = HydratedDocument<ReportFields>;
export const Report = model("Report", reportSchema);
