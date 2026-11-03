"use client";

import { animate, useReducedMotion } from "motion/react";
import { useEffect, useRef } from "react";

// A number that counts from its previous value to the new one when it changes (filters, a
// refetch). It writes straight to the DOM node on each frame instead of re-rendering React
// 60 times a second. With reduced motion it just changes.
export function AnimatedNumber({ value, format }: { value: number | null; format: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef<number | null>(null);
  const reduced = useReducedMotion();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const from = shown.current;
    shown.current = value;
    if (value === null) {
      node.textContent = "—";
      return;
    }
    if (from === null || reduced) {
      node.textContent = format(value);
      return;
    }
    const controls = animate(from, value, {
      duration: 0.6,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (n) => {
        node.textContent = format(n);
      },
    });
    return () => controls.stop();
  }, [value, format, reduced]);

  return <span ref={ref}>{value === null ? "—" : format(value)}</span>;
}
