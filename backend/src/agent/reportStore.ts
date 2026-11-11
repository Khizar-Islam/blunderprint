import { Chess } from "chess.js";
import type { Types } from "mongoose";
import { Game } from "../db/models/game.js";
import { Report, type ReportDoc } from "../db/models/report.js";
import { CLASS_LETTER } from "../stats/summary.js";
import { NO_PATTERNS_MESSAGE } from "./friendly.js";
import type { AgentReport } from "./loop.js";
import type { VerifiedEvidence, VerifiedPattern } from "./verifier.js";

// Saving a verified report, and the shape the coach page gets. Everything a pattern card
// needs is stored with the report, so the page makes no extra requests: the statistic ("7.9 vs
// your 3.1"), and per evidence position the FEN, both moves in SAN and as UCI squares (for the
// board's arrows), the player's colour (board orientation), the facts (speed, phase, clock,
// opening) computed by code, and the game's move ribbon (the coach page's "fingerprint lens").

export interface StoredEvidence extends VerifiedEvidence {
  playedUci: string | null;
  betterUci: string | null;
  color: "white" | "black" | null;
  // The whole game's classifications, one letter per ply as in the dashboard's ribbons
  // (b/g/i/m/x, stats/summary.ts), so the page can draw this game's ribbon with no extra
  // request. null for a game without classifications.
  ribbon: string | null;
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

// The evidence games' colour and move ribbon (one letter per ply, b/g/i/m/x), in one query.
export async function evidenceGames(playerId: Types.ObjectId, gameIds: string[]) {
  const ids = [...new Set(gameIds)];
  const games = await Game.find({ _id: { $in: ids }, playerId }, { color: 1, "analysis.classifications": 1 }).lean<
    { _id: unknown; color: string; analysis?: { classifications?: string[] } }[]
  >();
  const colorOf = new Map(games.map((g) => [String(g._id), g.color as "white" | "black"]));
  const ribbonOf = new Map(
    games.map((g) => {
      const classes = g.analysis?.classifications;
      return [String(g._id), classes?.length ? classes.map((c) => CLASS_LETTER[c as keyof typeof CLASS_LETTER] ?? "g").join("") : null];
    }),
  );
  return { colorOf, ribbonOf };
}

export async function toStoredPatterns(playerId: Types.ObjectId, patterns: VerifiedPattern[]): Promise<StoredPattern[]> {
  const { colorOf, ribbonOf } = await evidenceGames(
    playerId,
    patterns.flatMap((p) => p.evidence.map((e) => e.gameId)),
  );
  return patterns.map((p) => ({
    ...p,
    evidence: p.evidence.map((e) => ({
      ...e,
      playedUci: sanToUci(e.fen, e.played),
      betterUci: sanToUci(e.fen, e.betterMove),
      color: colorOf.get(e.gameId) ?? null,
      ribbon: ribbonOf.get(e.gameId) ?? null,
    })),
  }));
}

export interface SaveReportInput {
  playerId: Types.ObjectId;
  analysedGamesHash: string;
  analysedGames: number;
  promptVersion: number;
  // The requested model (part of the cache key).
  model: string;
  // The model that actually wrote the answer: the fallback if the run switched.
  answeredBy: string;
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
        answeredBy: input.answeredBy,
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

// Reports saved before the fingerprint lens existed (Stage 5 chunk D) have no `ribbon` on their
// evidence. On read, fill them from the games (one query) and save them back, so the next read
// is a plain read. No AI call: the report itself doesn't change. `ribbon: null` (a game without
// classifications, or one trimmed away since) counts as filled, so it isn't asked for again.
// The save leaves updatedAt alone: it is the report's "generated" date on the page.
export async function withRibbons<T extends ReportDoc | (ReportLike & { playerId: Types.ObjectId })>(doc: T): Promise<T> {
  const patterns = ((doc as ReportLike).patterns ?? []) as StoredPattern[];
  const missing = patterns.flatMap((p) => p.evidence).filter((e) => e.ribbon === undefined);
  if (missing.length === 0) return doc;
  const { colorOf, ribbonOf } = await evidenceGames(
    doc.playerId as Types.ObjectId,
    missing.map((e) => e.gameId),
  );
  const filled = patterns.map((p) => ({
    ...p,
    evidence: p.evidence.map((e) =>
      e.ribbon === undefined ? { ...e, ribbon: ribbonOf.get(e.gameId) ?? null, color: e.color ?? colorOf.get(e.gameId) ?? null } : e,
    ),
  }));
  await Report.updateOne({ _id: doc._id }, { $set: { patterns: filled } }, { timestamps: false });
  (doc as unknown as { patterns: StoredPattern[] }).patterns = filled;
  return doc;
}

// withRibbons, then the public shape: what every route that serves a STORED report uses.
export async function publicReportOf(doc: ReportDoc): Promise<PublicReport> {
  return toPublicReport(await withRibbons(doc));
}

// What the coach page gets. No dropped/trimmed lists, no usage, no notEnoughData.
export interface PublicReport {
  id: string;
  // The run that wrote it: the page's "How this report was made" reads its trace (14-day TTL).
  runId: string | null;
  generatedAt: string;
  model: string;
  // Usually the same as model; the fallback's id when the run had to switch.
  answeredBy: string;
  promptVersion: number;
  analysedGames: number;
  patterns: StoredPattern[];
  // Set when no pattern survived: a fixed message.
  noPatternsMessage?: string;
}

interface ReportLike {
  _id: unknown;
  runId?: unknown;
  createdAt?: Date;
  updatedAt?: Date;
  model: string;
  answeredBy?: string | null;
  promptVersion: number;
  analysedGames: number;
  patterns?: unknown[];
}

export function toPublicReport(doc: ReportDoc | ReportLike): PublicReport {
  const d = doc as ReportLike;
  const patterns = (d.patterns ?? []) as StoredPattern[];
  return {
    id: String(d._id),
    runId: d.runId ? String(d.runId) : null,
    // updatedAt: a report re-saved under the same key is as new as its last save.
    generatedAt: (d.updatedAt ?? d.createdAt ?? new Date()).toISOString(),
    model: d.model,
    answeredBy: d.answeredBy ?? d.model,
    promptVersion: d.promptVersion,
    analysedGames: d.analysedGames,
    patterns,
    ...(patterns.length === 0 ? { noPatternsMessage: NO_PATTERNS_MESSAGE } : {}),
  };
}
