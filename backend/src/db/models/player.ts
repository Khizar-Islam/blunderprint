import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";

export const PLATFORMS = ["chesscom", "lichess"] as const;
export type Platform = (typeof PLATFORMS)[number];

export const IMPORT_STATES = ["idle", "importing", "ready", "failed"] as const;

const playerSchema = new Schema(
  {
    platform: { type: String, enum: PLATFORMS, required: true },
    // Display case as the platform returns it; usernameLower is what we look up by.
    username: { type: String, required: true },
    usernameLower: { type: String, required: true },
    profile: {
      ratings: { blitz: Number, rapid: Number, bullet: Number },
      avatarUrl: String,
      country: String,
    },
    importState: { type: String, enum: IMPORT_STATES, default: "idle" },
    lastImportedAt: Date,
    gamesCount: { type: Number, default: 0 },
    analysedCount: { type: Number, default: 0 },
    // Precomputed dashboard aggregates (Stage 3).
    summary: Schema.Types.Mixed,
    summaryVersion: Number,
    // Read by the storage guard (Stage 4) to evict the least-recently-viewed players.
    lastViewedAt: Date,
    // What a re-import needs to fetch only what's new.
    importMeta: {
      // Chess.com month ETags, keyed "YYYY/MM". A 304 for a month means nothing changed in it.
      monthEtags: { type: Map, of: String, default: {} },
      // Newest game we have, in the platform's own time: Chess.com end_time, Lichess createdAt
      // (Lichess's `since` filter works on createdAt). Set only when an import finishes.
      newestGameAt: Date,
    },
  },
  { timestamps: true },
);

// One player per platform + username, case-insensitively. Also the lookup for every
// /api/players/:platform/:username route.
playerSchema.index({ platform: 1, usernameLower: 1 }, { unique: true });

// Storage guard: scan players oldest-viewed first and evict until we're under budget.
playerSchema.index({ lastViewedAt: 1 });

export type PlayerFields = InferSchemaType<typeof playerSchema>;
export type PlayerDoc = HydratedDocument<PlayerFields>;
export const Player = model("Player", playerSchema);
