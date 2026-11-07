// The numbers behind the ?perf=1 probe (lib/perfProbe.ts), kept free of the DOM so they can be
// tested (perfStats.test.ts).

export interface LongFrame {
  duration: number; // ms, the whole animation frame
  blocking: number; // ms of it that blocked input (blockingDuration)
}

export interface Segment {
  label: string; // "/p/lichess/DrNykterstein" or "… · restart 2"
  startedAt: number; // performance.now()
  endedAt: number | null;
  gaps: number[]; // ms between consecutive animation frames
  longFrames: LongFrame[];
  heapNow: number | null; // bytes
  heapPeak: number | null;
}

export interface SegmentStats {
  seconds: number;
  frames: number;
  p50: number | null;
  p95: number | null;
  worst: number | null;
  refreshMs: number | null; // the display's frame interval, estimated from the gaps
  droppedShare: number | null; // 0–1: frames the display could have shown but we missed
  longFrames: number;
  longWorst: number | null;
  blockingTotal: number;
}

// The p-th percentile (0–100) by nearest rank; null for no data.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

// The display's frame interval: the 25th-percentile gap (most frames arrive on time, so it's
// robust to a janky stretch), never under 4 ms (a 240 Hz screen).
export function refreshInterval(gaps: number[]): number | null {
  const p25 = percentile(gaps, 25);
  return p25 === null ? null : Math.max(4, p25);
}

// Each gap of k intervals means k − 1 frames that weren't drawn. The share is missed frames over
// all the frames the display could have shown.
export function droppedShare(gaps: number[], interval: number | null): number | null {
  if (interval === null || gaps.length === 0) return null;
  let missed = 0;
  for (const g of gaps) missed += Math.max(0, Math.round(g / interval) - 1);
  return missed / (gaps.length + missed);
}

export function segmentStats(s: Segment, now: number): SegmentStats {
  const interval = refreshInterval(s.gaps);
  const longest = s.longFrames.reduce((m, f) => Math.max(m, f.duration), 0);
  return {
    seconds: ((s.endedAt ?? now) - s.startedAt) / 1000,
    frames: s.gaps.length,
    p50: percentile(s.gaps, 50),
    p95: percentile(s.gaps, 95),
    worst: s.gaps.length ? Math.max(...s.gaps) : null,
    refreshMs: interval,
    droppedShare: droppedShare(s.gaps, interval),
    longFrames: s.longFrames.length,
    longWorst: s.longFrames.length ? longest : null,
    blockingTotal: s.longFrames.reduce((t, f) => t + f.blocking, 0),
  };
}

const ms = (n: number | null) => (n === null ? "—" : `${n.toFixed(1)} ms`);
const mb = (n: number | null) => (n === null ? "—" : `${(n / 1_048_576).toFixed(1)} MB`);

// One segment as plain text, for "Copy results" (and the live box).
export function formatSegment(s: Segment, now: number, longFramesSupported: boolean, heapSupported: boolean): string {
  const st = segmentStats(s, now);
  const lines = [
    `${s.label} · ${st.seconds.toFixed(1)} s`,
    `  frames ${st.frames} · gap p50 ${ms(st.p50)} · p95 ${ms(st.p95)} · worst ${ms(st.worst)}`,
    `  refresh ~${st.refreshMs ? Math.round(1000 / st.refreshMs) : "—"} Hz · dropped ${st.droppedShare === null ? "—" : `${(st.droppedShare * 100).toFixed(1)}%`}`,
    longFramesSupported
      ? `  long animation frames ${st.longFrames}${st.longFrames ? ` · worst ${ms(st.longWorst)} · blocking ${ms(st.blockingTotal)} total` : ""}`
      : "  long animation frames: not supported by this browser",
    heapSupported ? `  JS heap ${mb(s.heapNow)} (peak ${mb(s.heapPeak)})` : "  JS heap: not exposed by this browser",
  ];
  return lines.join("\n");
}
