"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { ApiError, fetchGames, fetchPlayer, isValidUsername, PLATFORM_NAMES, type GameRow, type Platform, type Player } from "@/lib/api";
import { isImportRefusal, startDashboard, type Start } from "@/lib/dashboardStart";
import { apiQuery, parseFilters } from "@/lib/filters";
import { demoLine, relativeTime } from "@/lib/format";
import { useJobStream, type JobEventType } from "@/lib/useJobStream";
import { useWakingRequest } from "@/lib/useWakingRequest";
import { useAnalysis } from "@/engine/useAnalysis";
import { useCoachInfo } from "@/lib/useCoachInfo";
import { CoachButton } from "./coach/CoachButton";
import { AnalysisBar } from "./AnalysisBar";
import { GamesList } from "./GamesList";
import { ImportProgress } from "./ImportProgress";
import { PatternsDashboard } from "./patterns/PatternsDashboard";

type Props = { platform: Platform; username: string };

export function PlayerDashboard({ platform, username }: Props) {
  // Checked before any request: an obvious typo never reaches the API.
  if (!isValidUsername(platform, username)) {
    return <Notice title="Not a valid username">That isn&apos;t a valid {PLATFORM_NAMES[platform]} username.</Notice>;
  }
  return <Dashboard platform={platform} username={username} />;
}

// Sorted like the API (playedAt desc, then id desc), so merging pages never reorders rows.
const byNewest = (a: GameRow, b: GameRow) => b.playedAt.localeCompare(a.playedAt) || b.id.localeCompare(a.id);

