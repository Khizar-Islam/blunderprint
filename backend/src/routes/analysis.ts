import { randomUUID } from "node:crypto";
import express, { Router } from "express";
import type { Types } from "mongoose";
import { z } from "zod";
import { averageAccuracy, classifyGame } from "../chess/classify.js";
import { Game } from "../db/models/game.js";
import { PLATFORMS, Player } from "../db/models/player.js";
import { logger } from "../lib/logger.js";
import { parseOr400 } from "../lib/validate.js";
import { HttpError } from "../middleware/errorHandler.js";

// Browser-side engine analysis (CLAUDE.md section 8.2). The browser is untrusted: it only ever
// sends evals for games the server handed it, and the server checks and classifies them.
//
//   POST /api/analysis/claim    → up to K games to analyse, leased to a random claim token
//   POST /api/analysis/results  → one game's evals (or "can't replay this PGN")
//   POST /api/analysis/release  → hand unfinished games back (sendBeacon when the tab closes)
//
// The claim token is the lease: a result is accepted only while the game is still claimed by
// that token. When a lease expires, another tab can reclaim the game, which changes the token,
// so a late result from the first tab is refused (409) without comparing any clocks.

export interface AnalysisRouterOptions {
  claimSize?: number; // K
  leaseMs?: number;
}

const ENGINE = "sf19-lite";
// lila's Analysis.MAX_PLIES. Also keeps a result post far below the 100 kb body limit
// (600 plies of evals + best + moves is ~20 kb).
const MAX_PLIES = 600;

const objectId = z.string().regex(/^[0-9a-f]{24}$/i);
const claimId = z.uuid();
const uci = z.string().regex(/^[a-h][1-8][a-h][1-8][qrbn]?$/);

const claimBody = z.object({
  platform: z.enum(PLATFORMS),
  username: z.string().min(1).max(30),
  prefer: objectId.optional(), // the game review page asks for its own game first
});

// Exactly one of cp / mate. Bounds are generous for real engine output and reject nonsense.
const evalEntry = z.union([
  z.strictObject({ cp: z.number().int().min(-20_000).max(20_000) }),
  z.strictObject({ mate: z.number().int().min(-250).max(250) }),
]);

const resultBody = z.union([
  z.strictObject({
    claimId,
    gameId: objectId,
    evals: z.array(evalEntry).max(MAX_PLIES),
    best: z.array(uci.nullable()).max(MAX_PLIES),
    moves: z.array(uci).max(MAX_PLIES),
    engine: z.literal(ENGINE),
    nodes: z.number().int().min(1_000).max(5_000_000),
    durationMs: z.number().int().min(0).max(3_600_000),
  }),
  // The browser's chess.js couldn't replay the stored PGN (illegal move), or replayed a
  // different number of moves than the server counted from the PGN text.
  z.strictObject({
    claimId,
    gameId: objectId,
    error: z.enum(["illegal_pgn", "ply_mismatch"]),
    atPly: z.number().int().min(0).max(MAX_PLIES).optional(),
  }),
]);

const releaseBody = z.object({
  claimId,
  gameIds: z.array(objectId).min(1).max(10),
});

// "Free to claim": never claimed, or claimed by a tab whose lease ran out (closed, crashed,
// asleep). No reaper job needed: an expired claim is simply claimable again.
const claimable = (now: Date) => ({
  $or: [
    { "analysis.status": "pending" as const },
    { "analysis.status": "claimed" as const, "analysis.claimExpiresAt": { $lt: now } },
  ],
});

