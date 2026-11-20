import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { canLand, canStart, carryKey, carryTransform, parsePrintBox, visibleShare } from "./printCarry";

describe("printCarry", () => {
  test("the transform keeps the copy in place, then puts it on the target", () => {
    const from = { left: 400, top: 120, width: 800, height: 600 };
    assert.equal(carryTransform(from, from), "translate(400.00px, 120.00px) scale(1.0000, 1.0000)");
    assert.equal(carryTransform(from, { left: 40, top: 300, width: 600, height: 800 }), "translate(40.00px, 300.00px) scale(0.7500, 1.3333)");
  });
  test("an empty source box never divides by zero", () => {
    assert.equal(carryTransform({ left: 0, top: 0, width: 0, height: 0 }, { left: 5, top: 6, width: 10, height: 10 }), "translate(5.00px, 6.00px) scale(1.0000, 1.0000)");
  });
  test("the visible share of a box", () => {
    assert.equal(visibleShare({ left: 0, top: 0, width: 100, height: 100 }, 1280, 900), 1);
    assert.equal(visibleShare({ left: 0, top: 850, width: 100, height: 100 }, 1280, 900), 0.5);
    assert.equal(visibleShare({ left: -50, top: 850, width: 100, height: 100 }, 1280, 900), 0.25);
    assert.equal(visibleShare({ left: 0, top: 1000, width: 100, height: 100 }, 1280, 900), 0);
    assert.equal(visibleShare({ left: 0, top: 0, width: 0, height: 100 }, 1280, 900), 0);
  });
  test("it starts only when most of the print is on screen", () => {
    assert.equal(canStart({ left: 430, top: 60, width: 820, height: 800 }, 1280, 900), true);
    assert.equal(canStart({ left: 20, top: 560, width: 350, height: 800 }, 390, 844), false, "a phone: the print is under the words");
  });
  test("it lands only when a good part of the dashboard's print is on screen", () => {
    assert.equal(canLand({ left: 32, top: 520, width: 800, height: 800 }, 1280, 900), true);
    assert.equal(canLand({ left: 20, top: 1400, width: 350, height: 600 }, 390, 844), false);
    assert.equal(canLand({ left: 0, top: 0, width: 0, height: 0 }, 1280, 900), false);
  });
  test("the print's box is read from the canvas's attribute", () => {
    assert.deepEqual(parsePrintBox("363,48,725.5,800"), { left: 363, top: 48, width: 725.5, height: 800 });
    for (const bad of [undefined, "", "1,2,3", "1,2,0,4", "a,b,c,d", "1,2,3,NaN"]) assert.equal(parsePrintBox(bad), null, String(bad));
  });
  test("the key ignores the username's case", () => {
    assert.equal(carryKey("lichess", "DrNykterstein"), "lichess:drnykterstein");
  });
});
