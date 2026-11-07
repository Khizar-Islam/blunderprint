"use client";

import { useLayoutEffect, useRef } from "react";

// A sliding indicator for a group of options (the platform toggle, the filter chips, the
// current move in the move list): ONE ink pill that glides to the chosen option instead of the
// highlight jumping from one option to the next.
//
// - It returns two refs: `container` (the group) and `pill`. The options are the container's
//   elements marked `data-segment`, in order; `selected` is an index into them (null: none, the
//   pill hides).
// - It writes the pill's size and position straight to the DOM (no React state, no re-render),
//   measured from offsetLeft/offsetTop, so the container must be the options' offsetParent
//   (position: relative). A ResizeObserver re-measures when the fonts load or the layout changes.
// - The glide is a CSS transition (the seg-indicator utility), so it needs no animation frames.
//   The first placement skips the transition: the pill appears in place, it doesn't fly in.
// - Until the pill is placed (server HTML, before hydration) the options draw their own
//   highlight. The container gets data-indicator="on" once the pill is there, and the options
//   switch theirs off with the group-data-[indicator=on]: variant (the container has `group`).
export function useIndicator<C extends HTMLElement, P extends HTMLElement>(selected: number | null) {
  const container = useRef<C>(null);
  const pill = useRef<P>(null);
  const placed = useRef(false);

  useLayoutEffect(() => {
    const box = container.current;
    const el = pill.current;
    if (!box || !el) return;
    const items = () => box.querySelectorAll<HTMLElement>("[data-segment]");

    const place = () => {
      const item = selected === null ? undefined : items()[selected];
      if (!item) {
        el.style.opacity = "0";
        box.dataset.indicator = "off";
        placed.current = false;
        return;
      }
      const first = !placed.current;
      if (first) el.style.transition = "none";
      el.style.width = `${item.offsetWidth}px`;
      el.style.height = `${item.offsetHeight}px`;
      el.style.transform = `translate(${item.offsetLeft}px, ${item.offsetTop}px)`;
      el.style.opacity = "1";
      box.dataset.indicator = "on";
      if (first) {
        void el.offsetWidth; // apply the jump before the transition comes back
        el.style.transition = "";
        placed.current = true;
      }
    };

    place();
    const ro = new ResizeObserver(place);
    ro.observe(box);
    items().forEach((item) => ro.observe(item));
    return () => ro.disconnect();
  }, [selected]);

  return { container, pill };
}
