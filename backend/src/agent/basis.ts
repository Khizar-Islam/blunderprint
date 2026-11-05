import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import { FEATURES_VERSION } from "../chess/features.js";
import { Game } from "../db/models/game.js";

// What a report is based on: the player's games the coach's tools can read (analysed, and with
// current features). The same query gives the eligibility count ("20 analysed games needed")
// and the report cache key.
export interface AnalysedBasis {
  analysed: number;
  // SHA-1 of FEATURES_VERSION and the sorted game ids. A newly analysed game, a game trimmed
  // away by a re-import, or re-extracted features all change it; nothing else does.
  hash: string;
}

export async function analysedBasis(playerId: Types.ObjectId): Promise<AnalysedBasis> {
  // Starts on the { playerId, "analysis.status" } index; at most MAX_GAMES_PER_PLAYER (200)
  // ids come back, so hashing them is instant.
  const games = await Game.find(
    {
      playerId,
      "analysis.status": { $in: ["done", "imported"] },
      "features.version": FEATURES_VERSION,
      "features.error": { $exists: false },
    },
    { _id: 1 },
  ).lean();
  const ids = games.map((g) => String(g._id)).sort();
  const hash = createHash("sha1").update(`f${FEATURES_VERSION}:${ids.join(",")}`).digest("hex");
  return { analysed: ids.length, hash };
}
