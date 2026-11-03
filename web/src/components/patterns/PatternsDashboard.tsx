"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import type { Platform, Rate, Summary } from "@/lib/api";
import { apiQuery, filtersToQuery, parseFilters, type DashboardFilters } from "@/lib/filters";
import { count } from "@/lib/format";
import { useSummary } from "@/lib/useSummary";
import { Blunderprint } from "./Blunderprint";
import { StackedBars, type BarRow } from "./charts/StackedBars";
import { Filters } from "./Filters";
import { HeatBoard } from "./HeatBoard";
import { OpeningsTable } from "./OpeningsTable";

// The patterns section of the player page: filters, the Blunderprint with the heat board beside
// it, the error breakdowns and the openings. Data: GET /summary (lib/useSummary.ts).
//
// The filters live in the URL. A change pushes a history entry with the browser's own
// history.pushState, which Next's router picks up (useSearchParams updates) without a server
// round trip, so the back button steps back through filter changes.

type RateMode = "per100" | "perGame";

const PHASE_LABEL = { opening: "Opening", middlegame: "Middlegame", endgame: "Endgame" } as const;
const CLOCK_LABEL = { over50: "Over 50% left", from25to50: "25–50% left", from10to25: "10–25% left", under10: "Under 10% left" } as const;
const SPEED_LABEL = { bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical", daily: "Daily" } as const;

const one = (n: number) => n.toFixed(1);
const two = (n: number) => n.toFixed(2);

export function PatternsDashboard({
  platform,
  username,
  enabled,
  pulse,
}: {
  platform: Platform;
  username: string;
  enabled: boolean;
  pulse: number;
}) {
  const params = useSearchParams();
  const filters = useMemo(() => parseFilters(params), [params]);
  // "Today" for the date presets, fixed for the life of the page so the request doesn't change.
  const [today] = useState(() => new Date());
  const query = apiQuery(filters, today);
  const view = useSummary(platform, username, query, enabled, pulse);
  const [rate, setRate] = useState<RateMode>("per100");

  const setFilters = useCallback((next: DashboardFilters) => {
    const q = filtersToQuery(next);
    window.history.pushState(null, "", `${window.location.pathname}${q ? `?${q}` : ""}`);
  }, []);

  const base = `/p/${platform}/${encodeURIComponent(username)}/game/`;
  const gameHref = useCallback((id: string, ply: number) => `${base}${id}${ply > 0 ? `?ply=${ply}` : ""}`, [base]);

  if (!enabled) return null;
  const summary = view.data?.summary ?? null;
  const filtered = Boolean(filters.color || filters.speed || filters.range);

  return (
    <section className="flex flex-col gap-6" aria-labelledby="patterns-title">
      <div className="flex flex-col gap-3">
        <h2 id="patterns-title" className="font-display text-3xl text-ink">
          Patterns
        </h2>
        <Filters value={filters} onChange={setFilters} />
      </div>

      {view.error && !summary && (
        <p className="flex items-center gap-3 text-sm text-graphite">
          Couldn&apos;t load the patterns.
          <button type="button" className="btn-quiet" onClick={view.retry}>
            Retry
          </button>
        </p>
      )}
      {!summary && !view.error && <p className="font-mono text-sm text-graphite/70">Loading patterns…</p>}

      {summary && (
        <div className={`flex flex-col gap-10 transition-opacity duration-200 ${view.loading ? "opacity-60" : ""}`}>
          <Headline summary={summary} extracting={view.data!.extracting} />

          {summary.totals.analysed === 0 ? (
            <div className="flex flex-col items-start gap-2 border-l-2 border-ink/30 py-1 pl-4">
              <p className="font-display text-xl text-ink">{filtered ? "No analysed games match these filters" : "No patterns yet"}</p>
              <p className="text-sm text-graphite">
                {filtered ? "Try another colour, speed or date range." : "Patterns appear here as the engine analyses the games below."}
              </p>
              {filtered && (
                <button type="button" className="btn-quiet mt-1 text-sm" onClick={() => setFilters({})}>
                  Clear the filters
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
                <figure className="flex min-w-0 flex-col gap-2">
                  <figcaption className="flex flex-col gap-0.5">
                    <span className="font-display text-xl text-ink">The Blunderprint</span>
                    <span className="text-xs text-graphite/70">
                      One row per analysed game, newest at the top; one tick per move, so each column is the same move
                      in every game. Your errors in colour, your other moves dark, your opponent&apos;s faint.
                    </span>
                  </figcaption>
                  <Blunderprint ribbons={summary.ribbons} gameHref={gameHref} />
                </figure>
                <HeatBoard squares={summary.squares} mode={filters.color ?? "both"} />
              </div>

              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <h3 className="font-display text-2xl text-ink">Errors by</h3>
                  <RateToggle value={rate} onChange={setRate} />
                </div>
                <div className="grid gap-x-10 gap-y-8 md:grid-cols-2">
                  <StackedBars
                    title="Phase"
                    rows={summary.byPhase.map((p) => bar(p.phase, PHASE_LABEL[p.phase], p, rate, summary.totals.analysed))}
                    format={rate === "per100" ? one : two}
                  />
                  <StackedBars
                    title="Clock"
                    caption="Time left when the move was played. Daily games and games without clock data aren't counted."
                    rows={summary.byClock.map((c) => bar(c.bucket, CLOCK_LABEL[c.bucket], c, rate, summary.totals.analysed))}
                    format={rate === "per100" ? one : two}
                  />
                  <StackedBars
                    title="Move number"
                    rows={summary.byMoveNumber.map((m) => bar(m.bucket, `Moves ${m.bucket.replace("-", "–")}`, m, rate, summary.totals.analysed))}
                    format={rate === "per100" ? one : two}
                  />
                  <StackedBars
                    title="Speed"
                    rows={summary.bySpeed.map((s) => ({ ...bar(s.speed, SPEED_LABEL[s.speed], s, rate, s.games), sub: count(s.games, "game", "games") }))}
                    format={rate === "per100" ? one : two}
                  />
                </div>
              </div>

              <OpeningsTable openings={summary.openings} />
            </>
          )}
        </div>
      )}
    </section>
  );
}

// `games`: what the bar is built on. Speed bars have their own count; the phase, clock and
// move-number bars are all built on every analysed game in the filter.
function bar(key: string, label: string, r: Rate, rate: RateMode, games: number): BarRow {
  return {
    key,
    label,
    games,
    counts: { inaccuracy: r.inaccuracy, mistake: r.mistake, blunder: r.blunder },
    value: rate === "per100" ? r.per100 : r.perGame,
  };
}

function Headline({ summary, extracting }: { summary: Summary; extracting: boolean }) {
  const t = summary.totals;
  const per100 = t.moves > 0 ? (t.mistakes.total / t.moves) * 100 : null;
  return (
    <div className="flex flex-col gap-1">
      <p className="font-mono text-sm text-graphite">
        {t.analysed} of {t.games} games analysed
        {per100 !== null && (
          <>
            {" · "}
            {per100.toFixed(1)} errors per 100 moves · {count(t.mistakes.blunder, "blunder", "blunders")},{" "}
            {count(t.mistakes.mistake, "mistake", "mistakes")}, {count(t.mistakes.inaccuracy, "inaccuracy", "inaccuracies")}
          </>
        )}
      </p>
      {extracting && (
        <p className="font-mono text-xs text-graphite/70" role="status">
          Working out patterns for the newest analysed games…
        </p>
      )}
    </div>
  );
}

function RateToggle({ value, onChange }: { value: RateMode; onChange: (v: RateMode) => void }) {
  const options: [RateMode, string][] = [
    ["per100", "per 100 moves"],
    ["perGame", "per game"],
  ];
  return (
    <div className="flex items-center gap-1.5" role="radiogroup" aria-label="Error rate">
      {options.map(([key, label]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={value === key}
          onClick={() => onChange(key)}
          className={`rounded-full border px-2.5 py-0.5 text-xs transition-[background-color,color,border-color,transform] duration-150 active:scale-95 ${
            value === key ? "border-ink bg-ink text-bone" : "border-ink/20 text-graphite hover:border-ink hover:text-ink"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
