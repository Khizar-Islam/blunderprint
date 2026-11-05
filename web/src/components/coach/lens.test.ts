import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CoachEvidence } from "@/lib/api";
import { TICK_COLOR } from "../patterns/geometry";
import { lensPlies, lensRows, rowTicks, tickBox } from "./lens";

const ev = (over: Partial<CoachEvidence>): CoachEvidence =>
  ({ gameId: "g", ply: 3, color: "white", ribbon: "gggxg", ...over }) as CoachEvidence;

describe("the fingerprint lens", () => {
  test("only evidence with a ribbon, a colour and a ply inside the ribbon is drawn", () => {
    const rows = lensRows([
      ev({ gameId: "a" }),
      ev({ gameId: "b", ribbon: null }),
      ev({ gameId: "c", color: null }),
      ev({ gameId: "d", ply: 9 }),
      ev({ gameId: "e", ribbon: undefined }),
    ]);
    assert.deepEqual(rows.map((r) => r.gameId), ["a"]);
  });

  test("one shared scale: the longest game fills the width, a late move in a long game still fits", () => {
    const rows = lensRows([ev({ ribbon: "g".repeat(60), ply: 45 }), ev({ ribbon: "g".repeat(160), ply: 151 })]);
    const plies = lensPlies(rows);
    assert.equal(plies, 160);
    assert.deepEqual(tickBox(1, plies, 320), { x: 0, w: 2 });
    const last = tickBox(160, plies, 320);
    assert.equal(last.x + last.w, 320);
    const late = tickBox(151, plies, 320);
    assert.ok(late.x < 320 && late.x > 290, "past the Blunderprint's 120-ply cap, still on the strip");
  });

  test("ticks use the Blunderprint's colours: the player's errors coloured, the opponent faint", () => {
    // White plays odd plies: ply 1 own, 2 opponent, 3 own blunder (x), 4 opponent (x ignored).
    const ticks = rowTicks({ gameId: "a", ply: 3, color: "white", ribbon: "ggxx" });
    assert.deepEqual(
      ticks.map((t) => t.color),
      [TICK_COLOR.own, TICK_COLOR.opponent, TICK_COLOR.blunder, TICK_COLOR.opponent],
    );
    // As Black, the even plies are the player's.
    assert.equal(rowTicks({ gameId: "a", ply: 4, color: "black", ribbon: "ggxm" })[3]!.color, TICK_COLOR.mistake);
  });
});
