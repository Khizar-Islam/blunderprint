import { Schema, model, type InferSchemaType } from "mongoose";

// Daily counters (CLAUDE.md §7 "usage"). One small document per scope and day:
//   _id "global:ai|2026-11-05" → { count: 37 }
// The day is a Pacific-time date, because Google's daily request quota resets at midnight
// Pacific; our budget resets at the same moment. Stage 6 adds "ip:<hash>" scopes here.
const usageSchema = new Schema(
  {
    _id: { type: String, required: true },
    count: { type: Number, default: 0 },
    // When the document can go: a few days after its day ended.
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false },
);

// TTL index: MongoDB's background task deletes a document once expiresAt has passed
// (expireAfterSeconds 0 = "at the date stored in the field"), so old days clean themselves up.
usageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type UsageFields = InferSchemaType<typeof usageSchema>;
// Collection name "usage" as in CLAUDE.md (Mongoose would otherwise pluralize it to "usages").
export const Usage = model("Usage", usageSchema, "usage");
