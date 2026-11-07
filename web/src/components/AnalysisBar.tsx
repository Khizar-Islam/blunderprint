"use client";

import type { AnalysisView } from "@/engine/useAnalysis";

// One line above the games list: what the in-browser engine is doing, and the control for it.
// The numbers are this visitor's: "N analysed" counts the stored total plus this session's.
// Under it, a thin rule of how much is analysed: its length is scaleX in its style (bar-x), so
// it glides with each stored game and lands right even without animation frames.
export function AnalysisBar({
  analysis,
  analysedCount,
  gamesCount,
}: {
  analysis: AnalysisView;
  analysedCount: number;
  gamesCount: number;
}) {
  const { state, paused, needsTap, error, secondsPerGame } = analysis;
  const analysed = Math.min(gamesCount, analysedCount + analysis.doneThisSession);
  const fraction = gamesCount > 0 ? analysed / gamesCount : 0;
  const counts = (
    <span className="tabular-nums">
      {analysed} of {gamesCount} analysed
    </span>
  );

  let text: React.ReactNode;
  let button: { label: string; onClick: () => void } | null = null;

  if (needsTap) {
    text = <>{counts} · the engine runs on your device and uses its battery</>;
    button = { label: "Analyse on this device", onClick: analysis.resume };
  } else if (paused) {
    text = <>{counts} · paused</>;
    button = { label: "Resume", onClick: analysis.resume };
  } else if (state === "waiting") {
    text = <>{counts} · another Blunderprint tab is analysing; this one takes over when it&apos;s closed</>;
    button = { label: "Pause", onClick: analysis.pause };
  } else if (state === "running") {
    text = (
      <>
        {counts} · analysing in your browser
        {/* Effective rate (both engines together), so it matches how fast the list fills. */}
        {secondsPerGame != null && <> · ~{secondsPerGame.toFixed(0)} s per game</>}
      </>
    );
    button = { label: "Pause", onClick: analysis.pause };
  } else if (state === "idle") {
    text = <>{counts}</>;
  } else {
    // stopped without a pause: the session ended on an error
    text = <>{counts} · analysis stopped</>;
    button = { label: "Retry", onClick: analysis.resume };
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="flex min-h-7 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-graphite" role="status" aria-live="polite">
        <span>{text}</span>
        {button && (
          <button type="button" className="btn-quiet text-xs" onClick={button.onClick}>
            {button.label}
          </button>
        )}
      </p>
      <div className="h-px w-full max-w-md bg-ink/15" aria-hidden="true">
        <div className="bar-x h-px w-full bg-ink" style={{ transform: `scaleX(${fraction})` }} />
      </div>
      {error && <p className="text-sm text-blunder">{error}</p>}
    </div>
  );
}
