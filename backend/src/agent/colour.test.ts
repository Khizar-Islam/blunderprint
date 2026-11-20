import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { colourIn } from "./colour.js";

describe("colourIn: outcome and intensity claims no tool result backs", () => {
  it("outcomes: a move 'cost you the game', 'lost you a point', 'threw away the win'", () => {
    const cases: [string, string[]][] = [
      ["For instance, playing Ke3 on move 41 cost you the game when you had 3 seconds left.", ["cost you the game"]],
      ["That slip costs you a point every time.", ["costs you a point"]],
      ["Blunders like Kg6 occur when your clock drops, frequently costing you valuable pieces and games.", ["costing you valuable pieces and games"]],
      ["It has cost you games.", ["cost you games"]],
      ["Rxf7 lost you the game.", ["lost you the game"]],
      ["You threw away the win with Qd2.", ["threw away"]],
      ["Here you throw the game away.", ["throw the game away"]],
      ["A game-losing king move.", ["game-losing"]],
    ];
    for (const [text, hits] of cases) assert.deepEqual(colourIn(text), hits, text);
  });

  it("intensity: dearly, massive swings, catastrophic, disastrous, devastating, fatal", () => {
    assert.deepEqual(colourIn("Another time, playing Re3 cost you dearly."), ["dearly"]);
    assert.deepEqual(colourIn("Moves like Ke3 slip through, causing massive swings in win-chance points lost."), ["massive swings"]);
    assert.deepEqual(colourIn("A massive swing followed."), ["massive swing"]);
    assert.deepEqual(colourIn("Practise these endings to avoid catastrophic king slips."), ["catastrophic"]);
    assert.deepEqual(colourIn("A disastrous, devastating and fatal mistake."), ["disastrous", "devastating", "fatal"]);
  });

  it("the cost as a figure is fine, in a report and in an answer template", () => {
    for (const text of [
      "Playing Ke3 cost you 18.4 win-chance points with 3 seconds left.",
      "Playing Ke3 on  cost you  when you had  left.", // an answer's sentence with its {{slots}} blanked
      "These inaccuracies cost you key advantages in the middlegame.",
      "The move cost you a pawn and the initiative.",
    ]) {
      assert.deepEqual(colourIn(text), [], text);
    }
  });

  it("ordinary chess prose is left alone (the words deliberately not on the list)", () => {
    for (const text of [
      "Your knight is badly placed on the rim and the bishop is heavily restricted.",
      "The pawn push severely weakens your king side and gives a decisive advantage.",
      "Nf3 was a much better move, with a crushing attack to follow.",
      "You never castle in these games and always push the h-pawn.",
      "White builds a massive pawn centre and you were massively behind in development.",
      "You lost the game on time in the middlegame.",
      "Once the queens come off the ending is lost.",
      "Throw the rook behind the passed pawn instead.",
      "You gave the pawn away for nothing.",
      "This is a scripted practice answer built from your real games, and the positions below are among your costliest errors.",
    ]) {
      assert.deepEqual(colourIn(text), [], text);
    }
  });

  it("the stored real report and answers of 20 Nov 2026: exactly these phrases hit", () => {
    // Every sentence of the one real report (3 patterns) and the three real answers on live.
    const stored = [
      "During the middlegame in your bullet games, you often play moves like fxe5, b5, and Kxb2 when better tactical options are available.",
      "Even with over 50 percent of your clock left, these inaccuracies accumulate and cost you key advantages.",
      "Set up middlegame positions from your bullet games and pause before making pawn pushes or pawn captures to calculate forcing piece checks first.",
      "From move 41 onward in the endgame, time pressure hits hard with under 10 percent of your clock left.",
      "Moves like Ke3, Re3, and Nd4 slip through, causing massive swings in win-chance points lost.",
      "Practice king and rook endgame exercises from move 41 onwards while maintaining a strict clock management habit to avoid catastrophic king slips.",
      "In the Modern Defense, you run into trouble during both the middlegame and endgame phases.",
      "Blunders like Kg6, Qa3, and e5 occur when your clock drops, frequently costing you valuable pieces and games.",
      "Review Modern Defense opening and middlegame tabias to memorize safer square choices instead of pushing e5 or playing passive king moves.",
      "When you're short on time your blunder rate jumps to {{a}}, compared to {{b}} overall.",
      "For instance, playing Ke3 on {{c}} cost you the game when you had {{d}} left on the clock.",
      "Another time, playing Re3 on {{e}} cost you dearly with {{f}} remaining.",
      "And playing Nd4 on {{g}} similarly lost control with {{h}} on the clock.",
      "You are much worse in the endgame where your error rate is {{a}} compared to {{b}} in the opening.",
      "For instance, playing Ke3 on {{c}} or Re3 on {{d}} led to large losses in the endgame.",
      "Your score with Black is {{a}} compared to {{b}} with White.",
      "Your accuracy with Black is {{c}} and with White it is {{d}}.",
    ];
    assert.deepEqual(stored.flatMap(colourIn), ["massive swings", "catastrophic", "costing you valuable pieces and games", "cost you the game", "dearly"]);
  });
});
