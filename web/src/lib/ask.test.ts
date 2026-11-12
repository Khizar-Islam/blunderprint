import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { AskSuggestion, CoachAnswer } from "./api";
import { askErrorView, boxEnabled, canSend, chipEnabled, cleanQuestion, counter, fillTemplate, questionKeyText, sentenceText } from "./ask";

const slots: CoachAnswer["slots"] = {
  a: { text: "7.9 errors per 100 moves", kind: "per100" },
  b: { text: "3.1 errors per 100 moves", kind: "per100" },
  c: { text: "88.2% of your blunders", kind: "share" },
};

describe("fillTemplate", () => {
  test("plain text only: one text part", () => {
    assert.deepEqual(fillTemplate("Nothing to count here.", slots), [{ type: "text", text: "Nothing to count here." }]);
  });

  test("several slots, with the text between them kept exactly", () => {
    const parts = fillTemplate("You make {{a}} in the endgame, against {{b}} overall.", slots);
    assert.deepEqual(parts, [
      { type: "text", text: "You make " },
      { type: "figure", name: "a", text: "7.9 errors per 100 moves", kind: "per100" },
      { type: "text", text: " in the endgame, against " },
      { type: "figure", name: "b", text: "3.1 errors per 100 moves", kind: "per100" },
      { type: "text", text: " overall." },
    ]);
    assert.equal(sentenceText(parts), "You make 7.9 errors per 100 moves in the endgame, against 3.1 errors per 100 moves overall.");
  });

  test("a slot at the start, at the end, next to punctuation, with spaces inside the braces", () => {
    assert.equal(sentenceText(fillTemplate("{{c}} come in the endgame.", slots)), "88.2% of your blunders come in the endgame.");
    assert.equal(sentenceText(fillTemplate("Your rate is {{ a }}.", slots)), "Your rate is 7.9 errors per 100 moves.");
    assert.deepEqual(fillTemplate("{{a}}", slots), [{ type: "figure", name: "a", text: "7.9 errors per 100 moves", kind: "per100" }]);
  });

  test("the same slot in two sentences fills both", () => {
    const one = sentenceText(fillTemplate("Overall {{b}}.", slots));
    const two = sentenceText(fillTemplate("That's above {{b}}.", slots));
    assert.equal(one, "Overall 3.1 errors per 100 moves.");
    assert.equal(two, "That's above 3.1 errors per 100 moves.");
  });

  test("an unknown slot (or an inherited property name) renders nothing", () => {
    assert.equal(sentenceText(fillTemplate("You make {{zz}} here.", slots)), "You make  here.");
    assert.equal(sentenceText(fillTemplate("{{constructor}}{{toString}}", slots)), "");
  });
});

describe("the question box", () => {
  test("cleanQuestion: NFKC, runs of spaces and line breaks collapse, trimmed (as the API does)", () => {
    assert.equal(cleanQuestion("  Why do I\n\n blunder\t so  much?  "), "Why do I blunder so much?");
    assert.equal(cleanQuestion("ﬁnal"), "final"); // NFKC folds the ligature
  });

  test("counter at 299, 300 and 301 characters", () => {
    const at = (n: number) => counter("a".repeat(n));
    assert.deepEqual(at(299), { length: 299, text: "299 / 300", over: false, near: true, announce: "1 character left" });
    assert.deepEqual(at(300), { length: 300, text: "300 / 300", over: false, near: true, announce: "0 characters left" });
    assert.deepEqual(at(301), { length: 301, text: "301 / 300", over: true, near: true, announce: "1 character too many" });
    assert.equal(at(259).announce, null); // not announced while typing normally
    assert.equal(at(260).announce, "40 characters left");
  });

  test("the counter counts the cleaned text", () => {
    assert.equal(counter("  a   b  ").length, 3);
  });

  test("canSend: 3 to 300 cleaned characters", () => {
    assert.equal(canSend("ab"), false);
    assert.equal(canSend("  ab   "), false);
    assert.equal(canSend("abc"), true);
    assert.equal(canSend("a".repeat(300)), true);
    assert.equal(canSend("a".repeat(301)), false);
    assert.equal(canSend(`${"a".repeat(299)}      `), true);
  });

  test("questionKeyText: case, spacing and trailing ?.! don't make a new question", () => {
    assert.equal(questionKeyText("  Do I play worse with BLACK?! "), questionKeyText("do i play worse with black"));
    assert.notEqual(questionKeyText("Do I play worse with Black?"), questionKeyText("Do I play worse with White?"));
  });
});

describe("askErrorView", () => {
  const msg = "fixed text from the API";
  test("limit_questions: no button (the message says when)", () => {
    assert.deepEqual(askErrorView({ code: "limit_questions", message: msg, retryAfterMs: 5_000 }), { title: "That's the limit for now", message: msg, action: "none" });
  });
  test("busy: Try again after Retry-After (60 s when the header couldn't be read)", () => {
    assert.deepEqual(askErrorView({ code: "busy", message: msg, retryAfterMs: 30_000 }), { title: "The coach is busy", message: msg, action: "retry-later", waitMs: 30_000 });
    assert.equal(askErrorView({ code: "busy", message: msg }).waitMs, 60_000);
  });
  test("ai_disabled, ai_budget_exhausted, not_enough_games: nothing to click", () => {
    for (const code of ["ai_disabled", "ai_budget_exhausted", "not_enough_games"]) assert.equal(askErrorView({ code, message: msg }).action, "none");
    assert.equal(askErrorView({ code: "ai_disabled", message: msg }).title, "New questions are paused");
    assert.equal(askErrorView({ code: "ai_budget_exhausted", message: msg }).title, "The coach is resting");
  });
  test("a failed run, a lost stream or anything unknown: Try again now, with the API's message", () => {
    for (const code of ["coach_timeout", "ai_unavailable", "stream_lost", undefined, "something_new"]) {
      const v = askErrorView({ code, message: msg });
      assert.equal(v.action, "retry");
      assert.equal(v.message, msg);
    }
  });
});

describe("chips and the box", () => {
  const answered: AskSuggestion = { question: "q", answered: true };
  const fresh: AskSuggestion = { question: "q", answered: false };
  test("an answered chip works with the AI off; a new one needs the AI", () => {
    assert.equal(chipEnabled(answered, { aiEnabled: false, busy: false }), true);
    assert.equal(chipEnabled(fresh, { aiEnabled: false, busy: false }), false);
    assert.equal(chipEnabled(fresh, { aiEnabled: true, busy: false }), true);
  });
  test("nothing can be sent while a question is on its way", () => {
    assert.equal(chipEnabled(answered, { aiEnabled: true, busy: true }), false);
    assert.equal(boxEnabled({ aiEnabled: true, busy: true }), false);
    assert.equal(boxEnabled({ aiEnabled: false, busy: false }), false);
    assert.equal(boxEnabled({ aiEnabled: true, busy: false }), true);
  });
});
