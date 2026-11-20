import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { coachGame, START } from "../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { Answer, ANSWER_TTL_MS } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { Report } from "../db/models/report.js";
import { saveAnswer, toPublicAnswer, type SaveAnswerInput } from "./answerStore.js";
import { CANNOT_ANSWER_MESSAGES, type VerifiedAnswer } from "./ask.js";
import { NO_PATTERNS_MESSAGE } from "./friendly.js";
import { sanToUci, saveReport, toPublicReport, type SaveReportInput } from "./reportStore.js";
import type { VerifiedEvidence, VerifiedPattern } from "./verifier.js";

// The report and answer stores: what is kept, what is replaced, and what the page may see.
// The caches' promises live here: one report per player and model, one answer per player,
// question and model, and a local "scripted" run never deletes a real model's work.

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});

let alice: Types.ObjectId;
let bob: Types.ObjectId;
let aliceGame: string;
let bobGame: string;
beforeEach(async () => {
  await clearDb();
  alice = (await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" }))._id;
  bob = (await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" }))._id;
  const [a, b] = await Game.insertMany([
    coachGame({ playerId: alice, sourceId: "a1", day: 1, color: "black", mistakes: [{ ply: 2, kind: "blunder" }] }),
    coachGame({ playerId: bob, sourceId: "b1", day: 1, mistakes: [{ ply: 1, kind: "mistake" }] }),
  ]);
  aliceGame = String(a!._id);
  bobGame = String(b!._id);
});

const USAGE = { calls: 4, inputTokens: 1000, outputTokens: 200, thoughtTokens: 0, totalTokens: 1200 };

const evidenceOf = (gameId: string, extra: Partial<VerifiedEvidence> = {}): VerifiedEvidence => ({
  gameId,
  ply: 1,
  moveNumber: 1,
  kind: "blunder",
  played: "Nf3",
  betterMove: "e4",
  winPctLost: 31.5,
  fen: START,
  facts: { speed: "blitz", phase: "opening", clockBucket: null, clockLeftSeconds: null, opening: null },
  ...extra,
});

const answerOf = (extra: Partial<VerifiedAnswer> = {}): VerifiedAnswer => ({
  outcome: "answer",
  sentences: ["You make {{a}} in the endgame."],
  slots: { a: { text: "7.9 errors per 100 moves", kind: "per100", value: 7.9234, step: 2, path: "rows[2].per100Moves" } },
  evidence: [],
  removed: ["sentence 2: a digit in the prose"],
  ...extra,
});

const answerInput = (extra: Partial<SaveAnswerInput> = {}): SaveAnswerInput => ({
  playerId: alice,
  questionKey: "q1",
  question: "Why do I blunder in the endgame?",
  analysedGamesHash: "hash-1",
  analysedGames: 20,
  promptVersion: 6,
  model: "real-model",
  answeredBy: "real-model",
  runId: new Types.ObjectId(),
  answer: answerOf(),
  usage: USAGE,
  durationMs: 9000,
  ...extra,
});

const patternOf = (gameId: string, title = "Endgame"): VerifiedPattern => ({
  candidateId: "phase:endgame",
  title,
  explanation: "x",
  drill: "y",
  stat: { measure: "per100Moves", value: 12, unit: "per100", baseline: 7, direction: "higherIsWorse", gapPct: 71, games: 10, moves: 100, errors: 12 },
  evidence: [evidenceOf(gameId)],
});

const reportInput = (extra: Partial<SaveReportInput> = {}): SaveReportInput => ({
  playerId: alice,
  analysedGamesHash: "hash-1",
  analysedGames: 20,
  promptVersion: 6,
  model: "real-model",
  answeredBy: "real-model",
  runId: new Types.ObjectId(),
  report: { patterns: [patternOf(aliceGame)], dropped: [{ title: "Dropped", reasons: ["no evidence"] }], trimmed: [] },
  usage: USAGE,
  durationMs: 40_000,
  ...extra,
});

describe("sanToUci", () => {
  it("a SAN move in a 4-field or a full FEN becomes from-to squares, with the promotion piece", () => {
    assert.equal(sanToUci(START, "Nf3"), "g1f3");
    assert.equal(sanToUci(`${START} 0 1`, "e4"), "e2e4");
    assert.equal(sanToUci("8/4P1k1/8/8/8/8/8/4K3 w - -", "e8=Q"), "e7e8q");
    assert.equal(sanToUci("r3k2r/8/8/8/8/8/8/R3K2R w KQkq -", "O-O"), "e1g1");
  });

  it("no move, or a move that can't be played here, is null (the board then shows no arrow, never a wrong one)", () => {
    assert.equal(sanToUci(START, null), null);
    assert.equal(sanToUci(START, undefined), null);
    assert.equal(sanToUci(START, "Qh5"), null);
    assert.equal(sanToUci("not a fen", "e4"), null);
  });
});

describe("saveAnswer", () => {
  it("stores the evidence ready to draw: both moves as squares, the player's colour, the game's ribbon, a 30-day expiry", async () => {
    const before = Date.now();
    const saved = await saveAnswer(answerInput({ answer: answerOf({ evidence: [evidenceOf(aliceGame, { fen: "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq -", played: "f6", betterMove: "e5", ply: 2 })] }) }));
    const stored = (await Answer.findById(saved._id).lean())!;
    const e = (stored.evidence as unknown as Record<string, unknown>[])[0]!;
    assert.deepEqual([e.playedUci, e.betterUci, e.color], ["f7f6", "e7e5", "black"]);
    const ribbon = e.ribbon as string;
    assert.equal(ribbon.length, 60);
    assert.equal(ribbon[1], "x", "the blunder at ply 2");
    const ttl = stored.expiresAt!.getTime() - before;
    assert.ok(ttl >= ANSWER_TTL_MS && ttl < ANSWER_TTL_MS + 5_000);
  });

  it("evidence pointing at another player's game gets no colour and no ribbon: nothing of that game is read", async () => {
    const saved = await saveAnswer(answerInput({ answer: answerOf({ evidence: [evidenceOf(bobGame)] }) }));
    const e = (saved.evidence as unknown as Record<string, unknown>[])[0]!;
    assert.deepEqual([e.color, e.ribbon], [null, null]);
  });

  it("the same cache key again replaces the answer in place: one document, the same id", async () => {
    const first = await saveAnswer(answerInput());
    const second = await saveAnswer(answerInput({ answer: answerOf({ sentences: ["A newer sentence."] }), answeredBy: "fallback-model" }));
    assert.equal(String(second._id), String(first._id));
    assert.equal(await Answer.countDocuments(), 1);
    const stored = (await Answer.findOne().lean())!;
    assert.deepEqual([stored.sentences, stored.answeredBy], [["A newer sentence."], "fallback-model"]);
  });

  it("two saves of the same key at the same moment leave one document and both succeed", async () => {
    const results = await Promise.allSettled([saveAnswer(answerInput()), saveAnswer(answerInput()), saveAnswer(answerInput())]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
    assert.equal(await Answer.countDocuments(), 1);
  });

  it("new data: the question's older answer is deleted; other questions, other models and other players keep theirs", async () => {
    const old = await saveAnswer(answerInput());
    const otherQuestion = await saveAnswer(answerInput({ questionKey: "q2", question: "Do I play worse with Black?" }));
    const scripted = await saveAnswer(answerInput({ model: "scripted", answeredBy: "scripted" }));
    const bobs = await saveAnswer(answerInput({ playerId: bob }));

    const fresh = await saveAnswer(answerInput({ analysedGamesHash: "hash-2" }));
    const left = (await Answer.find().lean()).map((a) => String(a._id)).sort();
    assert.deepEqual(left, [otherQuestion, scripted, bobs, fresh].map((a) => String(a._id)).sort());
    assert.ok(!left.includes(String(old._id)));
  });

  it("a local scripted run never deletes the real model's answer, whatever its data hash", async () => {
    const real = await saveAnswer(answerInput());
    await saveAnswer(answerInput({ model: "scripted", analysedGamesHash: "hash-9" }));
    assert.ok(await Answer.exists({ _id: real._id }));
    assert.equal(await Answer.countDocuments(), 2);
  });
});

describe("toPublicAnswer", () => {
  it("the page gets each slot's text and kind, never the raw value, its source, the usage or what was removed", async () => {
    const pub = toPublicAnswer(await saveAnswer(answerInput()));
    assert.deepEqual(pub.slots, { a: { text: "7.9 errors per 100 moves", kind: "per100" } });
    assert.deepEqual(pub.sentences, ["You make {{a}} in the endgame."]);
    const text = JSON.stringify(pub);
    for (const secret of ["7.9234", "rows[2]", "removed", "a digit in the prose", "usage", "inputTokens", "questionKey", "analysedGamesHash", "expiresAt"]) {
      assert.ok(!text.includes(secret), `${secret} must not reach the page`);
    }
    assert.equal(pub.outcome, "answer");
    assert.equal(pub.reason, undefined);
    assert.equal(pub.message, undefined);
  });

  it("a refusal shows the fixed message for its reason; an unknown or missing reason falls back to no_data", async () => {
    const refused = answerOf({ outcome: "cannot_answer", reason: "too_few_games", sentences: [], slots: {}, removed: [] });
    const pub = toPublicAnswer(await saveAnswer(answerInput({ answer: refused })));
    assert.deepEqual([pub.outcome, pub.reason, pub.message], ["cannot_answer", "too_few_games", CANNOT_ANSWER_MESSAGES.too_few_games]);
    assert.deepEqual(pub.sentences, []);

    const noReason = toPublicAnswer({ _id: "x", question: "q", model: "m", analysedGames: 3, outcome: "cannot_answer" });
    assert.deepEqual([noReason.reason, noReason.message], ["no_data", CANNOT_ANSWER_MESSAGES.no_data]);
  });

  it("answeredBy falls back to the model; a missing run is null", () => {
    const pub = toPublicAnswer({ _id: "x", question: "q", model: "m", analysedGames: 3, outcome: "answer" });
    assert.deepEqual([pub.answeredBy, pub.runId, pub.sentences, pub.slots, pub.evidence], ["m", null, [], {}, []]);
  });
});

describe("saveReport", () => {
  it("patterns are stored ready to draw; the outcome says whether any survived", async () => {
    const saved = await saveReport(reportInput());
    assert.equal(saved.outcome, "patterns");
    const e = (saved.patterns as unknown as { evidence: Record<string, unknown>[] }[])[0]!.evidence[0]!;
    assert.deepEqual([e.playedUci, e.betterUci, e.color, (e.ribbon as string).length], ["g1f3", "e2e4", "black", 60]);

    const none = await saveReport(reportInput({ analysedGamesHash: "hash-2", report: { patterns: [], dropped: [], trimmed: [] } }));
    assert.equal(none.outcome, "none");
  });

  it("only the newest report per player and model is kept: a new one deletes the older, never another model's or player's", async () => {
    const old = await saveReport(reportInput());
    const scripted = await saveReport(reportInput({ model: "scripted", answeredBy: "scripted" }));
    const bobs = await saveReport(reportInput({ playerId: bob }));

    const fresh = await saveReport(reportInput({ analysedGamesHash: "hash-2" }));
    const left = (await Report.find().lean()).map((r) => String(r._id)).sort();
    assert.deepEqual(left, [scripted, bobs, fresh].map((r) => String(r._id)).sort());
    assert.ok(!left.includes(String(old._id)));
  });

  it("a newer prompt version for the same data also replaces the old report", async () => {
    await saveReport(reportInput());
    const fresh = await saveReport(reportInput({ promptVersion: 7 }));
    const left = await Report.find({ playerId: alice }).lean();
    assert.deepEqual(left.map((r) => [String(r._id), r.promptVersion]), [[String(fresh._id), 7]]);
  });

  it("the same cache key again replaces the report in place, and two saves at the same moment both succeed", async () => {
    const first = await saveReport(reportInput());
    const second = await saveReport(reportInput({ report: { patterns: [patternOf(aliceGame, "Time trouble")], dropped: [], trimmed: [] } }));
    assert.equal(String(second._id), String(first._id));
    assert.equal((second.patterns as unknown as { title: string }[])[0]!.title, "Time trouble");

    await Report.deleteMany({});
    const results = await Promise.allSettled([saveReport(reportInput()), saveReport(reportInput()), saveReport(reportInput())]);
    assert.deepEqual(results.map((r) => r.status), ["fulfilled", "fulfilled", "fulfilled"], JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
    assert.equal(await Report.countDocuments(), 1);
  });
});

describe("toPublicReport", () => {
  it("the page never gets the dropped or trimmed lists or the usage", async () => {
    const pub = toPublicReport(await saveReport(reportInput()));
    const text = JSON.stringify(pub);
    for (const secret of ["dropped", "Dropped", "no evidence", "trimmed", "usage", "inputTokens", "analysedGamesHash"]) {
      assert.ok(!text.includes(secret), `${secret} must not reach the page`);
    }
    assert.equal(pub.patterns.length, 1);
    assert.equal(pub.noPatternsMessage, undefined);
  });

  it("no surviving pattern: the fixed message, never the model's own words", async () => {
    const saved = await saveReport(reportInput({ report: { patterns: [], notEnoughData: "MODEL SAYS: not enough data, trust me", dropped: [], trimmed: [] } }));
    const pub = toPublicReport(saved);
    assert.equal(pub.noPatternsMessage, NO_PATTERNS_MESSAGE);
    assert.ok(!JSON.stringify(pub).includes("MODEL SAYS"));
    assert.ok(!JSON.stringify(await Report.findById(saved._id).lean()).includes("MODEL SAYS"), "it isn't even stored");
  });

  it("a report written by the fallback says so; otherwise answeredBy is the model", async () => {
    assert.equal(toPublicReport(await saveReport(reportInput({ answeredBy: "fallback-model" }))).answeredBy, "fallback-model");
    assert.equal(toPublicReport({ _id: "x", model: "m", promptVersion: 6, analysedGames: 3 }).answeredBy, "m");
  });
});
