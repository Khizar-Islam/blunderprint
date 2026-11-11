"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, fetchCoachInfo, fetchFinishedRun, startReport, type CoachInfo, type CoachReport, type Platform, type PublicRun } from "@/lib/api";
import { failureAction, hoursText, msUntilPacificMidnight } from "@/lib/coach";
import { fullDate } from "@/lib/format";
import { isFinished } from "@/lib/runStream";
import { useRunStream } from "@/lib/useRunStream";
import { useWakingRequest } from "@/lib/useWakingRequest";
import { AgentTrace, traceSummary } from "./AgentTrace";
import { PatternCard } from "./PatternCard";

// The coach page. One GET (the latest report, eligibility, an active run, the AI state), shown
// at once; a running report is followed live over SSE. The page never starts a run on its own:
// only a click on Refresh or Try again does (the first report starts from the dashboard).

export function CoachPage({ platform, username }: { platform: Platform; username: string }) {
  const request = useWakingRequest((signal) => fetchCoachInfo(platform, username, signal));
  const info = request.state.kind === "done" ? request.state.value : null;
  const dashboard = `/p/${platform}/${encodeURIComponent(username)}`;

  // A run started here (Refresh / Try again) or the one the API says is going.
  const [startedRun, setStartedRun] = useState<string | null>(null);
  const [cachedReport, setCachedReport] = useState<CoachReport | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [starting, setStarting] = useState(false);
  const [traceOpen, setTraceOpen] = useState(false);

  const runId = startedRun ?? info?.activeRun?.runId ?? null;
  const stream = useRunStream(runId);
  const run = stream.run;
  const live = runId !== null && !isFinished(run);
  const failedRun = run?.status === "failed" ? run : null;
  // The newest report we know of: the run that just finished, a cached answer to Refresh, or
  // the one the page loaded with.
  const report = (run?.status === "done" ? run.report : null) ?? cachedReport ?? info?.report ?? null;
  const fresh = (run?.status === "done" && !!run.report) || cachedReport !== null;

  async function start() {
    setStarting(true);
    setStartError(null);
    try {
      const result = await startReport(platform, username);
      if (result.kind === "run") setStartedRun(result.runId);
      else setCachedReport(result.report);
    } catch (err) {
      setStartError(err instanceof ApiError ? err : new ApiError(0, "Something went wrong on our side."));
    } finally {
      setStarting(false);
    }
  }

  if (request.state.kind === "loading") {
    return (
      <p className="font-mono text-sm text-graphite/70" role="status" aria-live="polite">
        {request.waking ? `Waking the server up… (${Math.floor(request.elapsedMs / 1_000)}s)` : "Loading the coach…"}
      </p>
    );
  }
  if (request.state.kind === "error") {
    const { error } = request.state;
    if (error.code === "player_not_found") {
      return (
        <Notice title="No games yet" link={{ href: dashboard, label: "Import this player" }}>
          {error.message}
        </Notice>
      );
    }
    return (
      <Notice title="Couldn't load the coach" action={{ label: "Retry", onClick: request.retry }}>
        {error.message}
      </Notice>
    );
  }
  const loaded = info as CoachInfo;

  return (
    <div className="flex flex-col gap-10">
      {report && <ReportMeta report={report} />}

      {report && !fresh && loaded.stale && !live && (
        <StaleBand info={loaded} starting={starting} onRefresh={start} />
      )}

      {/* Live, or folded into one line once finished (a failed run keeps its trace too, so the
          retries that led to the failure stay visible). */}
      {runId && (live || isFinished(run)) && (
        <RunPanel run={run} steps={stream.steps} connection={stream.connection} live={live} patterns={run?.report?.patterns.length ?? null} />
      )}

      {failedRun && <Failure error={failedRun.error} onRetry={start} starting={starting} dashboard={dashboard} />}
      {startError && <Failure error={{ code: startError.code ?? "internal", message: startError.message }} onRetry={start} starting={starting} dashboard={dashboard} />}

      {report ? (
        <div className={`flex flex-col gap-16 transition-opacity ${live ? "opacity-50" : ""}`}>
          {live && <p className="font-mono text-xs text-graphite/70">The report below is the previous one; the new one replaces it when the coach finishes.</p>}
          {report.patterns.length === 0 ? (
            <Notice title="Nothing stood out">{report.noPatternsMessage ?? "No weakness clearly stood out from your own average yet."}</Notice>
          ) : (
            report.patterns.map((p, i) => (
              <PatternCard key={`${report.id}:${p.candidateId}`} pattern={p} index={i} total={report.patterns.length} platform={platform} username={username} />
            ))
          )}
          {report.runId && report.runId !== runId && (
            <HowMade runId={report.runId} open={traceOpen} onToggle={() => setTraceOpen((o) => !o)} />
          )}
        </div>
      ) : (
        !runId && !startError && <NoReport info={loaded} dashboard={dashboard} />
      )}
    </div>
  );
}

function ReportMeta({ report }: { report: CoachReport }) {
  const switched = report.answeredBy && report.answeredBy !== report.model;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-sm text-graphite">
        Based on {report.analysedGames} analysed games · {fullDate(report.generatedAt)}
      </p>
      {switched && (
        <p className="text-xs text-graphite/70">
          Written by <span className="font-mono">{report.answeredBy}</span>: the main model ({report.model}) was overloaded during this run.
        </p>
      )}
      <p className="max-w-prose text-xs leading-relaxed text-graphite/70">
        Every number below was computed from your games by code; the coach chose the patterns and wrote the words, and a verifier
        checked each claim against the data.
      </p>
    </div>
  );
}

