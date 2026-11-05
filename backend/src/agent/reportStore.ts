import { Chess } from "chess.js";
import type { Types } from "mongoose";
import { Game } from "../db/models/game.js";
import { Report, type ReportDoc } from "../db/models/report.js";
import { NO_PATTERNS_MESSAGE } from "./friendly.js";
import type { AgentReport } from "./loop.js";
import type { VerifiedEvidence, VerifiedPattern } from "./verifier.js";

// Saving a verified report, and the shape the coach page gets. Everything a pattern card
// needs is stored with the report, so the page makes no extra requests: the statistic ("7.9 vs
// your 3.1"), and per evidence position the FEN, both moves in SAN and as UCI squares (for the
// board's arrows), the player's colour (board orientation) and the facts (speed, phase, clock,
// opening) computed by code.

export interface StoredEvidence extends VerifiedEvidence {
  playedUci: string | null;
  betterUci: string | null;
  color: "white" | "black" | null;
}

export interface StoredPattern extends Omit<VerifiedPattern, "evidence"> {
  evidence: StoredEvidence[];
}

// "Nf3" in this position → "g1f3". null if chess.js can't play it (it always should).
export function sanToUci(fen: string, san: string | null | undefined): string | null {
  if (!san) return null;
  try {
    const chess = new Chess(fen.split(" ").length === 4 ? `${fen} 0 1` : fen);
    const move = chess.move(san);
    return `${move.from}${move.to}${move.promotion ?? ""}`;
  } catch {
    return null;
  }
}

export async function toStoredPatterns(playerId: Types.ObjectId, patterns: VerifiedPattern[]): Promise<StoredPattern[]> {
  const ids = [...new Set(patterns.flatMap((p) => p.evidence.map((e) => e.gameId)))];
  const games = await Game.find({ _id: { $in: ids }, playerId }, { color: 1 }).lean();
  const colorOf = new Map(games.map((g) => [String(g._id), g.color as "white" | "black"]));
  return patterns.map((p) => ({
    ...p,
    evidence: p.evidence.map((e) => ({
      ...e,
      playedUci: sanToUci(e.fen, e.played),
      betterUci: sanToUci(e.fen, e.betterMove),
      color: colorOf.get(e.gameId) ?? null,
    })),
  }));
}

export interface SaveReportInput {
  playerId: Types.ObjectId;
  analysedGamesHash: string;
  analysedGames: number;
  promptVersion: number;
  model: string;
  runId: Types.ObjectId;
  report: AgentReport;
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

// Saves (or replaces, for the same cache key) the report, THEN deletes the player's older
// reports for this model, so there's never a moment with no report at all. Per model, so a
// local run with the scripted model never deletes a real report (the DB may be shared).
export async function saveReport(input: SaveReportInput): Promise<ReportDoc> {
  const patterns = await toStoredPatterns(input.playerId, input.report.patterns);
  const key = {
    playerId: input.playerId,
    analysedGamesHash: input.analysedGamesHash,
    promptVersion: input.promptVersion,
    model: input.model,
  };
  const saved = await Report.findOneAndUpdate(
    key,
    {
      $set: {
        runId: input.runId,
        outcome: patterns.length ? "patterns" : "none",
        patterns,
        analysedGames: input.analysedGames,
        usage: input.usage,
        durationMs: input.durationMs,
        dropped: input.report.dropped,
        trimmed: input.report.trimmed,
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  await Report.deleteMany({ playerId: input.playerId, model: input.model, _id: { $ne: saved._id } });
  return saved;
}

// What the coach page gets. No dropped/trimmed lists, no usage, no notEnoughData.
export interface PublicReport {
  id: string;
  generatedAt: string;
  model: string;
  promptVersion: number;
  analysedGames: number;
  patterns: StoredPattern[];
  // Set when no pattern survived: a fixed message.
  noPatternsMessage?: string;
}

interface ReportLike {
  _id: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  model: string;
  promptVersion: number;
  analysedGames: number;
  patterns?: unknown[];
}

export function toPublicReport(doc: ReportDoc | ReportLike): PublicReport {
  const d = doc as ReportLike;
  const patterns = (d.patterns ?? []) as StoredPattern[];
  return {
    id: String(d._id),
    // updatedAt: a report re-saved under the same key is as new as its last save.
    generatedAt: (d.updatedAt ?? d.createdAt ?? new Date()).toISOString(),
    model: d.model,
    promptVersion: d.promptVersion,
    analysedGames: d.analysedGames,
    patterns,
    ...(patterns.length === 0 ? { noPatternsMessage: NO_PATTERNS_MESSAGE } : {}),
  };
}
