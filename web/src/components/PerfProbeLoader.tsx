"use client";

import { useEffect } from "react";

// Starts the performance probe (lib/perfProbe.ts) only when the page was opened with ?perf=1.
// The probe is imported on demand, so without ?perf=1 its code isn't even downloaded: this
// component renders nothing and does one URL check after the first render.
export function PerfProbeLoader() {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("perf") !== "1") return;
    void import("@/lib/perfProbe").then((m) => m.startPerfProbe());
  }, []);
  return null;
}
