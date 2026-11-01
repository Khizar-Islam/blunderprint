import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { Throughput } from "./throughput";

describe("Throughput", () => {
  test("2 engines finishing 2 games each 20 s apart → 10 s per game", () => {
    const t = new Throughput();
    t.setRunning(true, 0);
    assert.equal(t.gameFinished(20_000), null); // one game says nothing about the rate yet
    assert.equal(t.gameFinished(20_500), 20.5 / 2);
    t.gameFinished(40_000);
    assert.equal(t.gameFinished(40_000), 10);
  });

  test("paused or idle time doesn't count", () => {
    const t = new Throughput();
    t.setRunning(true, 0);
    t.gameFinished(10_000);
    t.setRunning(false, 12_000); // paused for a minute
    t.setRunning(true, 72_000);
    assert.equal(t.gameFinished(80_000), 10); // (12 s + 8 s) / 2
  });

  test("repeated state changes don't double count", () => {
    const t = new Throughput();
    t.setRunning(true, 0);
    t.setRunning(true, 5_000);
    t.setRunning(false, 10_000);
    t.setRunning(false, 50_000);
    t.gameFinished(60_000);
    assert.equal(t.gameFinished(60_000), 5);
  });
});
