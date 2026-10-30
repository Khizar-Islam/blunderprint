import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PLATFORMS } from "./player.js";

export const RESULTS = ["win", "loss", "draw"] as const;
export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "daily"] as const;
export const COLORS = ["white", "black"] as const;
export const ANALYSIS_STATUSES = ["pending", "claimed", "done", "imported"] as const;
export const CLASSIFICATIONS = ["best", "good", "inaccuracy", "mistake", "blunder"] as const;

export type Result = (typeof RESULTS)[number];
export type Speed = (typeof SPEEDS)[number];
export type Color = (typeof COLORS)[number];

// One engine evaluation, always from White's point of view. Exactly one of cp / mate is set.
const evalSchema = new Schema({ cp: Number, mate: Number }, { _id: false });

const gameSchema = new Schema(
  {
    playerId: { type: Schema.Types.ObjectId, ref: "Player", required: true },
    platform: { type: String, enum: PLATFORMS, required: true },
    // Platform game id: Lichess "HqjDTU4A", Chess.com "live/186169734672" (from the game URL).
    sourceId: { type: String, required: true },
    playedAt: { type: Date, required: true },
    // Everything below is from the imported player's point of view.
    color: { type: String, enum: COLORS, required: true },
    result: { type: String, enum: RESULTS, required: true },
    termination: String,
    timeControl: String,
    speed: { type: String, enum: SPEEDS, required: true },
    playerRating: Number,
    opponentRating: Number,
    opponentName: String,
    // Kept for replay on the game review page.
    pgn: { type: String, required: true },
    plies: { type: Number, required: true },
    // Seconds left on the mover's clock after each ply, when the platform records it.
    clocks: { type: [Number], default: undefined },
    // Stage 1 stores the platform's own opening name. Stages 3–4 replace it with the
    // deepest match against our openings collection.
    opening: { eco: String, name: String, ply: Number },
    analysis: {
      status: { type: String, enum: ANALYSIS_STATUSES, default: "pending" },
      claimedBy: String,
      claimExpiresAt: Date,
      engine: String,
      depthOrNodes: Number,
      evals: { type: [evalSchema], default: undefined },
      classifications: { type: [String], enum: CLASSIFICATIONS, default: undefined },
      accuracy: Number,
    },
    // features (mistakes per game) arrives with the extract job in Stage 3.
  },
  { timestamps: true },
);

// Idempotent import: upserting the same game twice updates it instead of duplicating it.
// Keyed by player, not just { platform, sourceId }: if two players we track played each
// other, the game is stored once per player, because color and result are per player.
gameSchema.index({ playerId: 1, sourceId: 1 }, { unique: true });

// Games list with cursor pagination: newest first, _id breaks ties between games with the
// same playedAt, so the index alone gives the full sort order (no in-memory sort).
gameSchema.index({ playerId: 1, playedAt: -1, _id: -1 });

// Work claiming (Stage 2): "pending games for this player".
gameSchema.index({ playerId: 1, "analysis.status": 1 });

// Opening breakdowns (Stage 3) and the coach's opening tool (Stage 5).
gameSchema.index({ playerId: 1, "opening.eco": 1 });

export type GameFields = InferSchemaType<typeof gameSchema>;
export type GameDoc = HydratedDocument<GameFields>;
export const Game = model("Game", gameSchema);
