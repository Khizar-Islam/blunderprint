import { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { Game } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { HttpError } from "../middleware/errorHandler.js";

const gameParams = z.object({ id: z.string().regex(/^[0-9a-f]{24}$/i) });

// Everything the game review page needs, minus the claim internals.
const GAME_PROJECTION = {
  __v: 0,
  "analysis.claimedBy": 0,
  "analysis.claimExpiresAt": 0,
};

export function gamesRouter(): Router {
  const router = Router();

  // One game with its PGN, clocks and analysis. `player` lets the page check that the game
  // belongs to the player in its URL (/p/:platform/:username/game/:id) and 404 otherwise.
  router.get("/games/:id", async (req, res) => {
    const parsed = gameParams.safeParse(req.params);
    // A malformed id can't match any game: same answer as a missing one.
    if (!parsed.success) throw new HttpError(404, "Game not found");

    const game = await Game.findById(parsed.data.id, GAME_PROJECTION).lean<
      { _id: Types.ObjectId; playerId: Types.ObjectId } & Record<string, unknown>
    >();
    if (!game) throw new HttpError(404, "Game not found");
    const player = await Player.findById(game.playerId, { platform: 1, username: 1 }).lean();

    const { _id, playerId: _playerId, ...rest } = game;
    res.json({
      game: { id: String(_id), ...rest },
      player: player ? { platform: player.platform, username: player.username } : null,
    });
  });

  return router;
}
