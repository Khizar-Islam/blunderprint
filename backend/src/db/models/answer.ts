import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

// A verified "Ask the coach" answer (Stage 6 chunk B, CLAUDE.md §7 "answers"): the answer cache.
//
// The cache key is (playerId, questionKey, analysedGamesHash, promptVersion, model): the same
// question (agent/ask.ts questionKey: case, spacing and trailing punctuation ignored) about the
// same analysed games, asked of the same prompt and model, gets the stored answer with no AI call.
// Only the newest answer per player, question and model is kept (the handler deletes older ones).
const answerSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, required: true },
    questionKey: { type: String, required: true },
    // The question as first asked (cleaned), for the page and the logs.
    question: { type: String, required: true },
    analysedGamesHash: { type: String, required: true },
    promptVersion: { type: Number, required: true },
    model: { type: String, required: true },
    answeredBy: String,
    runId: { type: Schema.Types.ObjectId, required: true },
    outcome: { type: String, enum: ["answer", "cannot_answer"], required: true },
    reason: String,
    // Templates with {{name}} placeholders, and the slots code filled (agent/slots.ts).
    sentences: { type: [String], default: [] },
    slots: { type: Schema.Types.Mixed, default: {} },
    // StoredEvidence (agent/reportStore.ts): FEN, moves in SAN and UCI, colour, facts, ribbon.
    evidence: { type: [Schema.Types.Mixed], default: [] },
    analysedGames: { type: Number, required: true },
    usage: { calls: Number, inputTokens: Number, outputTokens: Number, totalTokens: Number },
    durationMs: Number,
    // What the verifier removed, and why. Logs only, never sent.
    removed: { type: [String], default: [] },
    // Deleted by the TTL index 30 days after it was written, so one-off questions don't pile up
    // in the free 512 MB. Chunk C's demo pre-answers will be kept by leaving it out.
    expiresAt: Date,
  },
  { timestamps: true, minimize: false },
);

// The cache lookup and the upsert key. Its prefix (playerId, questionKey) also serves the
// "delete this question's older answers" query.
answerSchema.index({ playerId: 1, questionKey: 1, analysedGamesHash: 1, promptVersion: 1, model: 1 }, { unique: true });
answerSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const ANSWER_TTL_MS = 30 * 24 * 60 * 60_000;

export type AnswerFields = InferSchemaType<typeof answerSchema>;
export type AnswerDoc = HydratedDocument<AnswerFields>;
export const Answer = model("Answer", answerSchema);