function StaleBand({ info, starting, onRefresh }: { info: CoachInfo; starting: boolean; onRefresh: () => void }) {
  const what =
    info.staleReason === "new_version"
      ? "An updated coach is available since this report."
      : info.newGames > 0
        ? `${info.newGames} new analysed game${info.newGames === 1 ? "" : "s"} since this report.`
        : "Your analysed games have changed since this report.";
  const blocked = !info.ai.enabled
    ? "The coach is switched off right now."
    : !info.ai.canStart
      ? `The coach is resting until midnight Pacific (${hoursText(msUntilPacificMidnight(new Date()))}).`
      : null;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-ink/15 py-3" role="status">
      <p className="text-sm text-ink">{what}</p>
      {blocked ? (
        <p className="text-sm text-graphite/70">{blocked}</p>
      ) : (
        <button type="button" className="btn-quiet text-sm" onClick={onRefresh} disabled={starting}>
          {starting ? "Starting…" : "Refresh the report"}
        </button>
      )}
    </div>
  );
}

function RunPanel({
  run,
  steps,
  connection,
  live,
  patterns,
}: {
  run: PublicRun | null;
  steps: PublicRun["steps"];
  connection: Parameters<typeof AgentTrace>[0]["connection"];
  live: boolean;
  patterns: number | null;
}) {
  const [open, setOpen] = useState(false);
  if (live || !run) return <AgentTrace steps={steps} run={run} connection={connection} live />;
  // Finished (or failed) in this visit: the trace folds into one line, which opens on a click.
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="self-start rounded font-mono text-xs text-graphite/80 transition-colors hover:text-ink active:opacity-70"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} {traceSummary(run, patterns)}
      </button>
      {open && <AgentTrace steps={steps} run={run} connection="closed" live={false} />}
    </div>
  );
}

// "How this report was made": the finished run's trace, fetched once when opened.
function HowMade({ runId, open, onToggle }: { runId: string; open: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col gap-2 border-t border-ink/15 pt-4">
      <button
        type="button"
        className="self-start rounded font-mono text-xs text-graphite/80 transition-colors hover:text-ink active:opacity-70"
        onClick={onToggle}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} How this report was made
      </button>
      {open && <FinishedTrace runId={runId} />}
    </div>
  );
}

function FinishedTrace({ runId }: { runId: string }) {
  const request = useWakingRequest((signal) => fetchFinishedRun(runId, signal));
  if (request.state.kind === "loading") return <p className="font-mono text-xs text-graphite/60">Loading the trace…</p>;
  if (request.state.kind === "error") return <p className="font-mono text-xs text-graphite/60">Couldn&apos;t load the trace.</p>;
  const run = request.state.value;
  if (!run) return <p className="font-mono text-xs text-graphite/60">This trace has expired (traces are kept for 14 days).</p>;
  return (
    <>
      <p className="font-mono text-xs text-graphite/70">{traceSummary(run, run.report?.patterns.length ?? null)}</p>
      <AgentTrace steps={run.steps} run={run} connection="closed" live={false} />
    </>
  );
}

function NoReport({ info, dashboard }: { info: CoachInfo; dashboard: string }) {
  if (!info.eligibility.ok) {
    return (
      <Notice title="Not enough analysed games yet" link={{ href: dashboard, label: "Back to the dashboard" }}>
        The coach needs at least {info.eligibility.needed} analysed games; {info.eligibility.analysed} are ready. Keep the dashboard open
        while the engine analyses more.
      </Notice>
    );
  }
  return (
    <Notice title="No report yet" link={{ href: dashboard, label: "Go to the dashboard" }}>
      Start one with &ldquo;Coach me&rdquo; on the dashboard. It takes about a minute, and you can watch the coach work.
    </Notice>
  );
}

function Failure({
  error,
  onRetry,
  starting,
  dashboard,
}: {
  error: { code: string; message: string } | undefined;
  onRetry: () => void;
  starting: boolean;
  dashboard: string;
}) {
  const action = failureAction(error?.code);
  const message = error?.message ?? "Something went wrong on our side.";
  if (action === "retry") {
    return (
      <Notice title="The coach couldn't finish" action={{ label: starting ? "Starting…" : "Try again", onClick: onRetry, disabled: starting }}>
        {message}
      </Notice>
    );
  }
  if (action === "dashboard") return <Notice title="Not enough analysed games yet" link={{ href: dashboard, label: "Back to the dashboard" }}>{message}</Notice>;
  if (action === "import") return <Notice title="No games yet" link={{ href: dashboard, label: "Import this player" }}>{message}</Notice>;
  if (action === "reload") return <Notice title="That run is gone" action={{ label: "Reload", onClick: () => window.location.reload() }}>{message}</Notice>;
  if (action === "wait") {
    return <Notice title={error?.code === "limit_reports" ? "You've reached today's reports" : "The coach is resting"}>{message}</Notice>;
  }
  return <Notice title="The coach is switched off">{message}</Notice>;
}

function Notice({
  title,
  children,
  action,
  link,
}: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void; disabled?: boolean };
  link?: { href: string; label: string };
}) {
  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-ink/30 py-1 pl-4" role="status">
      <p className="font-display text-xl text-ink">{title}</p>
      <p className="max-w-prose text-sm text-graphite">{children}</p>
      {action && (
        <button type="button" className="btn-quiet mt-1 text-sm" onClick={action.onClick} disabled={action.disabled}>
          {action.label}
        </button>
      )}
      {link && (
        <Link href={link.href} className="btn-quiet mt-1 text-sm">
          {link.label}
        </Link>
      )}
    </div>
  );
}
