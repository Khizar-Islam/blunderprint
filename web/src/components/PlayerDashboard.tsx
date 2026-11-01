"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  fetchGames,
  fetchPlayer,
  isValidUsername,
  PLATFORM_NAMES,
  startImport,
  type GameRow,
  type Platform,
  type Player,
} from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { useJobStream, type JobEventType } from "@/lib/useJobStream";
import { useWakingRequest } from "@/lib/useWakingRequest";
import { useAnalysis } from "@/engine/useAnalysis";
import { AnalysisBar } from "./AnalysisBar";
import { GamesList } from "./GamesList";
import { ImportProgress } from "./ImportProgress";

type Props = { platform: Platform; username: string };

export function PlayerDashboard({ platform, username }: Props) {
  // Checked before any request: an obvious typo never reaches the API.
  if (!isValidUsername(platform, username)) {
    return <Notice title="Not a valid username">That isn&apos;t a valid {PLATFORM_NAMES[platform]} username.</Notice>;
  }
  return <Dashboard platform={platform} username={username} />;
}

// What the first request (GET player, then POST import if needed) settles on.
interface Start {
  player: Player | null;
  jobId: string | null; // the import to follow, if one is queued or running
}

// Sorted like the API (playedAt desc, then id desc), so merging pages never reorders rows.
const byNewest = (a: GameRow, b: GameRow) => b.playedAt.localeCompare(a.playedAt) || b.id.localeCompare(a.id);

function Dashboard({ platform, username }: Props) {
  // 1. GET player → { player, activeJob }. 2. With no active import, POST one: the API answers
  // 202 with a job, or 200 { upToDate } when the last import is under 6 h old. Both requests
  // are safe to repeat, so the waking hook may retry the pair while Render wakes up.
  const start = useWakingRequest<Start>(async (signal) => {
    let found: Awaited<ReturnType<typeof fetchPlayer>> | null = null;
    try {
      found = await fetchPlayer(platform, username, signal);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) throw err; // 404: never imported
    }
    if (found?.activeJob) return { player: found.player, jobId: found.activeJob.id };
    const result = await startImport(platform, username, signal);
    return { player: found?.player ?? null, jobId: result.kind === "job" ? result.jobId : null };
  });

  const started = start.state.kind === "done" ? start.state.value : null;
  // The player as of the start request, until an import finishes and we fetch it again.
  const [refreshedPlayer, setRefreshedPlayer] = useState<Player | null>(null);
  const player = refreshedPlayer ?? started?.player ?? null;
  const [games, setGames] = useState<GameRow[]>([]);
  const [gamesState, setGamesState] = useState<"idle" | "loading" | "error">("idle");
  const [lastEventAt, setLastEventAt] = useState(() => Date.now());

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

  // Once the start request settles: show what is stored already (a re-import, or up to date).
  useEffect(() => {
    if (started?.player) void load("reload");
  }, [started, load]);

  // ---- Following the import ------------------------------------------------------------------
  const onEvent = useCallback(
    (type: JobEventType) => {
      setLastEventAt(Date.now());
      if (type === "progress") void load("sync");
      if (type === "done") {
        void load("reload");
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
  const analysis = useAnalysis(platform, username, player != null);
  const { kick } = analysis;
  useEffect(() => {
    if (games.length > 0) kick();
  }, [games, kick]);

  // ---- Render --------------------------------------------------------------------------------
  const chessComNote = platform === "chesscom" && (
    <p className="text-sm text-graphite/70">Chess.com publishes games with a 12–24 hour delay, so the newest may be missing.</p>
  );

  if (start.state.kind === "loading") {
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
    return <Notice title="Couldn't load this player" action={{ label: "Retry", onClick: start.retry }}>{error.message}</Notice>;
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
      <Notice title="The import failed" action={{ label: "Try again", onClick: start.retry }}>
        {job.error?.message ?? "Something went wrong on our side."}
      </Notice>
    );
  }

  const importing = started?.jobId != null && job?.status !== "done";
  const finished = !importing;

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        {importing ? (
          <ImportProgress platform={platform} job={job} connection={stream.connection} lastEventAt={lastEventAt} />
        ) : (
          player && (
            <p className="font-mono text-sm text-graphite">
              {player.gamesCount} games
              {player.lastImportedAt && <> · imported {relativeTime(player.lastImportedAt)}</>}
            </p>
          )
        )}
        {stream.connection === "lost" && importing && (
          <Notice title="Lost the connection to the import" action={{ label: "Retry", onClick: start.retry }}>
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

      {finished && games.length === 0 && gamesState === "idle" && (
        <Notice title="No games to show">
          We found no standard games for this player. Variants (like Chess960) and games from a custom position are
          skipped.
        </Notice>
      )}

      {player && games.length > 0 && (
        <AnalysisBar analysis={analysis} analysedCount={player.analysedCount} gamesCount={games.length} />
      )}

      <GamesList games={games} live={analysis.live} />
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
