import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dropDoubledNouns,
  fillSentence,
  fillSlot,
  formatSlot,
  parsePath,
  placeholdersIn,
  resolvePath,
  SLOT_KINDS,
  slotContextProblems,
  tidySentence,
  unitTail,
  type FilledSlot,
  type SlotKind,
} from "./slots.js";
import type { ToolLog } from "./verifier.js";

// Number slots (Stage 6 chunk B): the model points at a number, code formats it.

describe("parsePath", () => {
  it("reads keys and array indexes", () => {
    assert.deepEqual(parsePath("errors.per100Moves"), ["errors", "per100Moves"]);
    assert.deepEqual(parsePath("rows[2].per100Moves"), ["rows", 2, "per100Moves"]);
    assert.deepEqual(parsePath("candidates[0].value"), ["candidates", 0, "value"]);
  });

  it("refuses anything else", () => {
    for (const bad of ["", "rows[]", "rows[-1].x", "a..b", ".a", "a.", "a['b']", "a b", "__proto__.x", "a.__proto__", "rows[1234].x", "a.b.c.d.e.f.g.h.i", "x".repeat(121)]) {
      assert.equal(parsePath(bad), null, bad);
    }
  });
});

describe("resolvePath: which fields may be shown", () => {
  const profile = {
    games: 40,
    analysedGames: 30,
    results: { win: 20, draw: 5, loss: 15, scorePct: 56.3 },
    accuracyPct: { all: 81.25, white: 82.4, black: null },
    currentRatings: { blitz: 1850 },
    errors: { total: 210, per100Moves: 7.9124, blunderPer100: 1.04, perGame: 7.0 },
    rows: [{ phase: "endgame", per100Moves: 12.36, ply: 61 }],
    candidates: [
      { id: "phase=endgame", measure: "per100Moves", unit: "per100", value: 12.4, baseline: 7.9, rankScore: 4.2, gapPct: 57 },
      { id: "eco=B01|scorePct", measure: "scorePct", unit: "percent", value: 31.2, baseline: 56.3 },
      { id: "eco=B01|errorsPerGame", measure: "errorsPerGame", unit: "perGame", value: 9.25, baseline: 7 },
      { id: "phase=endgame|kind=blunder", measure: "blunderPer100", unit: "per100", value: 6.8, baseline: 1.9 },
    ],
  };

  const kindOf = (path: string) => {
    const r = resolvePath(profile, path);
    assert.ok(r.ok, `${path}: ${!r.ok ? r.problem : ""}`);
    return r.kind;
  };

  it("by field name", () => {
    assert.equal(kindOf("games"), "count");
    assert.equal(kindOf("results.win"), "count");
    assert.equal(kindOf("results.scorePct"), "score");
    assert.equal(kindOf("errors.per100Moves"), "per100");
    assert.equal(kindOf("errors.blunderPer100"), "per100");
    assert.equal(kindOf("errors.perGame"), "perGame");
    assert.equal(kindOf("rows[0].per100Moves"), "per100");
  });

  it("by parent: accuracyPct.white is a percentage, currentRatings.blitz a rating", () => {
    assert.equal(kindOf("accuracyPct.white"), "percent");
    assert.equal(kindOf("currentRatings.blitz"), "rating");
  });

  it("a candidate's value and baseline take the candidate's unit", () => {
    assert.equal(kindOf("candidates[0].value"), "per100");
    assert.equal(kindOf("candidates[0].baseline"), "per100");
    // A score candidate is a score on both sides, not a bare percentage.
    assert.equal(kindOf("candidates[1].value"), "score");
    assert.equal(kindOf("candidates[1].baseline"), "score");
    assert.equal(kindOf("candidates[2].baseline"), "perGame");
    assert.equal(kindOf("candidates[0].gapPct"), "percent");
  });

  it("refuses fields that aren't figures, missing paths, nulls and non-numbers", () => {
    const problem = (path: string) => {
      const r = resolvePath(profile, path);
      assert.ok(!r.ok, path);
      return r.problem;
    };
    assert.match(problem("rows[0].ply"), /can't be shown/);
    assert.match(problem("candidates[0].rankScore"), /can't be shown/);
    assert.match(problem("rows[3].per100Moves"), /doesn't exist/);
    assert.match(problem("errors.nope"), /doesn't exist/);
    assert.match(problem("accuracyPct.black"), /no value/);
    assert.match(problem("rows[0].phase"), /isn't a number/);
    assert.match(problem("errors"), /isn't a number/);
    assert.match(problem("candidates[0].id"), /isn't a number/);
    assert.match(problem("constructor"), /doesn't exist/);
    assert.match(problem("errors.toString"), /doesn't exist/);
  });

  it("a value or baseline without a known unit can't be shown, nor a rate without a known measure", () => {
    assert.ok(!resolvePath({ c: { unit: "weird", value: 3 } }, "c.value").ok);
    assert.ok(!resolvePath({ c: { unit: "per100", measure: "weird", value: 3 } }, "c.value").ok);
  });
});

describe("formatSlot: every kind decides its rounding and unit", () => {
  const cases: [SlotKind, number, string][] = [
    ["percent", 54.2374, "54.2%"],
    ["percent", 31, "31%"],
    ["percent", 0.2374, "0.2%"],
    ["score", 72.24, "72.2% of the points"],
    ["score", 50, "50% of the points"],
    ["share", 88.19, "88.2% of your errors"],
    ["per100", 7.9124, "7.9 errors per 100 moves"],
    ["per100", 12, "12 errors per 100 moves"],
    ["per100", 1, "1 error per 100 moves"],
    ["perGame", 1.254, "1.25 errors per game"],
    ["perGame", 7.0, "7 errors per game"],
    ["perGame", 0.5, "0.5 errors per game"],
    ["count", 37, "37"],
    ["count", 1234, "1,234"],
    ["count", 36.6, "37"],
    ["moveNumber", 23, "move 23"],
    ["seconds", 12.4, "12 seconds"],
    ["seconds", 1, "1 second"],
    ["seconds", 65, "1 minute 5 seconds"],
    ["seconds", 120, "2 minutes"],
    ["seconds", 61, "1 minute 1 second"],
    ["winPoints", 18.44, "18.4 win-chance points"],
    ["rating", 1849.6, "1850"],
  ];
  for (const [kind, value, text] of cases) {
    it(`${kind} ${value} → "${text}"`, () => assert.equal(formatSlot(value, kind), text));
  }

  it("every kind is covered above, and none prints more than 2 decimals", () => {
    assert.deepEqual(new Set(cases.map((c) => c[0])), new Set(SLOT_KINDS));
    for (const kind of SLOT_KINDS) {
      assert.ok(!/\d\.\d{3}/.test(formatSlot(0.123456, kind)), kind);
    }
  });
});

describe("rates say what they count: the noun is in the unit, written by code", () => {
  const data = {
    errors: { per100Moves: 11.75, inaccuracyPer100: 6.8, mistakePer100: 2.3, blunderPer100: 1, perGame: 4.95 },
    bySpeed: [{ errorsPer100Moves: 12.2 }],
    openings: [{ errorsPerGame: 3.5 }],
    rows: [{ perGame: 0.34 }],
    candidates: [
      { measure: "per100Moves", unit: "per100", value: 14.1, baseline: 11.8 },
      { measure: "inaccuracyPer100", unit: "per100", value: 9.2, baseline: 6.1 },
      { measure: "mistakePer100", unit: "per100", value: 3.4, baseline: 2.4 },
      { measure: "blunderPer100", unit: "per100", value: 6.8, baseline: 3.1 },
      { measure: "errorsPerGame", unit: "perGame", value: 6.25, baseline: 4.95 },
    ],
  };
  const text = (path: string) => {
    const r = fillSlot({ name: "a", step: 1, path }, new Map([[1, { ok: true, tool: "t", data }]]));
    assert.ok(r.ok, path);
    return r.slot.text;
  };
  const cases: [string, string][] = [
    ["errors.per100Moves", "11.8 errors per 100 moves"],
    ["errors.inaccuracyPer100", "6.8 inaccuracies per 100 moves"],
    ["errors.mistakePer100", "2.3 mistakes per 100 moves"],
    ["errors.blunderPer100", "1 blunder per 100 moves"],
    ["errors.perGame", "4.95 errors per game"],
    ["bySpeed[0].errorsPer100Moves", "12.2 errors per 100 moves"],
    ["openings[0].errorsPerGame", "3.5 errors per game"],
    ["rows[0].perGame", "0.34 errors per game"],
    ["candidates[0].value", "14.1 errors per 100 moves"],
    ["candidates[1].baseline", "6.1 inaccuracies per 100 moves"],
    ["candidates[2].value", "3.4 mistakes per 100 moves"],
    ["candidates[3].value", "6.8 blunders per 100 moves"],
    ["candidates[3].baseline", "3.1 blunders per 100 moves"],
    ["candidates[4].value", "6.25 errors per game"],
  ];
  for (const [path, want] of cases) it(`${path} → "${want}"`, () => assert.equal(text(path), want));
});

describe("shares and kind counts say what they count; other counts stay bare", () => {
  const data = {
    rows: [
      { pieceLost: "rook", inaccuracy: 3, mistake: 1, blunder: 9, total: 13, shareOfErrorsPct: 1.3, blunderSharePct: 3.6, mistakeSharePct: 0.5, inaccuracySharePct: 0.6 },
      { pieceLost: "none", inaccuracy: 1, mistake: 3, blunder: 1, total: 954, shareOfErrorsPct: 96.4, blunderSharePct: 88.2, mistakeSharePct: 1, inaccuracySharePct: null },
    ],
    games: 200,
  };
  const log = new Map([[1, { ok: true as const, tool: "get_mistake_breakdown", data }]]);
  const text = (path: string) => {
    const r = fillSlot({ name: "a", step: 1, path }, log);
    assert.ok(r.ok, `${path}: ${!r.ok ? r.problem : ""}`);
    return r.slot.text;
  };
  const cases: [string, string][] = [
    ["rows[1].shareOfErrorsPct", "96.4% of your errors"],
    ["rows[1].blunderSharePct", "88.2% of your blunders"],
    ["rows[0].mistakeSharePct", "0.5% of your mistakes"],
    ["rows[0].inaccuracySharePct", "0.6% of your inaccuracies"],
    ["rows[0].blunder", "9 blunders"],
    ["rows[1].blunder", "1 blunder"],
    ["rows[1].mistake", "3 mistakes"],
    ["rows[0].mistake", "1 mistake"],
    ["rows[0].inaccuracy", "3 inaccuracies"],
    ["rows[1].inaccuracy", "1 inaccuracy"],
    ["rows[1].total", "954"],
    ["games", "200"],
  ];
  for (const [path, want] of cases) it(`${path} → "${want}"`, () => assert.equal(text(path), want));

  it("a null share (the kind has none) is refused", () => {
    const r = fillSlot({ name: "a", step: 1, path: "rows[1].inaccuracySharePct" }, log);
    assert.ok(!r.ok);
    assert.match(r.problem, /has no value/);
  });
});

describe("fillSlot and sentences", () => {
  const log: ToolLog = new Map([
    [1, { ok: true, tool: "get_player_profile", data: { errors: { per100Moves: 7.9124 } } }],
    [2, { ok: false, tool: "find_example_mistakes" }],
  ]);

  it("resolves against this run's log", () => {
    const r = fillSlot({ name: "a", step: 1, path: "errors.per100Moves" }, log);
    assert.ok(r.ok);
    assert.deepEqual(r.slot, { text: "7.9 errors per 100 moves", kind: "per100", value: 7.9124, step: 1, path: "errors.per100Moves" });
  });

  it("names the problem: an unknown step, a failed call, a bad path", () => {
    const problem = (step: number, path: string) => {
      const r = fillSlot({ name: "a", step, path }, log);
      assert.ok(!r.ok);
      return r.problem;
    };
    assert.match(problem(9, "errors.per100Moves"), /step 9 doesn't exist/);
    assert.match(problem(2, "examples[0].moveNumber"), /failed find_example_mistakes call/);
    assert.match(problem(1, "errors.total"), /doesn't exist/);
  });

  it("placeholders and filling", () => {
    assert.deepEqual(placeholdersIn("You make {{a}} and {{ b2 }} here, {{}}."), ["a", "b2", ""]);
    const slots = new Map<string, FilledSlot>([["a", { text: "7.9 errors per 100 moves", kind: "per100", value: 7.9, step: 1, path: "errors.per100Moves" }]]);
    assert.equal(fillSentence("In the endgame you make {{a}}.", slots), "In the endgame you make 7.9 errors per 100 moves.");
  });
});

describe("dropDoubledNouns: a noun repeated after a slot that already says it", () => {
  const slot = (text: string, kind: SlotKind): FilledSlot => ({ text, kind, value: 0, step: 2, path: "rows[0].x" });
  // The fourth live test's (b): the three slots and the sentences the model wrote.
  const slots = new Map<string, FilledSlot>([
    ["a", slot("9 blunders", "count")],
    ["b", slot("3.6% of your blunders", "share")],
    ["c", slot("89.2% of your blunders", "share")],
    ["d", slot("1 blunder", "count")],
    ["e", slot("6.8 blunders per 100 moves", "per100")],
    ["g", slot("37", "count")],
  ]);
  const drop = (t: string) => dropDoubledNouns(t, slots);

  it("the three sentences of (b)", () => {
    assert.deepEqual(drop("The piece you lose most often is a rook with {{a}} blunders."), {
      template: "The piece you lose most often is a rook with {{a}}.",
      dropped: ["doubled noun after {{a}}"],
    });
    assert.deepEqual(drop("This accounts for {{b}} of your blunders."), { template: "This accounts for {{b}}.", dropped: ["doubled noun after {{b}}"] });
    assert.deepEqual(drop("By comparison, {{c}} of your blunders lose no piece at all."), {
      template: "By comparison, {{c}} lose no piece at all.",
      dropped: ["doubled noun after {{c}}"],
    });
    assert.equal(fillSentence(drop("This accounts for {{b}} of your blunders.").template, slots), "This accounts for 3.6% of your blunders.");
  });

  it("case-insensitive, singular or plural either way, and only the noun that is repeated", () => {
    assert.equal(drop("With {{a}} Blunder.").template, "With {{a}}.");
    assert.equal(drop("Only {{d}} blunders here.").template, "Only {{d}} here.");
    assert.equal(drop("Just {{d}} blunder.").template, "Just {{d}}.");
    assert.equal(drop("That is {{b}} blunders.").template, "That is {{b}}.");
    assert.equal(drop("Your rate is {{e}} moves.").template, "Your rate is {{e}}.");
  });

  it("words that don't repeat the slot are left alone", () => {
    for (const t of [
      "You lost a rook in {{a}} of your games.",
      "By comparison, {{c}} lose no piece at all.",
      "That is {{b}} of your errors.",
      "In {{g}} games you blundered.",
      "Your rate is {{e}} in the endgame.",
      "With {{a}}, {{c}} lose nothing.",
      "Unknown {{z}} blunders.",
    ]) {
      assert.deepEqual(drop(t), { template: t, dropped: [] }, t);
    }
  });

  it("unitTail: the slot's text after its number", () => {
    assert.deepEqual(unitTail("6.2 errors per 100 moves"), ["errors", "per", "100", "moves"]);
    assert.deepEqual(unitTail("3.6% of your blunders"), ["%", "of", "your", "blunders"]);
    assert.deepEqual(unitTail("1.25 errors per game"), ["errors", "per", "game"]);
    assert.deepEqual(unitTail("18.4 win-chance points"), ["win-chance", "points"]);
    assert.deepEqual(unitTail("1,234"), []);
    assert.deepEqual(unitTail("54.2%"), ["%"]);
    assert.deepEqual(unitTail("move 23"), []);
  });

  it("the whole unit tail repeated (the demo pre-answer: 'errors per 100 moves errors per 100 moves')", () => {
    const units = new Map<string, FilledSlot>([
      ["a", slot("6.2 errors per 100 moves", "per100")],
      ["b", slot("1.25 errors per game", "perGame")],
      ["c", slot("88.2% of your blunders", "share")],
      ["h", slot("6.8 blunders per 100 moves", "per100")],
      ["w", slot("18.4 win-chance points", "winPoints")],
      ["s", slot("12 seconds", "seconds")],
      ["p", slot("54.2%", "percent")],
    ]);
    const d = (t: string) => dropDoubledNouns(t, units);
    const exact = d("In the opening your overall rate is {{a}} errors per 100 moves.");
    assert.deepEqual(exact, { template: "In the opening your overall rate is {{a}}.", dropped: ["doubled noun after {{a}}"] });
    assert.equal(fillSentence(exact.template, units), "In the opening your overall rate is 6.2 errors per 100 moves.");
    assert.equal(fillSentence(d("You make {{b}} errors per game with Black.").template, units), "You make 1.25 errors per game with Black.");
    assert.equal(fillSentence(d("That is {{c}}% of your blunders.").template, units), "That is 88.2% of your blunders.");
    assert.equal(fillSentence(d("That is {{c}} % of your Blunders.").template, units), "That is 88.2% of your blunders.");
    assert.equal(d("Your rate is {{h}} Blunders Per 100 Moves, against {{a}} per 100 moves.").template, "Your rate is {{h}}, against {{a}}.");
    assert.equal(d("It cost {{w}} win-chance points.").template, "It cost {{w}}.");
    assert.equal(d("With {{s}} seconds left.").template, "With {{s}} left.");
    assert.equal(d("You scored {{p}}% with White.").template, "You scored {{p}} with White.");
  });

  it("the bare noun alone after a rate", () => {
    const units = new Map<string, FilledSlot>([["a", slot("6.2 errors per 100 moves", "per100")]]);
    assert.equal(dropDoubledNouns("You make {{a}} errors in the endgame.", units).template, "You make {{a}} in the endgame.");
    assert.equal(dropDoubledNouns("You make {{a}} in the endgame.", units).dropped.length, 0);
    // Only the first word of the tail on its own: "errors per" + something else is left as written.
    assert.equal(dropDoubledNouns("You make {{a}} errors per game.", units).template, "You make {{a}} per game.");
  });

  it('a word repeated BEFORE a slot that starts with it: "on move {{e}}", e = "move 59"', () => {
    const moves = new Map<string, FilledSlot>([
      ["e", slot("move 59", "moveNumber")],
      ["f", slot("move 61", "moveNumber")],
    ]);
    const d = (t: string) => dropDoubledNouns(t, moves);
    assert.deepEqual(d("You lost it on move {{e}}."), { template: "You lost it on {{e}}.", dropped: ["doubled noun before {{e}}"] });
    assert.equal(fillSentence(d("You lost it on Move {{e}}.").template, moves), "You lost it on move 59.");
    assert.equal(d("Between moves {{e}} and {{f}}.").template, "Between {{e}} and {{f}}.");
    assert.equal(d("Move {{e}} cost you.").template, "{{e}} cost you.");
    // Only the whole word: "remove {{e}}" isn't "move".
    assert.deepEqual(d("Then remove {{e}}."), { template: "Then remove {{e}}.", dropped: [] });
    assert.deepEqual(d("On {{e}} you blundered."), { template: "On {{e}} you blundered.", dropped: [] });
  });

  it("a move can't be a slot: the problem names it", () => {
    assert.deepEqual(resolvePath({ examples: [{ played: "Ke3", betterMove: "Kf2" }] }, "examples[0].played"), {
      ok: false,
      problem: `path "examples[0].played" is a move (Ke3), not a number: write the move itself in the sentence and cite its position as evidence`,
    });
  });

  it("several slots in one sentence", () => {
    assert.deepEqual(drop("You made {{a}} blunders, {{b}} of your blunders."), {
      template: "You made {{a}}, {{b}}.",
      dropped: ["doubled noun after {{a}}", "doubled noun after {{b}}"],
    });
  });
});

describe("a score says it is a share of the points", () => {
  const data = {
    results: { scorePct: 56.25 },
    byColor: { white: { games: 100, scorePct: 72.2 }, black: { games: 100, scorePct: 78.2 } },
    bySpeed: [{ speed: "bullet", scorePct: 61 }],
    openings: [{ eco: "B06", scorePct: 44.44 }],
    matching: { scorePct: 62.5 },
    accuracyPct: { white: 93.1, black: 93.1 },
    candidates: [{ id: "eco=B06|scorePct", measure: "scorePct", unit: "percent", value: 31.2, baseline: 56.3, gapPct: 45 }],
  };
  const log: ToolLog = new Map([[1, { ok: true, tool: "t", data }]]);
  const fill = (path: string) => {
    const r = fillSlot({ name: "a", step: 1, path }, log);
    assert.ok(r.ok, path);
    return r.slot;
  };

  it("every scorePct field, and a score candidate's value and baseline", () => {
    for (const [path, text] of [
      ["results.scorePct", "56.3% of the points"],
      ["byColor.white.scorePct", "72.2% of the points"],
      ["byColor.black.scorePct", "78.2% of the points"],
      ["bySpeed[0].scorePct", "61% of the points"],
      ["openings[0].scorePct", "44.4% of the points"],
      ["matching.scorePct", "62.5% of the points"],
      ["candidates[0].value", "31.2% of the points"],
      ["candidates[0].baseline", "56.3% of the points"],
    ] as const) {
      assert.deepEqual([fill(path).text, fill(path).kind], [text, "score"], path);
    }
  });

  it("accuracy and a gap stay bare percentages", () => {
    assert.deepEqual([fill("accuracyPct.white").text, fill("accuracyPct.white").kind], ["93.1%", "percent"]);
    assert.deepEqual([fill("candidates[0].gapPct").text, fill("candidates[0].gapPct").kind], ["45%", "percent"]);
  });

  it("'you win {{a}}' and 'you score {{a}}' both read true; a repeated unit is dropped", () => {
    const slots = new Map<string, FilledSlot>([["a", fill("byColor.white.scorePct")]]);
    assert.equal(fillSentence("You win {{a}} with White.", slots), "You win 72.2% of the points with White.");
    assert.equal(fillSentence("You score {{a}} with White.", slots), "You score 72.2% of the points with White.");
    assert.deepEqual(unitTail("72.2% of the points"), ["%", "of", "the", "points"]);
    assert.deepEqual(dropDoubledNouns("With White you take {{a}} of the points.", slots), { template: "With White you take {{a}}.", dropped: ["doubled noun after {{a}}"] });
    assert.deepEqual(dropDoubledNouns("With White you score {{a}}% in bullet.", slots), { template: "With White you score {{a}} in bullet.", dropped: ["doubled noun after {{a}}"] });
  });
});

describe("a slot pointing at an example's ply is read as its move number", () => {
  const data = {
    examples: [
      { gameId: "g1", ply: 117, moveNumber: 59, winPctLost: 60.3, played: "Ke3" },
      { gameId: "g2", ply: 90, moveNumber: 45 },
    ],
    rows: [{ phase: "endgame", ply: 61 }],
    odd: [{ ply: 12, moveNumber: null }, { ply: 12, moveNumber: "six" }],
  };
  const log: ToolLog = new Map([[3, { ok: true, tool: "find_example_mistakes", data }]]);

  it("the text is 'move N', stored under moveNumber, with a note for the log", () => {
    const r = fillSlot({ name: "c", step: 3, path: "examples[0].ply" }, log);
    assert.ok(r.ok);
    assert.deepEqual(r.slot, { text: "move 59", kind: "moveNumber", value: 59, step: 3, path: "examples[0].moveNumber" });
    assert.equal(r.note, "slot {{c}}: ply shown as its move number");
    // Black's move: ply 90 is move 45, not 90.
    const black = fillSlot({ name: "d", step: 3, path: "examples[1].ply" }, log);
    assert.ok(black.ok);
    assert.equal(black.slot.text, "move 45");
  });

  it("a moveNumber slot itself has no note", () => {
    const r = fillSlot({ name: "c", step: 3, path: "examples[0].moveNumber" }, log);
    assert.ok(r.ok);
    assert.equal(r.note, undefined);
    assert.equal(r.slot.text, "move 59");
  });

  it("a ply with no move number beside it still can't be shown", () => {
    for (const path of ["rows[0].ply", "odd[0].ply", "odd[1].ply"]) {
      const r = fillSlot({ name: "c", step: 3, path }, log);
      assert.ok(!r.ok, path);
      assert.match(r.problem, /the field "ply" can't be shown/, path);
    }
  });
});

describe("slotContextProblems: the word next to a slot must fit what the slot shows", () => {
  const example = { gameId: "g1", ply: 117, moveNumber: 59, winPctLost: 60.3, clockLeftSeconds: 4.3 };
  const data = { examples: [example], matchingGames: 37, rows: [{ per100Moves: 14.1 }], results: { loss: 12, scorePct: 55 }, currentRatings: { blitz: 1850 } };
  const log: ToolLog = new Map([[3, { ok: true, tool: "find_example_mistakes", data }]]);
  const slots = (paths: Record<string, string>) =>
    new Map<string, FilledSlot>(
      Object.entries(paths).map(([name, path]) => {
        const r = fillSlot({ name, step: 3, path }, log);
        assert.ok(r.ok, path);
        return [name, r.slot];
      }),
    );
  const phrases = (template: string, paths: Record<string, string>) => slotContextProblems(template, slots(paths)).map((p) => [p.phrase, p.need, p.got]);

  it("the live sentence, 'Ke3 on {{c}} lost {{d}}' with c = win-chance points and d = the clock: both caught", () => {
    const wired = slots({ c: "examples[0].winPctLost", d: "examples[0].clockLeftSeconds" });
    assert.equal(fillSentence("Ke3 on {{c}} lost {{d}}", wired), "Ke3 on 60.3 win-chance points lost 4 seconds");
    const problems = slotContextProblems("Ke3 on {{c}} lost {{d}}", wired);
    assert.deepEqual(problems.map((p) => [p.name, p.phrase, p.need, p.got]), [
      ["c", "on {{c}}", "moveNumber", "winPoints"],
      ["d", "lost {{d}}", "winPoints", "seconds"],
    ]);
    assert.equal(
      problems[0]!.message,
      '"on {{c}}" needs a move number (a slot ending in moveNumber), but slot {{c}} is win-chance points (examples[0].winPctLost): point the slot at the right field, or reword the sentence',
    );
    assert.equal(
      problems[1]!.message,
      '"lost {{d}}" needs win-chance points (a slot ending in winPctLost), but slot {{d}} is a clock time (examples[0].clockLeftSeconds): point the slot at the right field, or reword the sentence',
    );
  });

  it("the same sentence wired correctly passes, also through a ply slot", () => {
    assert.deepEqual(phrases("Ke3 on {{c}} lost {{d}}", { c: "examples[0].moveNumber", d: "examples[0].winPctLost" }), []);
    assert.deepEqual(phrases("Ke3 on {{c}} lost {{d}}.", { c: "examples[0].ply", d: "examples[0].winPctLost" }), []);
    assert.deepEqual(phrases("Ke3 on {{c}} cost you {{d}} with {{e}} left.", { c: "examples[0].moveNumber", d: "examples[0].winPctLost", e: "examples[0].clockLeftSeconds" }), []);
  });

  it("each listed context: on / at, lost / cost / costs / costing (you), … left / remaining", () => {
    assert.deepEqual(phrases("It happened at {{c}}.", { c: "examples[0].winPctLost" }), [["at {{c}}", "moveNumber", "winPoints"]]);
    assert.deepEqual(phrases("That cost {{d}}.", { d: "examples[0].clockLeftSeconds" }), [["cost {{d}}", "winPoints", "seconds"]]);
    assert.deepEqual(phrases("That costs you {{d}}.", { d: "examples[0].moveNumber" }), [["costs you {{d}}", "winPoints", "moveNumber"]]);
    assert.deepEqual(phrases("Each one is costing you {{d}}.", { d: "rows[0].per100Moves" }), [["costing you {{d}}", "winPoints", "per100"]]);
    assert.deepEqual(phrases("You played it with {{e}} left.", { e: "examples[0].winPctLost" }), [["{{e}} left", "seconds", "winPoints"]]);
    assert.deepEqual(phrases("You played it with {{e}} remaining on the clock.", { e: "examples[0].moveNumber" }), [["{{e}} remaining", "seconds", "moveNumber"]]);
    assert.deepEqual(phrases("On {{c}} you had {{e}} left.", { c: "examples[0].clockLeftSeconds", e: "examples[0].moveNumber" }), [
      ["on {{c}}", "moveNumber", "seconds"],
      ["{{e}} left", "seconds", "moveNumber"],
    ]);
  });

  it("only those contexts, and not where the word is ordinary with that kind", () => {
    for (const [template, paths] of [
      ["This is based on {{n}} games.", { n: "matchingGames" }],
      ["Your rate stands at {{a}}.", { a: "rows[0].per100Moves" }],
      ["You score {{s}} and are rated at {{r}}.", { s: "results.scorePct", r: "currentRatings.blitz" }],
      ["You moved at {{e}} on the clock.", { e: "examples[0].clockLeftSeconds" }],
      ["You lost {{n}} of those games.", { n: "results.loss" }],
      ["Your rate is {{a}} when you're short on time.", { a: "rows[0].per100Moves" }],
      ["The move gave up {{d}} after {{c}}.", { d: "examples[0].winPctLost", c: "examples[0].moveNumber" }],
      ["A salmon {{d}} and a glost {{d2}}.", { d: "examples[0].clockLeftSeconds", d2: "examples[0].clockLeftSeconds" }],
      ["It was {{c}} leftover.", { c: "examples[0].moveNumber" }],
      ["An unknown {{zz}} left.", {}],
    ] as [string, Record<string, string>][]) {
      assert.deepEqual(phrases(template, paths), [], template);
    }
  });
});

describe("tidySentence: a capital letter at the start, a full stop at the end", () => {
  it("the live sentence gets both", () => {
    assert.deepEqual(tidySentence("when you're short on time your rate is {{a}}, against {{b}} overall"), {
      template: "When you're short on time your rate is {{a}}, against {{b}} overall.",
      changes: ["capital letter added", "full stop added"],
    });
    assert.deepEqual(tidySentence("Ke3 on {{c}} lost {{d}}"), { template: "Ke3 on {{c}} lost {{d}}.", changes: ["full stop added"] });
  });

  it("a sentence that is already fine is untouched", () => {
    for (const s of ["In the opening your rate is {{a}}.", "Is it worse? Yes!", "Do you play worse with Black?", 'You call it "time trouble."', "{{a}} of your blunders come late.", "O-O was better here."]) {
      assert.deepEqual(tidySentence(s), { template: s, changes: [] }, s);
    }
  });

  it("a pawn move at the start keeps its small letter; other small starts are capitalised", () => {
    assert.deepEqual(tidySentence("e5 was the better move"), { template: "e5 was the better move.", changes: ["full stop added"] });
    assert.deepEqual(tidySentence("exd5 on {{c}} lost {{d}}."), { template: "exd5 on {{c}} lost {{d}}.", changes: [] });
    assert.deepEqual(tidySentence("e8=Q+ wins."), { template: "e8=Q+ wins.", changes: [] });
    assert.deepEqual(tidySentence("each of these came late."), { template: "Each of these came late.", changes: ["capital letter added"] });
    assert.deepEqual(tidySentence("b5 pawns are weak"), { template: "b5 pawns are weak.", changes: ["full stop added"] });
    assert.deepEqual(tidySentence("black's rate is {{a}}."), { template: "Black's rate is {{a}}.", changes: ["capital letter added"] });
  });

  it("a trailing comma, colon or space gives way to the full stop; a slot at the end gets one", () => {
    assert.deepEqual(tidySentence("  Your rate is {{a}}, "), { template: "Your rate is {{a}}.", changes: ["full stop added"] });
    assert.deepEqual(tidySentence("Your rate is {{a}}:"), { template: "Your rate is {{a}}.", changes: ["full stop added"] });
    assert.deepEqual(tidySentence(""), { template: "", changes: [] });
  });
});
