import type { Types } from "mongoose";
import { Answer } from "../db/models/answer.js";
import { Player } from "../db/models/player.js";
import { demoKeyParts } from "../lib/demo.js";
import { ASK_PROMPT_VERSION, questionKey } from "./ask.js";
import { analysedBasis } from "./basis.js";

// The suggested questions of "Ask the coach" (Stage 6 chunk C): the chips under the question box.
// The same three for every player; for the demo player they are exactly the pre-answered
// questions (npm run demo:answers), so a visitor's click is answered at once from the cache.
// One list for the page (GET report sends it), the script and the startup check below.
export const SUGGESTED_QUESTIONS = [
  "Why do I lose so many games in time trouble?",
  "Am I worse in the opening or the endgame?",
  "Do I play worse with Black?",
] as const;

// The ASK_PROMPT_VERSION the demo pre-answers were written with. A bump of ASK_PROMPT_VERSION
// makes them stale (the answer cache key includes the prompt version), so the first visitor to
// click a chip would spend real AI calls. suggestions.test.ts fails until this is updated, as a
// reminder: re-run `npm run demo:answers` against live, THEN set this to the new version.
export const DEMO_ANSWERS_PROMPT_VERSION = 5;

export interface Suggestion {
  question: string;
  // An answer for exactly this player's current data, prompt and model is cached: a click is
  // served at once, with no AI call and nothing counted.
  answered: boolean;
}

// One query, on the answer cache's unique index { playerId, questionKey, analysedGamesHash,
// promptVersion, model }.
export async function suggestionsFor(playerId: Types.ObjectId, analysedGamesHash: string, model: string): Promise<Suggestion[]> {
  const keys = SUGGESTED_QUESTIONS.map(questionKey);
  const cached = await Answer.find(
    { playerId, questionKey: { $in: keys }, analysedGamesHash, promptVersion: ASK_PROMPT_VERSION, model },
    { questionKey: 1 },
  ).lean<{ questionKey: string }[]>();
  const have = new Set(cached.map((a) => a.questionKey));
  return SUGGESTED_QUESTIONS.map((question, i) => ({ question, answered: have.has(keys[i]!) }));
}

// For the startup warning: which demo players' suggested questions have no current answer (after
// an ASK_PROMPT_VERSION bump or a model change, or before demo:answers ever ran). Empty when all
// is well. A demo player who isn't stored yet is skipped (nothing to answer about).
export async function staleDemoAnswers(demoKeys: readonly string[], model: string): Promise<{ player: string; missing: string[] }[]> {
  if (!demoKeys.length) return [];
  const players = await Player.find({ $or: demoKeys.map(demoKeyParts) }, { _id: 1, platform: 1, username: 1 }).lean();
  const stale: { player: string; missing: string[] }[] = [];
  for (const p of players) {
    const { hash } = await analysedBasis(p._id);
    const missing = (await suggestionsFor(p._id, hash, model)).filter((s) => !s.answered).map((s) => s.question);
    if (missing.length) stale.push({ player: `${p.platform}:${p.username}`, missing });
  }
  return stale;
}
