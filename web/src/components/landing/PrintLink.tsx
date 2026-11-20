"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import type { Platform } from "@/lib/api";
import { carryKey, parsePrintBox, startCarry } from "@/lib/printCarry";
import { prefetchSummary } from "@/lib/summaryPrefetch";

// The landing's link to the demo dashboard. Two things a plain link doesn't do:
// - pointing at it (or focusing, or touching it) starts the dashboard's summary request, so the
//   dashboard's print can draw as soon as the page is there (lib/summaryPrefetch.ts; the
//   dashboard takes the same answer instead of asking again);
// - a plain click, while the landing's print is whole on screen, carries a copy of that print
//   across the navigation onto the dashboard's (lib/printCarry.ts). The dive's canvas says so
//   with `data-print` (Dive.tsx). A click that opens a new tab or window is left alone.
export function PrintLink({ platform, username, className, children }: { platform: Platform; username: string; className?: string; children: ReactNode }) {
  const warm = () => prefetchSummary(platform, username, "");
  const carry = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    warm();
    const cv = document.querySelector<HTMLCanvasElement>("canvas[data-print]");
    const crop = parsePrintBox(cv?.dataset.print);
    if (cv && crop) startCarry(carryKey(platform, username), cv, crop);
  };
  return (
    <Link href={`/p/${platform}/${encodeURIComponent(username)}`} className={className} onPointerEnter={warm} onFocus={warm} onTouchStart={warm} onClick={carry}>
      {children}
    </Link>
  );
}
