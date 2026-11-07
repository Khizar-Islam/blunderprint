"use client";

import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { staggerWait } from "./stagger";

// "Reveal when scrolled into view", for the coach page's cards, stats, lens and boards.
// - `shown` turns true once at least `amount` of the element is in view (an IntersectionObserver,
//   which doesn't depend on animation frames) and stays true.
// - `stagger`: reveals that happen together (the first screen's cards) start 120 ms apart, in
//   the order they came into view; one revealed on its own (scrolled to later) starts at once
//   (lib/stagger.ts).
//   `delayMs` is that wait, for the CSS animation's delay.
// - With reduced motion it's true at once, with no delay: everything shows in its final state.
// Pair it with the CSS utilities: `reveal-wait` while hidden, `anim-rise` (or a transition) once
// shown, so the final state is always the element's normal style.

// When the next staggered reveal may start (performance.now() time), shared by the whole page.
const queue = { next: 0 };

export function useReveal<T extends Element>(amount = 0.15, stagger = false) {
  const ref = useRef<T>(null);
  const reduced = !!useReducedMotion();
  const [delayMs, setDelayMs] = useState<number | null>(null); // null: not revealed yet

  useEffect(() => {
    const el = ref.current;
    if (!el || reduced) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        if (!stagger) return setDelayMs(0);
        const s = staggerWait(queue.next, performance.now());
        queue.next = s.next;
        setDelayMs(s.wait);
      },
      { threshold: amount },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [amount, stagger, reduced]);

  return { ref, shown: reduced || delayMs !== null, delayMs: reduced ? 0 : (delayMs ?? 0), reduced };
}
