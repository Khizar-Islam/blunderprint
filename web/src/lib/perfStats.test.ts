import assert from "node:assert/strict";
import { test } from "node:test";
import { droppedShare, formatSegment, percentile, refreshInterval, segmentStats, type Segment } from "./perfStats";

test("percentile: nearest rank, null for no data", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 95), 5);
  assert.equal(percentile([10, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 100], 95), 100);
  assert.equal(percentile([1, 2, 3, 4], 0), 1);
});

test("refresh interval: the 25th-percentile gap, at least 4 ms", () => {
  const smooth60 = Array.from({ length: 100 }, () => 16.7);
  assert.equal(refreshInterval(smooth60), 16.7);
  // A janky stretch (a quarter of the frames late) doesn't move the estimate.
  assert.equal(refreshInterval([...smooth60, ...Array.from({ length: 30 }, () => 50)]), 16.7);
  assert.equal(refreshInterval([1, 1, 1]), 4);
  assert.equal(refreshInterval([]), null);
});

test("dropped share: a gap of k intervals misses k − 1 frames", () => {
  // 8 on-time frames + one gap of 3 intervals (2 missed): 2 / (9 + 2).
  const gaps = [...Array.from({ length: 8 }, () => 16.7), 50.1];
  assert.equal(droppedShare(gaps, 16.7), 2 / 11);
  assert.equal(droppedShare(Array.from({ length: 10 }, () => 16.7), 16.7), 0);
  assert.equal(droppedShare([], 16.7), null);
  assert.equal(droppedShare([16.7], null), null);
});

const segment = (over: Partial<Segment> = {}): Segment => ({
  label: "/",
  startedAt: 1000,
  endedAt: 3000,
  gaps: [16, 17, 16, 17, 40],
  longFrames: [
    { duration: 80, blocking: 30 },
    { duration: 120, blocking: 70 },
  ],
  heapNow: 20 * 1_048_576,
  heapPeak: 25 * 1_048_576,
  ...over,
});

test("segment stats: duration, gaps, long frames", () => {
  const s = segmentStats(segment(), 99_999);
  assert.equal(s.seconds, 2);
  assert.equal(s.frames, 5);
  assert.equal(s.p50, 17); // sorted 16, 16, 17, 17, 40: the 3rd of 5
  assert.equal(s.worst, 40);
  assert.equal(s.longFrames, 2);
  assert.equal(s.longWorst, 120);
  assert.equal(s.blockingTotal, 100);
  // A segment still running is timed to `now`.
  assert.equal(segmentStats(segment({ endedAt: null }), 4000).seconds, 3);
});

test("formatted text says what the browser doesn't expose instead of inventing numbers", () => {
  const text = formatSegment(segment(), 0, false, false);
  assert.match(text, /^\/ · 2\.0 s/);
  assert.match(text, /long animation frames: not supported/);
  assert.match(text, /JS heap: not exposed/);
  const full = formatSegment(segment(), 0, true, true);
  assert.match(full, /long animation frames 2 · worst 120\.0 ms · blocking 100\.0 ms total/);
  assert.match(full, /JS heap 20\.0 MB \(peak 25\.0 MB\)/);
  assert.equal(formatSegment(segment({ gaps: [] }), 0, true, true).includes("p50 —"), true);
});
