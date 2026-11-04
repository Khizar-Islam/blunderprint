import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createPacer } from "./pacer.js";

// A fake clock: sleeping moves time forward instantly (and respects an aborted signal).
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      t += ms;
    },
  };
}

describe("pacer", () => {
  it("RPM: calls start 60 000 / RPM ms apart (15 RPM = 4 s)", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 15, tpm: 1_000_000, ...c });
    const starts: number[] = [];
    for (let i = 0; i < 3; i++) {
      await pacer.acquire(100);
      starts.push(c.now());
    }
    assert.deepEqual(starts, [0, 4_000, 8_000]);
  });

  it("TPM: a call waits until the tokens of the last minute leave room for it", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 60_000, tpm: 10_000, ...c });
    await pacer.acquire(6_000);
    await pacer.acquire(6_000); // 12 000 > 10 000: waits for the first to leave the window
    assert.equal(c.now(), 60_000);
  });

  it("TPM: settling a call with its real (smaller) token count frees the room", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 60_000, tpm: 10_000, ...c });
    const first = await pacer.acquire(6_000);
    first.settle(1_000);
    await pacer.acquire(6_000);
    assert.ok(c.now() < 60_000);
  });

  it("an estimate bigger than the whole TPM still goes once the window is empty (no deadlock)", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 60_000, tpm: 1_000, ...c });
    await pacer.acquire(5_000);
    await pacer.acquire(5_000);
    assert.equal(c.now(), 60_000);
  });

  it("backoff after a 429 holds everyone", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 15, tpm: 1_000_000, ...c });
    await pacer.acquire(100);
    pacer.backoff(23_000);
    await pacer.acquire(100);
    assert.equal(c.now(), 23_000);
  });

  it("callers go in order; one that gives up while waiting doesn't block the rest", async () => {
    const c = clock();
    const pacer = createPacer({ rpm: 15, tpm: 1_000_000, ...c });
    const aborted = new AbortController();
    aborted.abort(new Error("run stopped"));
    const order: string[] = [];
    const a = pacer.acquire(100).then(() => order.push("a"));
    const b = pacer.acquire(100, aborted.signal).then(
      () => order.push("b"),
      () => order.push("b gave up"),
    );
    const d = pacer.acquire(100).then(() => order.push("c"));
    await Promise.all([a, b, d]);
    assert.deepEqual(order, ["a", "b gave up", "c"]);
  });
});
