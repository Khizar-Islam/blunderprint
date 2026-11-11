import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { coachGame } from "../../../scripts/coachFixture.js";
import { clearDb, startTestDb } from "../../../scripts/testDb.js";
import { Game } from "../../db/models/game.js";
import { Player } from "../../db/models/player.js";
import type { AgentContext } from "../context.js";
import { runTool } from "./index.js";

// get_opening_breakdown's name filter (Stage 6 chunk B): an opening family across ECO codes,
// from ALL the player's games. The first live test missed 6 Sicilians spread over 6 codes.

let db: Awaited<ReturnType<typeof startTestDb>>;
let ctx: AgentContext;
before(async () => {
  db = await startTestDb();
  await clearDb();
  const alice = await Player.create({ platform: "lichess", username: "Alice", usernameLower: "alice" });
  const bob = await Player.create({ platform: "lichess", username: "Bob", usernameLower: "bob" });
  ctx = { playerId: alice._id, platform: "lichess" };
  let n = 0;
  const g = (eco: string, openingName: string, color: "white" | "black", result: "win" | "draw" | "loss", mistakes = 0, playerId = alice._id) =>
    coachGame({
      playerId,
      sourceId: `s${++n}`,
      day: n,
      eco,
      openingName,
      color,
      result,
      mistakes: Array.from({ length: mistakes }, (_, i) => ({ ply: (color === "white" ? 11 : 12) + i * 2, kind: "inaccuracy" as const })),
    });
  await Game.insertMany([
    // Alice against the Sicilian (White): 3 codes, 4 games.
    g("B20", "Sicilian Defense", "white", "win", 2),
    g("B33", "Sicilian Defense: Lasker-Pelikan Variation", "white", "loss", 4),
    g("B33", "Sicilian Defense: Lasker-Pelikan Variation", "white", "draw"),
    g("B90", "Sicilian Defense: Najdorf Variation", "white", "win", 1),
    // Alice playing the Sicilian herself (Black): only with color unset.
    g("B22", "Sicilian Defense: Alapin Variation", "black", "loss", 3),
    // "Sicilian" only in the variation: White's own opening, never the Sicilian Defense.
    g("A04", "Zukertort Opening: Sicilian Invitation", "white", "win", 1),
    // Not a Sicilian, and many more games of it.
    ...Array.from({ length: 20 }, () => g("C50", "Italian Game", "white", "win")),
    // Bob's Sicilian never counts for Alice.
    g("B20", "Sicilian Defense", "white", "loss", 1, bob._id),
  ]);
});
after(async () => {
  await db.stop();
});

type Result = { filters: Record<string, unknown>; games: number; matching: Record<string, number | null>; openings: { eco: string; games: number }[] };
const breakdown = async (args: Record<string, unknown>) => {
  const r = await runTool(ctx, "get_opening_breakdown", args);
  assert.ok(r.ok, JSON.stringify(r));
  return r.data as Result;
};

describe("get_opening_breakdown with name", () => {
  it("adds up every matching code, case-insensitively, as White", async () => {
    const r = await breakdown({ name: "sicilian", color: "white", minGames: 1 });
    assert.deepEqual(r.filters, { color: "white", name: "sicilian", minGames: 1 });
    assert.equal(r.games, 25); // all of Alice's White games
    // 4 games: 2 wins, 1 draw, 1 loss → 62.5%; 7 errors in 4 analysed games.
    assert.deepEqual(r.matching, { games: 4, win: 2, draw: 1, loss: 1, scorePct: 62.5, analysedGames: 4, errorsPerGame: 1.75, ecoCodes: 3 });
    assert.deepEqual(r.openings.map((o) => [o.eco, o.games]), [["B33", 2], ["B20", 1], ["B90", 1]]);
  });

  it("matches the family (before \":\"), not the variation: \"Sicilian\" isn't \"Zukertort Opening: Sicilian Invitation\"", async () => {
    const r = await breakdown({ name: "Sicilian", color: "white", minGames: 1 });
    assert.ok(!r.openings.some((o) => o.eco === "A04"));
    assert.equal((await breakdown({ name: "Zukertort", minGames: 1 })).matching.games, 1);
    assert.equal((await breakdown({ name: "Invitation", minGames: 1 })).matching.games, 0);
  });

  it("both colours when color is unset; minGames only trims the rows, never the total", async () => {
    const r = await breakdown({ name: "Sicilian", minGames: 2 });
    assert.equal(r.matching.games, 5);
    assert.equal(r.matching.ecoCodes, 4);
    assert.deepEqual(r.openings.map((o) => o.eco), ["B33"]);
  });

  it("a family the player never played: games 0 (no_data), nothing invented", async () => {
    const r = await breakdown({ name: "French" });
    assert.deepEqual(r.matching, { games: 0, win: 0, draw: 0, loss: 0, scorePct: null, analysedGames: 0, errorsPerGame: null, ecoCodes: 0 });
    assert.deepEqual(r.openings, []);
  });

  it("regex characters are matched literally, and odd names are refused", async () => {
    assert.equal((await breakdown({ name: "Sicilian." })).matching.games, 0);
    for (const bad of ["S", "x".repeat(41), "Sicilian.*", "Sic$", "(a|b)"]) {
      const r = await runTool(ctx, "get_opening_breakdown", { name: bad });
      assert.equal(r.ok, false, bad);
    }
  });

  it("without name, the dashboard's per-code table is unchanged (no matching)", async () => {
    const r = await breakdown({ minGames: 1 });
    assert.equal("matching" in r, false);
    assert.equal(r.openings[0]!.eco, "C50");
  });
});
