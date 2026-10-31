import { Schema, model, type InferSchemaType, type HydratedDocument } from "mongoose";
import { PLATFORMS } from "./player.js";

export const RESULTS = ["win", "loss", "draw"] as const;
export const SPEEDS = ["bullet", "blitz", "rapid", "classical", "daily"] as const;
export const COLORS = ["white", "black"] as const;
// pending → claimed (a browser is analysing it) → done; imported = came with Lichess's evals;
// unanalysable = the browser couldn't replay the stored PGN (see analysis.error), never claimed again.
export const ANALYSIS_STATUSES = ["pending", "claimed", "done", "imported", "unanalysable"] as const;
export const CLASSIFICATIONS = ["best", "good", "inaccuracy", "mistake", "blunder"] as const;

export type Result = (typeof RESULTS)[number];
export type Speed = (typeof SPEEDS)[number];
export type Color = (typeof COLORS)[number];
export type Classification = (typeof CLASSIFICATIONS)[number];
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

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
      // The claim token (POST /api/analysis/claim). Kept after "done" so a repeated result post
      // from the same claim is recognised and answered 200 instead of 409.
      claimedBy: String,
      claimExpiresAt: Date,
      engine: String,
      depthOrNodes: Number,
      evals: { type: [evalSchema], default: undefined },
      // Per ply: the engine's best move (UCI) in the position before it, or null when unknown
      // (imported Lichess games only name it on judged moves). Stage 5 uses it as bestHint.
      best: { type: [String], default: undefined },
      classifications: { type: [String], enum: CLASSIFICATIONS, default: undefined },
      // The imported player's average move accuracy, 0–100 (see chess/classify.ts).
      accuracy: Number,
      // How long the browser took for the whole game: the Stage 2 measurement for the README.
      durationMs: Number,
      analysedAt: Date,
      // Why a game is unanalysable: { code: "illegal_pgn" | "ply_mismatch", atPly? }.
      error: { code: String, atPly: Number },
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

// Work claiming (POST /api/analysis/claim): "pending (or expired-claim) games for this player".
// The claim also sorts newest first, and that sort runs in memory: this index doesn't include
// playedAt. Deliberate: a player has at most MAX_GAMES_PER_PLAYER (200) games, so sorting the
// pending ones costs microseconds, while a second index, or a wider one, costs storage and
// write time on every game insert and update on the 512 MB M0 cluster.
gameSchema.index({ playerId: 1, "analysis.status": 1 });

// Opening breakdowns (Stage 3) and the coach's opening tool (Stage 5).
gameSchema.index({ playerId: 1, "opening.eco": 1 });

export type GameFields = InferSchemaType<typeof gameSchema>;
export type GameDoc = HydratedDocument<GameFields>;
export const Game = model("Game", gameSchema);
