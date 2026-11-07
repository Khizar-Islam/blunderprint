// The ?perf=1 probe: how smooth the page really is on this machine, in the visitor's own Chrome
// (dev tools closed). Loaded only when the URL has ?perf=1 (components/PerfProbeLoader.tsx imports
// this file on demand), so without it none of this code is even downloaded.
//
// What it measures, from the moment it starts (or Restart):
// - Frame gaps: the time between consecutive animation frames (requestAnimationFrame). 60 Hz is
//   ~16.7 ms; p50 / p95 / worst, and the share of frames the display could have shown but didn't.
// - Long animation frames (PerformanceObserver "long-animation-frame", Chrome 123+): frames that
//   took over 50 ms of work, with how much of that blocked input.
// - JS heap (performance.memory, Chrome only): now and the peak.
// - Page load, once: LCP and CLS, from the browser's own entries.
// A new page (client-side navigation) starts a new segment, so one copy covers a whole scenario.
// Measuring pauses while the tab is hidden (a background tab gets no frames; those gaps would
// be noise). It shows a small box in the bottom-right corner, updated twice a second, with
// "Copy results" (plain text, to paste in a chat) and "Restart".

import { formatSegment, type Segment } from "./perfStats";

declare global {
  interface Performance {
    memory?: { usedJSHeapSize: number };
  }
}

interface LoafEntry extends PerformanceEntry {
  blockingDuration?: number;
}

let started = false;

export function startPerfProbe() {
  if (started || typeof window === "undefined") return;
  started = true;

  const longFramesSupported = PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") ?? false;
  const heapSupported = typeof performance.memory?.usedJSHeapSize === "number";
  const segments: Segment[] = [];
  let restarts = 0;
  let lcp: number | null = null;
  let cls = 0;

  const page = () => window.location.pathname;
  const firstPage = `${window.location.pathname}${window.location.search}`; // the load numbers are this page's
  const newSegment = (label: string) => {
    const now = performance.now();
    const last = segments.at(-1);
    if (last && last.endedAt === null) last.endedAt = now;
    segments.push({ label, startedAt: now, endedAt: null, gaps: [], longFrames: [], heapNow: null, heapPeak: null });
  };
  newSegment(page());

  // ---- Frames ----
  let lastFrame: number | null = null;
  let lastPage = page();
  const tick = (t: number) => {
    if (page() !== lastPage) {
      lastPage = page();
      newSegment(lastPage);
      lastFrame = null;
    }
    if (lastFrame !== null && !document.hidden) segments.at(-1)!.gaps.push(t - lastFrame);
    lastFrame = document.hidden ? null : t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  document.addEventListener("visibilitychange", () => (lastFrame = null));

  // ---- Long animation frames, LCP, CLS ----
  if (longFramesSupported) {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as LoafEntry[]) segments.at(-1)!.longFrames.push({ duration: e.duration, blocking: e.blockingDuration ?? 0 });
    }).observe({ type: "long-animation-frame", buffered: false });
  }
  try {
    new PerformanceObserver((list) => {
      const entries = list.getEntries();
      lcp = entries.at(-1)?.startTime ?? lcp;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  } catch {
    // A browser without these entry types: the line says so.
  }

  // ---- Heap ----
  const sampleHeap = () => {
    if (!heapSupported) return;
    const s = segments.at(-1)!;
    s.heapNow = performance.memory!.usedJSHeapSize;
    s.heapPeak = Math.max(s.heapPeak ?? 0, s.heapNow);
  };

  // ---- Text ----
  const header = () => {
    const ua = navigator.userAgent.match(/Chrome\/(\d+)/)?.[1];
    return [
      `Blunderprint perf probe · ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
      `${ua ? `Chrome ${ua}` : navigator.userAgent} · window ${innerWidth}×${innerHeight} · DPR ${devicePixelRatio} · ${navigator.hardwareConcurrency ?? "?"} cores`,
      `${location.host} · opened ${firstPage}`,
      `load of ${firstPage}: LCP ${lcp === null ? "—" : `${Math.round(lcp)} ms`} · CLS since then ${cls.toFixed(3)}`,
    ].join("\n");
  };
  const results = () => {
    const now = performance.now();
    return [header(), ...segments.map((s) => formatSegment(s, now, longFramesSupported, heapSupported))].join("\n\n");
  };

  // ---- The box ----
  const style = document.createElement("style");
  style.textContent = `
    .bp-perf { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; width: min(360px, calc(100vw - 24px));
      background: #1b1d1a; color: #e9e4d8; font: 11px/1.45 var(--font-mono, ui-monospace, monospace); border-radius: 4px; padding: 8px 10px; }
    .bp-perf pre { margin: 0 0 6px; white-space: pre-wrap; max-height: 40vh; overflow: auto; }
    .bp-perf button { font: inherit; color: #e9e4d8; background: transparent; border: 1px solid rgba(233,228,216,.35); border-radius: 3px;
      padding: 2px 8px; margin-right: 6px; cursor: pointer; transition: background-color 150ms, color 150ms, transform 100ms; }
    .bp-perf button:hover { background: #e9e4d8; color: #1b1d1a; }
    .bp-perf button:active { transform: scale(0.95); }
    .bp-perf button:focus-visible { outline: 2px solid #e9e4d8; outline-offset: 2px; }
    .bp-perf .bp-perf-small pre { display: none; }`;
  document.head.appendChild(style);

  const box = document.createElement("div");
  box.className = "bp-perf";
  box.setAttribute("role", "region");
  box.setAttribute("aria-label", "Performance probe");
  const pre = document.createElement("pre");
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy results";
  const restart = document.createElement("button");
  restart.type = "button";
  restart.textContent = "Restart";
  const hide = document.createElement("button");
  hide.type = "button";
  hide.textContent = "Hide";
  box.append(pre, copy, restart, hide);
  document.body.appendChild(box);

  copy.addEventListener("click", async () => {
    const text = results();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // No clipboard permission: select the text so Ctrl+C works.
      const area = document.createElement("textarea");
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand("copy");
      area.remove();
    }
    copy.textContent = "Copied ✓";
    setTimeout(() => (copy.textContent = "Copy results"), 1500);
  });
  restart.addEventListener("click", () => {
    restarts++;
    newSegment(`${page()} · restart ${restarts}`);
    lastFrame = null;
  });
  hide.addEventListener("click", () => {
    const small = box.classList.toggle("bp-perf-small");
    hide.textContent = small ? "Show" : "Hide";
  });

  const render = () => {
    sampleHeap();
    pre.textContent = results();
  };
  render();
  setInterval(render, 500);
}
