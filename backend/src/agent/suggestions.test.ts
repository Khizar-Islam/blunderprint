import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Types } from "mongoose";
import { standardCoachGames } from "../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../scripts/testDb.js";
import { Answer } from "../db/models/answer.js";
import { Game } from "../db/models/game.js";
import { Player } from "../db/models/player.js";
import { ASK_PROMPT_VERSION, questionKey } from "./ask.js";
import { analysedBasis } from "./basis.js";
import { DEMO_ANSWERS_PROMPT_VERSION, staleDemoAnswers, SUGGESTED_QUESTIONS, suggestionsFor } from "./suggestions.js";

let db: Awaited<ReturnType<typeof startTestDb>>;
before(async () => {
  db = await startTestDb();
});
after(async () => {
  await db.stop();
});
beforeEach(clearDb);

// The tripwire: bumping ASK_PROMPT_VERSION makes the demo player's pre-answers stale (the cache
// key includes the prompt version), so the first visitor to click a chip would spend AI calls.
test("the demo pre-answers were written with the current ASK_PROMPT_VERSION", () => {
  assert.equal(
    DEMO_ANSWERS_PROMPT_VERSION,
    ASK_PROMPT_VERSION,
    "ASK_PROMPT_VERSION changed: re-run `npm run demo:answers` against live (backend/, with DEMO_PLAYERS set), " +
      "then set DEMO_ANSWERS_PROMPT_VERSION in agent/suggestions.ts to the new version.",
  );
});

test("three distinct suggested questions, each a valid question (3-300 characters, distinct cache keys)", () => {
  assert.equal(SUGGESTED_QUESTIONS.length, 3);
  assert.equal(new Set(SUGGESTED_QUESTIONS.map(questionKey)).size, 3);
  for (const q of SUGGESTED_QUESTIONS) assert.ok(q.length >= 3 && q.length <= 300);
});

async function cacheAnswer(playerId: Types.ObjectId, question: string, hash: string, model = "m", promptVersion = ASK_PROMPT_VERSION) {
  await Answer.create({
    playerId,
    questionKey: questionKey(question),
    question,
    analysedGamesHash: hash,
    promptVersion,
    model,
    runId: new Types.ObjectId(),
    outcome: "answer",
    analysedGames: 10,
  });
}

test("suggestionsFor: answered only for this player's current data, prompt version and model", async () => {
  const alice = await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });
  const bob = await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" });
  await cacheAnswer(alice._id, SUGGESTED_QUESTIONS[0], "h1");
  await cacheAnswer(alice._id, SUGGESTED_QUESTIONS[1], "old-hash");
  await cacheAnswer(alice._id, SUGGESTED_QUESTIONS[2], "h1", "other-model");
  await cacheAnswer(bob._id, SUGGESTED_QUESTIONS[1], "h1");

  const s = await suggestionsFor(alice._id, "h1", "m");
  assert.deepEqual(s, [
    { question: SUGGESTED_QUESTIONS[0], answered: true },
    { question: SUGGESTED_QUESTIONS[1], answered: false },
    { question: SUGGESTED_QUESTIONS[2], answered: false },
  ]);
});

test("staleDemoAnswers: lists a demo player's unanswered suggestions; empty once all are answered; skips unknown players", async () => {
  const demo = await Player.create({ platform: "lichess", username: "DemoGuy", usernameLower: "demoguy" });
  await Game.insertMany(standardCoachGames(demo._id));
  const { hash } = await analysedBasis(demo._id);
  const keys = ["lichess:demoguy", "chesscom:notstoredyet"];

  assert.deepEqual(await staleDemoAnswers(keys, "m"), [{ player: "lichess:DemoGuy", missing: [...SUGGESTED_QUESTIONS] }]);
  await cacheAnswer(demo._id, SUGGESTED_QUESTIONS[0], hash);
  await cacheAnswer(demo._id, SUGGESTED_QUESTIONS[2], hash);
  assert.deepEqual(await staleDemoAnswers(keys, "m"), [{ player: "lichess:DemoGuy", missing: [SUGGESTED_QUESTIONS[1]] }]);
  await cacheAnswer(demo._id, SUGGESTED_QUESTIONS[1], hash);
  assert.deepEqual(await staleDemoAnswers(keys, "m"), []);
  // A model change makes them all stale again.
  assert.equal((await staleDemoAnswers(keys, "new-model"))[0]?.missing.length, 3);
  assert.deepEqual(await staleDemoAnswers([], "m"), []);
});