function Dashboard({ platform, username }: Props) {
  // The summary starts in parallel with GET player → POST import (lib/dashboardStart.ts), for
  // the filters in the URL (the same query the patterns section will ask for). Both requests are
  // safe to repeat, so the waking hook may retry them while Render wakes up.
  // `foundPlayer` arrives with GET player, before the import check settles: the patterns, the
  // games and the coach button render from it at once (on the demo dashboard that took one
  // round trip off LCP). If the import check then starts an import, it's followed as before.
  const [foundPlayer, setFoundPlayer] = useState<Player | null>(null);
  // The import check on load is automatic; once the visitor clicks Try again / Retry, the
  // following checks are theirs (they count toward their import limit, Stage 6).
  const byUser = useRef(false);
  const start = useWakingRequest<Start>((signal) =>
    startDashboard(
      platform,
      username,
      apiQuery(parseFilters(new URLSearchParams(window.location.search)), new Date()),
      signal,
      setFoundPlayer,
      undefined,
      byUser.current ? "user" : "auto",
    ),
  );
  const retryByUser = useCallback(() => {
    byUser.current = true;
    start.retry();
  }, [start]);

  const started = start.state.kind === "done" ? start.state.value : null;
  // The player as of the start request, until an import finishes and we fetch it again.
  const [refreshedPlayer, setRefreshedPlayer] = useState<Player | null>(null);
  const player = refreshedPlayer ?? started?.player ?? foundPlayer;
  const hasPlayer = player != null;
  const [games, setGames] = useState<GameRow[]>([]);
  const [gamesState, setGamesState] = useState<"idle" | "loading" | "error">("idle");
  const [lastEventAt, setLastEventAt] = useState(() => Date.now());
  // Bumped when an import finishes: the patterns refetch (new games, trimmed old ones).
  const [importsDone, setImportsDone] = useState(0);

  // ---- Loading games -------------------------------------------------------------------------
  // `pageCursor` is the cursor of the last page we fetched (null = the first page). While an
  // import runs, new games are older than the ones shown (imports go newest-first), so each
  // progress event re-reads that last page and follows nextCursor to the end. Re-reading one
  // page we already have is the price of not knowing a cursor "after the last row" (the API
  // only hands one out when it knows there are more). Rows are merged by id.
  const pageCursor = useRef<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const busy = useRef(false);
  const again = useRef<"none" | "sync" | "reload">("none");

  const load = useCallback(
    async (mode: "sync" | "reload") => {
      // One load at a time; a request that arrives meanwhile runs once the current one ends
      // (a reload wins over a sync, as it covers it).
      if (busy.current) {
        if (again.current !== "reload") again.current = mode;
        return;
      }
      busy.current = true;
      setGamesState("loading");
      const signal = controller.current!.signal;
      try {
        // reload: from the top, replacing the list. Used when an import finishes, as the server
        // has then also trimmed the player to the newest games.
        let cursor = mode === "reload" ? null : pageCursor.current;
        const fresh = new Map<string, GameRow>();
        for (;;) {
          const page = await fetchGames(platform, username, cursor, signal);
          for (const g of page.games) fresh.set(g.id, g);
          if (!page.nextCursor) break;
          cursor = page.nextCursor;
        }
        pageCursor.current = cursor;
        setGames((prev) => {
          const merged = mode === "reload" ? fresh : new Map([...prev.map((g) => [g.id, g] as const), ...fresh]);
          return [...merged.values()].sort(byNewest);
        });
        setGamesState("idle");
      } catch (err) {
        if (signal.aborted) return;
        // 404 here means the player doesn't exist yet (first import still queued): no games yet.
        setGamesState(err instanceof ApiError && err.status === 404 ? "idle" : "error");
      } finally {
        busy.current = false;
        const next = again.current;
        again.current = "none";
        if (next !== "none" && !signal.aborted) void load(next);
      }
    },
    [platform, username],
  );

  useEffect(() => {
    controller.current = new AbortController();
    return () => controller.current?.abort();
  }, []);

  // Once the player is known: show what is stored already (a re-import, or up to date). Once,
  // not again when the import check settles: an import it starts brings its own progress syncs.
  useEffect(() => {
    if (hasPlayer) void load("reload");
  }, [hasPlayer, load]);

  // ---- Following the import ------------------------------------------------------------------
  const onEvent = useCallback(
    (type: JobEventType) => {
      setLastEventAt(Date.now());
      if (type === "progress") void load("sync");
      if (type === "done") {
        void load("reload");
        setImportsDone((n) => n + 1);
        // Fresh counts and lastImportedAt for the summary line.
        const signal = controller.current!.signal;
        fetchPlayer(platform, username, signal)
          .then((res) => setRefreshedPlayer(res.player))
          .catch(() => {}); // the summary just keeps the older numbers
      }
    },
    [load, platform, username],
  );
  const stream = useJobStream(started?.jobId ?? null, onEvent);
  const job = stream.job;

  // ---- Browser engine analysis (CLAUDE.md 8.2) -----------------------------------------------
  // Runs once the player exists (the claim route needs them). While an import streams in,
  // every new page of games kicks the scheduler, so an idle one claims the new games.
  // A frozen demo player is never analysed here (the server would hand out nothing anyway), so
  // the engine isn't even loaded.
  const demo = player?.demo === true;
  const analysis = useAnalysis(platform, username, player != null && !demo);
  const { kick } = analysis;
  // The coach button (GET /report) follows the same pulse as the patterns.
  const coachInfo = useCoachInfo(platform, username, player != null, analysis.doneThisSession + importsDone);
  useEffect(() => {
    if (games.length > 0) kick();
  }, [games, kick]);

  // ---- Render --------------------------------------------------------------------------------
  const chessComNote = platform === "chesscom" && (
    <p className="text-sm text-graphite/70">Chess.com publishes games with a 12–24 hour delay, so the newest may be missing.</p>
  );

  // Still looking, with nothing stored to show yet (GET player hasn't answered, or a first import).
  if (start.state.kind === "loading" && !foundPlayer) {
    return (
      <Status>
        {start.waking ? `Waking the server up… (${Math.floor(start.elapsedMs / 1_000)}s)` : "Looking up the player…"}
      </Status>
    );
  }

  if (start.state.kind === "error") {
    const { error } = start.state;
    if (error.status === 400) {
      return <Notice title="Not a valid username">That isn&apos;t a valid {PLATFORM_NAMES[platform]} username.</Notice>;
    }
    // A guard refused a NEW player's import (Stage 6): the API's message says why and when.
    if (isImportRefusal(error)) {
      return error.code === "busy" ? (
        <Notice title="Can't import this player right now" action={{ label: "Try again", onClick: retryByUser }}>
          {error.message}
        </Notice>
      ) : (
        <Notice title="Can't import this player right now" link>
          {error.message}
        </Notice>
      );
    }
    return <Notice title="Couldn't load this player" action={{ label: "Retry", onClick: retryByUser }}>{error.message}</Notice>;
  }

  if (job?.status === "failed") {
    if (job.error?.code === "user_not_found") {
      return (
        <Notice title="Player not found" link>
          {job.error.message}
        </Notice>
      );
    }
    return (
      <Notice title="The import failed" action={{ label: "Try again", onClick: retryByUser }}>
        {job.error?.message ?? "Something went wrong on our side."}
      </Notice>
    );
  }

  const importing = started?.jobId != null && job?.status !== "done";
  // Settled with no import running (not while the import check is still out: it may start one).
  const finished = started != null && !importing;
  // Known to have no games (then the sections below have nothing to show and give way to a notice).
  const noGames = finished && games.length === 0 && gamesState === "idle";

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        {importing ? (
          <ImportProgress platform={platform} job={job} connection={stream.connection} lastEventAt={lastEventAt} />
        ) : (
          player && (
            <p className="font-mono text-sm text-graphite">
              {player.gamesCount} games
              {demo ? (
                <> · {demoLine(player.lastImportedAt)}</>
              ) : (
                player.lastImportedAt && <> · imported {relativeTime(player.lastImportedAt)}</>
              )}
            </p>
          )
        )}
        {/* A stored player whose refresh a guard refused: the stored games still show. */}
        {started?.importRefused && !importing && (
          <p className="text-sm text-graphite/70" role="status">
            Not checked for new games: {started.importRefused.message}
          </p>
        )}
        {stream.connection === "lost" && importing && (
          <Notice title="Lost the connection to the import" action={{ label: "Retry", onClick: retryByUser }}>
            The import may still be running on the server.
          </Notice>
        )}
        {chessComNote}
      </div>

      {gamesState === "error" && (
        <p className="flex items-center gap-3 text-sm text-graphite">
          Couldn&apos;t load the games.
          <button type="button" className="btn-quiet" onClick={() => void load("reload")}>
            Retry
          </button>
        </p>
      )}

      {noGames && (
        <Notice title="No games to show">
          We found no standard games for this player. Variants (like Chess960) and games from a custom position are
          skipped.
        </Notice>
      )}

      {/* Sections appear as their data arrives. Each one's space is held while it loads (a
          placeholder of about its height), so what's below doesn't jump; then it fades in. */}
      {player && !demo && games.length > 0 && (
        <div className="anim-fade">
          <AnalysisBar analysis={analysis} analysedCount={player.analysedCount} gamesCount={games.length} />
        </div>
      )}
      {player && !demo && games.length === 0 && !noGames && gamesState !== "error" && <div className="h-[37px]" aria-hidden="true" />}

      {/* From the first render with a player, not once the games request is out: appearing one
          render later, its 148 px pushed the patterns down (measured CLS 0.054 on load). */}
      {player && !noGames && <CoachButton info={coachInfo} platform={platform} username={username} />}

      {/* Patterns refetch when the engine stores a game or an import finishes (the pulse), at most
          every 10 s. Suspense: the section reads the URL's filters (useSearchParams). */}
      <Suspense fallback={null}>
        <PatternsDashboard
          platform={platform}
          username={username}
          enabled={player != null}
          pulse={analysis.doneThisSession + importsDone}
        />
      </Suspense>

      <GamesList games={games} live={analysis.live} platform={platform} username={username} />
    </div>
  );
}

function Status({ children }: { children: React.ReactNode }) {
  return (
    <p className="font-mono text-sm text-graphite/70" role="status" aria-live="polite">
      {children}
    </p>
  );
}

function Notice({
  title,
  children,
  action,
  link,
}: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
  link?: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-2 border-l-2 border-ink/30 py-1 pl-4" role="status">
      <p className="font-display text-xl text-ink">{title}</p>
      <p className="text-sm text-graphite">{children}</p>
      {action && (
        <button type="button" className="btn-quiet mt-1 text-sm" onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {link && (
        <Link href="/" className="btn-quiet mt-1 text-sm">
          Search another player
        </Link>
      )}
    </div>
  );
}
