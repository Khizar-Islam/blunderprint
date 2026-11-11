import { test } from "node:test";
import assert from "node:assert/strict";
import { createStorageGate } from "./storage.js";

const MB = 1024 * 1024;

test("dataSize + indexSize in MB (not storageSize), read at most once per cache window", async () => {
  let reads = 0;
  let t = 0;
  const gate = createStorageGate({
    limitMb: 120,
    cacheMs: 1_000,
    now: () => t,
    readStats: async () => {
      reads++;
      return { dataSize: 100 * MB, indexSize: 19.96 * MB };
    },
  });
  assert.deepEqual(await Promise.all([gate.usedMb(), gate.usedMb(), gate.full()]), [120, 120, true]);
  assert.equal(reads, 1, "simultaneous calls share one read");
  t = 999;
  await gate.usedMb();
  assert.equal(reads, 1);
  t = 1_000;
  await gate.usedMb();
  assert.equal(reads, 2);
});

test("under the limit is not full", async () => {
  const gate = createStorageGate({ limitMb: 120, readStats: async () => ({ dataSize: 8.3 * MB, indexSize: 1.3 * MB }) });
  assert.equal(await gate.usedMb(), 9.6);
  assert.equal(await gate.full(), false);
});

test("an unreadable size is null, does not block imports, and is not cached", async () => {
  let fail = true;
  let reads = 0;
  const gate = createStorageGate({
    limitMb: 1,
    readStats: async () => {
      reads++;
      if (fail) throw new Error("not connected");
      return { dataSize: 2 * MB, indexSize: 0 };
    },
  });
  assert.equal(await gate.usedMb(), null);
  assert.equal(await gate.full(), false);
  fail = false;
  assert.equal(await gate.full(), true);
  assert.equal(reads, 3);
});
