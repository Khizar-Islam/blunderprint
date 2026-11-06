"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";
import { countTo, type Animator } from "./countTo";

const EASE = [0.22, 1, 0.36, 1] as const;
const animator: Animator = (from, to, { duration, onUpdate }) => animate(from, to, { duration, ease: EASE, onUpdate });

// A number that counts from its previous value to the new one when it changes (filters, a
// refetch). It writes straight to the DOM node on each frame instead of re-rendering React
// 60 times a second. With reduced motion it just changes.
// - `hold`: show 0 until it turns false (e.g. the stat scrolled into view), then count up.
// - The counting text is aria-hidden; a visually hidden copy always carries the final value,
//   so a screen reader never reads "0.0" or a number halfway through the count.
// - countTo() lands on the final value by a timer too, so a browser that throttles animation
//   frames still shows the real number.
export function AnimatedNumber({
  value,
  format,
  hold = false,
}: {
  value: number | null;
  format: (n: number) => string;
  hold?: boolean;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const reduced = useReducedMotion();
  const target = value === null ? null : hold ? 0 : value;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = shown.current;
    shown.current = target;
    if (target === null) {
      node.textContent = "—";
      return;
    }
    if (from === null || reduced) {
      node.textContent = format(target);
      return;
    }
    return countTo(
      {
        from,
        to: target,
        durationS: 0.6,
        write: (n) => {
          node.textContent = format(n);
        },
      },
      animator,
    );
  }, [target, format, reduced]);

  return (
    <>
      <span ref={ref} aria-hidden="true">
        {target === null ? "—" : format(target)}
      </span>
      <span className="sr-only">{value === null ? "—" : format(value)}</span>
    </>
  );
}
