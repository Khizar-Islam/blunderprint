"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, startReport, type CoachInfo, type Platform } from "@/lib/api";
import { coachButtonState, hoursText, msUntilPacificMidnight } from "@/lib/coach";
import { AnimatedNumber } from "../patterns/charts/AnimatedNumber";

// The dashboard's door to the coach. Its state comes from GET /report (lib/coach.ts
// coachButtonState): locked until 20 games are analysed (the count ticks up as the engine
// works), "Coach me" to start the first report (the only place a first run starts), "See your
// coach report" once one exists (with what changed since), and honest notes when the AI is
// off or today's budget is used up.

const whole = (n: number) => String(Math.round(n));

export function CoachButton({ info, platform, username }: { info: CoachInfo | null; platform: Platform; username: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const href = `/p/${platform}/${encodeURIComponent(username)}/coach`;
  const state = coachButtonState(info);
  // While GET /report loads: the section's frame at its usual height, so nothing below jumps.
  if (state.kind === "loading") return <section aria-hidden="true" className={FRAME} />;

  async function start() {
    setStarting(true);
    setError(null);
    try {
      await startReport(platform, username);
      // A new run or a cached report: either way the coach page shows it (it reattaches to the
      // running report through GET /report's activeRun).
      router.push(href);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong on our side.");
      setStarting(false);
    }
  }

  const resting = `The coach is resting until midnight Pacific (${hoursText(msUntilPacificMidnight(new Date()))}).`;

  // Keyed by the state: when it changes (locked → "Coach me" → working → report), the new
  // content fades in where the old one was (a CSS animation; the frame itself stays put).
  return (
    <section aria-label="Coach" className={FRAME}>
      <div key={state.kind} className="anim-fade flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <p className="font-mono text-xs tracking-wide text-graphite/60 uppercase">Coach</p>
          {state.kind === "locked" && (
            <>
              <p className="font-display text-xl text-ink">The coach unlocks at {state.needed} analysed games</p>
              <Progress analysed={state.analysed} needed={state.needed} />
            </>
          )}
          {state.kind === "start" && <p className="font-display text-xl text-ink">Your recurring weaknesses, with evidence from your games</p>}
          {state.kind === "running" && <p className="font-display text-xl text-ink">The coach is working on your report</p>}
          {state.kind === "report" && (
            <>
              <p className="font-display text-xl text-ink">Your coach report is ready</p>
              {state.stale && (
                <p className="text-sm text-graphite">
                  {state.stale.reason === "new_version"
                    ? "An updated coach is available."
                    : state.stale.newGames > 0
                      ? `${state.stale.newGames} new game${state.stale.newGames === 1 ? "" : "s"} analysed since your last report.`
                      : "Your analysed games changed since your last report."}
                  {state.note === "off" && " A new report can't start while the coach is switched off."}
                  {state.note === "resting" && ` ${resting}`}
                </p>
              )}
            </>
          )}
          {state.kind === "off" && <p className="text-sm text-graphite">The coach is switched off right now. Your dashboard and game reviews still work.</p>}
          {state.kind === "resting" && <p className="text-sm text-graphite">{resting}</p>}
          {error && (
            <p className="text-sm text-blunder" role="alert">
              {error}
            </p>
          )}
        </div>

        {state.kind === "start" && (
          <button type="button" className="btn-solid" onClick={() => void start()} disabled={starting}>
            {starting ? "Starting…" : "Coach me"}
          </button>
        )}
        {state.kind === "running" && (
          <Link href={href} className="btn-solid">
            Watch it live →
          </Link>
        )}
        {state.kind === "report" && (
          <Link href={href} className="btn-solid">
            See your coach report →
          </Link>
        )}
      </div>
    </section>
  );
}

// The section's frame. Its minimum height is about the tallest usual state (locked, with the
// progress rule), so a state change or the first load doesn't move the page below it.
const FRAME = "flex min-h-[9rem] flex-col justify-center border-y border-ink/15 py-4 sm:min-h-[7.25rem]";

// "12 / 20" ticking up live, over a rule of 20 segments, one per game needed.
function Progress({ analysed, needed }: { analysed: number; needed: number }) {
  return (
    <div className="flex flex-col gap-1.5" role="progressbar" aria-valuemin={0} aria-valuemax={needed} aria-valuenow={Math.min(analysed, needed)} aria-label="Analysed games">
      <p className="font-mono text-sm text-graphite tabular-nums">
        <span className="text-ink">
          <AnimatedNumber value={analysed} format={whole} />
        </span>{" "}
        / {needed} analysed · keep this page open while the engine works
      </p>
      <div className="flex max-w-xs gap-0.5" aria-hidden="true">
        {Array.from({ length: needed }, (_, i) => (
          <span key={i} className={`h-1.5 flex-1 transition-colors duration-300 ${i < analysed ? "bg-ink" : "bg-square-light"}`} />
        ))}
      </div>
    </div>
  );
}