export function analysisRouter({ claimSize = 3, leaseMs = 10 * 60_000 }: AnalysisRouterOptions = {}): Router {
  const router = Router();

  router.post("/analysis/claim", async (req, res) => {
    const { platform, username, prefer } = parseOr400(claimBody, req.body, "Invalid claim request");
    const player = await Player.findOne({ platform, usernameLower: username.toLowerCase() }, { _id: 1 }).lean();
    if (!player) throw new HttpError(404, "Player not found");

    const id = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMs);
    const claimed: { _id: Types.ObjectId; pgn: string; plies: number; color: string }[] = [];

    // One atomic findOneAndUpdate per game: two tabs claiming at the same moment can never
    // get the same game, because each update re-checks "still claimable" as it writes.
    // Uses the { playerId, "analysis.status" } index for each $or branch; the newest-first sort
    // runs in memory over at most MAX_GAMES_PER_PLAYER games (see the comment on that index).
    const claimNext = (onlyGameId?: string) =>
      Game.findOneAndUpdate(
        { playerId: player._id, ...(onlyGameId ? { _id: onlyGameId } : {}), ...claimable(now) },
        {
          $set: { "analysis.status": "claimed", "analysis.claimedBy": id, "analysis.claimExpiresAt": expiresAt },
        },
        { sort: { playedAt: -1, _id: -1 }, projection: { pgn: 1, plies: 1, color: 1 }, returnDocument: "after" },
      ).lean<{ _id: Types.ObjectId; pgn: string; plies: number; color: string }>();

    if (prefer) {
      const game = await claimNext(prefer);
      if (game) claimed.push(game);
    }
    while (claimed.length < claimSize) {
      const game = await claimNext();
      if (!game) break;
      claimed.push(game);
    }

    res.json({
      claimId: id,
      expiresAt: expiresAt.toISOString(),
      engine: ENGINE,
      games: claimed.map((g) => ({ id: String(g._id), pgn: g.pgn, plies: g.plies, color: g.color })),
    });
  });

  router.post("/analysis/results", async (req, res) => {
    const body = parseOr400(resultBody, req.body, "Invalid analysis result");
    const game = await Game.findById(body.gameId, {
      playerId: 1,
      platform: 1,
      sourceId: 1,
      plies: 1,
      color: 1,
      "analysis.status": 1,
      "analysis.claimedBy": 1,
    }).lean();
    if (!game) throw new HttpError(404, "Game not found");

    // Answers a post that doesn't (or no longer) hold the claim: the same claim posting its
    // result twice (a retried request) is fine; anyone else is told the lease is gone.
    const notClaimed = (current: { status?: string | null; claimedBy?: string | null } | null | undefined) => {
      if (current?.claimedBy === body.claimId && (current.status === "done" || current.status === "unanalysable")) {
        res.json({ ok: true, alreadyDone: true });
        return;
      }
      throw new HttpError(409, "This claim has expired or another tab took the game over");
    };
    if (game.analysis?.status !== "claimed" || game.analysis.claimedBy !== body.claimId) {
      notClaimed(game.analysis);
      return;
    }
    // The conditional write below is what really guards the claim: between the read above and
    // the write, the lease may expire and another tab reclaim the game.
    const stillOurs = { _id: game._id, "analysis.status": "claimed" as const, "analysis.claimedBy": body.claimId };
    const recheck = async () =>
      notClaimed((await Game.findById(game._id, { "analysis.status": 1, "analysis.claimedBy": 1 }).lean())?.analysis);

    if ("error" in body) {
      const result = await Game.updateOne(stillOurs, {
        $set: {
          "analysis.status": "unanalysable",
          "analysis.error": { code: body.error, atPly: body.atPly },
          "analysis.analysedAt": new Date(),
        },
        $unset: { "analysis.claimExpiresAt": 1 },
      });
      if (result.matchedCount === 0) return recheck();
      // Worth a look: either the platform sent a PGN chess.js rejects, or our text ply count
      // (importers/normalize.ts) disagreed with a real replay.
      logger.warn("Game marked unanalysable", {
        gameId: String(game._id),
        platform: game.platform,
        sourceId: game.sourceId,
        code: body.error,
        atPly: body.atPly,
        plies: game.plies,
      });
      res.json({ ok: true });
      return;
    }

    // Plies were counted from the PGN text at import; the browser replayed the PGN with
    // chess.js. One eval, best move and played move per ply, or the result doesn't fit the game.
    const { evals, best, moves } = body;
    if (evals.length !== game.plies || best.length !== game.plies || moves.length !== game.plies) {
      throw new HttpError(400, "Analysis doesn't match the game's number of moves");
    }
    // { mate: 0 } means "the side to move is checkmated", so only the final position can be it.
    if (evals.some((e, i) => "mate" in e && e.mate === 0 && i !== evals.length - 1)) {
      throw new HttpError(400, "Invalid analysis result");
    }

    const classifications = classifyGame({ evals, best, moves });
    const accuracy = averageAccuracy(evals, game.color);
    const result = await Game.updateOne(stillOurs, {
      $set: {
        "analysis.status": "done",
        "analysis.engine": ENGINE,
        "analysis.depthOrNodes": body.nodes,
        "analysis.evals": evals,
        "analysis.best": best,
        "analysis.classifications": classifications,
        "analysis.accuracy": accuracy,
        "analysis.durationMs": body.durationMs,
        "analysis.analysedAt": new Date(),
      },
      $unset: { "analysis.claimExpiresAt": 1 },
    });
    if (result.matchedCount === 0) return recheck();

    await Player.updateOne({ _id: game.playerId }, { $inc: { analysedCount: 1 } });
    res.json({ ok: true, classifications, accuracy });
  });

  // sendBeacon (the tab is closing) can't set Content-Type: application/json without a CORS
  // preflight, which a closing page never waits for. So the browser sends the JSON as
  // text/plain, a "simple" request: this route has its own small text parser and parses the
  // JSON itself. Plain JSON posts (fetch) are accepted too.
  router.post("/analysis/release", express.text({ type: "text/plain", limit: "2kb" }), async (req, res) => {
    let raw: unknown = req.body;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        throw new HttpError(400, "Request body is not valid JSON");
      }
    }
    const { claimId: id, gameIds } = parseOr400(releaseBody, raw, "Invalid release request");
    // By _id, so it's an index lookup; only games still held by this claim go back.
    const result = await Game.updateMany(
      { _id: { $in: gameIds }, "analysis.status": "claimed", "analysis.claimedBy": id },
      { $set: { "analysis.status": "pending" }, $unset: { "analysis.claimedBy": 1, "analysis.claimExpiresAt": 1 } },
    );
    res.json({ released: result.modifiedCount });
  });

  return router;
}
