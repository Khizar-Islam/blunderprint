"use client";

import { useEffect, useRef, useState } from "react";
import { createMountQueue, nextFrame } from "./mountQueue";

// Shared by the whole page, so boards from every card take turns (lib/mountQueue.ts).
const queue = createMountQueue(nextFrame);

// `mounted` turns true once the element comes within `margin` of the viewport (an
// IntersectionObserver: no frames needed) AND its turn in the page's mount queue has come.
// Until then, render a placeholder of the same size, so nothing below moves when it mounts.
export function useMountWhenNear<T extends Element>(margin = "400px") {
  const ref = useRef<T>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let cancel: (() => void) | null = null;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        io.disconnect();
        cancel = queue.enqueue(() => setMounted(true));
      },
      { rootMargin: `${margin} 0px` },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancel?.();
    };
  }, [margin]);

  return { ref, mounted };
}
