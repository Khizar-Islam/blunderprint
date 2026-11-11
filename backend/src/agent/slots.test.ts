import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { dropDoubledNouns, fillSentence, fillSlot, formatSlot, parsePath, placeholdersIn, resolvePath, SLOT_KINDS, type FilledSlot, type SlotKind } from "./slots.js";
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
    assert.equal(kindOf("results.scorePct"), "percent");
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
    assert.equal(kindOf("candidates[1].value"), "percent");
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

  it("several slots in one sentence", () => {
    assert.deepEqual(drop("You made {{a}} blunders, {{b}} of your blunders."), {
      template: "You made {{a}}, {{b}}.",
      dropped: ["doubled noun after {{a}}", "doubled noun after {{b}}"],
    });
  });
});
