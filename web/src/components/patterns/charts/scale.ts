// A bar chart's axis: the smallest "nice" number (1, 2, 2.5 or 5 × a power of ten) at or above
// the largest value, so the bars fill the width without the axis ending on 3.7. 0 or less gives 1.
export function niceMax(value: number): number {
  if (!(value > 0)) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * power;
    // Rounding guards against float error (0.1 × 3 = 0.30000000000000004).
    if (Number(candidate.toPrecision(12)) >= value) return Number(candidate.toPrecision(12));
  }
  return 10 * power;
}

// Evenly spaced gridline values from 0 to max, inclusive.
export function ticks(max: number, count = 4): number[] {
  return Array.from({ length: count + 1 }, (_, i) => Number(((max * i) / count).toPrecision(12)));
}
