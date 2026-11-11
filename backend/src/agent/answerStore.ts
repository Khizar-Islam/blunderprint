import type { Types } from "mongoose";
import { Answer, ANSWER_TTL_MS, type AnswerDoc } from "../db/models/answer.js";
import { CANNOT_ANSWER_MESSAGES, type CannotAnswerReason, type VerifiedAnswer } from "./ask.js";
import { evidenceGames, sanToUci, type StoredEvidence } from "./reportStore.js";
import type { SlotKind } from "./slots.js";

// Saving a verified "Ask the coach" answer, and the shape the page gets. Like a report, the
// evidence is stored ready to draw (FEN, moves in SAN and UCI, colour, facts, ribbon).

export interface SaveAnswerInput {
  playerId: Types.ObjectId;
  questionKey: string;
  question: string;
  analysedGamesHash: string;
  analysedGames: number;
  promptVersion: number;
  model: string;
  answeredBy: string;
  runId: Types.ObjectId;
  answer: VerifiedAnswer;
  usage: { calls: number; inputTokens: number; outputTokens: number; totalTokens: number };
  durationMs: number;
}

export async function toStoredEvidence(playerId: Types.ObjectId, answer: VerifiedAnswer): Promise<StoredEvidence[]> {
  const { colorOf, ribbonOf } = await evidenceGames(
    playerId,
    answer.evidence.map((e) => e.gameId),
  );
  return answer.evidence.map((e) => ({
    ...e,
    playedUci: sanToUci(e.fen, e.played),
    betterUci: sanToUci(e.fen, e.betterMove),
    color: colorOf.get(e.gameId) ?? null,
    ribbon: ribbonOf.get(e.gameId) ?? null,
  }));
}

// Saves (or replaces, for the same cache key) the answer, THEN deletes this question's older
// answers for this model. Per model, so a local scripted run never deletes a real answer.
export async function saveAnswer(input: SaveAnswerInput): Promise<AnswerDoc> {
  const evidence = await toStoredEvidence(input.playerId, input.answer);
  const key = {
    playerId: input.playerId,
    questionKey: input.questionKey,
    analysedGamesHash: input.analysedGamesHash,
    promptVersion: input.promptVersion,
    model: input.model,
  };
  const saved = await Answer.findOneAndUpdate(
    key,
    {
      $set: {
        question: input.question,
        runId: input.runId,
        answeredBy: input.answeredBy,
        outcome: input.answer.outcome,
        reason: input.answer.reason ?? null,
        sentences: input.answer.sentences,
        slots: input.answer.slots,
        evidence,
        analysedGames: input.analysedGames,
        usage: input.usage,
        durationMs: input.durationMs,
        removed: input.answer.removed,
        expiresAt: new Date(Date.now() + ANSWER_TTL_MS),
      },
    },
    { upsert: true, returnDocument: "after" },
  );
  await Answer.deleteMany({ playerId: input.playerId, questionKey: input.questionKey, model: input.model, _id: { $ne: saved._id } });
  return saved;
}

// What the page gets. No usage, no removed list.
export interface PublicAnswer {
  id: string;
  runId: string | null;
  question: string;
  generatedAt: string;
  model: string;
  answeredBy: string;
  analysedGames: number;
  outcome: "answer" | "cannot_answer";
  // cannot_answer only: why, and a fixed message (the model's words are never shown for it).
  reason?: CannotAnswerReason;
  message?: string;
  // "You make {{a}} in the endgame." + { a: { text: "7.9 per 100 moves", kind: "per100" } }
  sentences: string[];
  slots: Record<string, { text: string; kind: SlotKind }>;
  evidence: StoredEvidence[];
}

interface AnswerLike {
  _id: unknown;
  runId?: unknown;
  question: string;
  createdAt?: Date;
  updatedAt?: Date;
  model: string;
  answeredBy?: string | null;
  analysedGames: number;
  outcome: string;
  reason?: string | null;
  sentences?: string[];
  slots?: unknown;
  evidence?: unknown[];
}

export const publicAnswerOf = (doc: AnswerDoc) => toPublicAnswer(doc);

export function toPublicAnswer(doc: AnswerDoc | AnswerLike): PublicAnswer {
  const d = doc as AnswerLike;
  const slots = (d.slots ?? {}) as Record<string, { text: string; kind: SlotKind }>;
  const reason = d.outcome === "cannot_answer" ? ((d.reason ?? "no_data") as CannotAnswerReason) : undefined;
  return {
    id: String(d._id),
    runId: d.runId ? String(d.runId) : null,
    question: d.question,
    generatedAt: (d.updatedAt ?? d.createdAt ?? new Date()).toISOString(),
    model: d.model,
    answeredBy: d.answeredBy ?? d.model,
    analysedGames: d.analysedGames,
    outcome: d.outcome === "cannot_answer" ? "cannot_answer" : "answer",
    ...(reason ? { reason, message: CANNOT_ANSWER_MESSAGES[reason] } : {}),
    sentences: [...(d.sentences ?? [])],
    // Only the text and kind: the raw value stays on the server.
    slots: Object.fromEntries(Object.entries(slots).map(([name, s]) => [name, { text: s.text, kind: s.kind }])),
    evidence: (d.evidence ?? []) as StoredEvidence[],
  };
}
