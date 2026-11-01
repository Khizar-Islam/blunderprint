"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAnalysis, type AnalysisView, type LiveGame } from "@/engine/useAnalysis";
import { fetchGame, PLATFORM_NAMES, type GameDetail, type Platform } from "@/lib/api";
import { formatTimeControl, fullDate } from "@/lib/format";
import { progressRibbon } from "@/lib/ribbon";
import { buildTimeline, uciToSan, type Timeline } from "@/lib/timeline";
import { useWakingRequest } from "@/lib/useWakingRequest";
import { BetterMove } from "./BetterMove";
import { EvalGraph } from "./EvalGraph";
import { Board, type BoardArrow } from "./Board";
import { GLYPH, HEX, isError } from "./classes";
import { MoveList } from "./MoveList";

type Props = { platform: Platform; username: string; gameId: string };

export function GameReview({ platform, username, gameId }: Props) {
  const request = useWakingRequest((signal) => fetchGame(gameId, signal));

  if (request.state.kind === "loading") {
    return (
      <p className="font-mono text-sm text-graphite/70" role="status">
        {request.waking ? `Waking the server up… (${Math.floor(request.elapsedMs / 1000)}s)` : "Loading the game…"}
      </p>
    );
  }
  if (request.state.kind === "error") {
    const { error } = request.state;
    return error.status === 404 ? (
      <NotFound platform={platform} username={username} />
    ) : (
      <Notice title="Couldn't load this game" action={{ label: "Retry", onClick: request.retry }}>
        {error.message}
      </Notice>
    );
  }

  const { game, player } = request.state.value;
  // The URL names a player; the game must be theirs (same platform, username ignoring case).
  if (!player || player.platform !== platform || player.username.toLowerCase() !== username.toLowerCase()) {
    return <NotFound platform={platform} username={username} />;
  }
  return <Review game={game} platform={platform} username={player.username} />;
}

const unfinished = (g: GameDetail) => g.analysis.status === "pending" || g.analysis.status === "claimed";

function Review({ game: initial, platform, username }: { game: GameDetail; platform: Platform; username: string }) {
  const [game, setGame] = useState(initial);

  // ---- Not analysed yet: analyse it here, this game first -----------------------------------
  // The scheduler only runs while this game is unfinished: once its result is stored we fetch
  // the game again, `needsAnalysis` turns false, and the hook stops the engines and hands the
  // other claimed games back (the dashboard is where the rest get analysed).
  const needsAnalysis = unfinished(game);
  // One engine: only this game matters here; a second would start on another game that gets
  // handed back half-done as soon as this one is stored.
  const analysis = useAnalysis(platform, username, needsAnalysis, { prefer: game.id, engines: 1 });
  const live = analysis.live[game.id];
  const finishedHere = Boolean(live?.classifications || live?.unanalysable);
  useEffect(() => {
    if (!needsAnalysis) return;
    const controller = new AbortController();
    const refresh = () =>
      fetchGame(game.id, controller.signal)
        .then((r) => {
          if (!unfinished(r.game)) setGame(r.game);
        })
        .catch(() => {}); // try again on the next tick
    if (finishedHere) void refresh();
    // Also every 15 s: another tab (or another visitor) may be the one analysing it.
    const timer = setInterval(refresh, 15_000);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [needsAnalysis, finishedHere, game.id]);

  const timeline = useMemo<Timeline | null>(() => buildTimeline(game.pgn), [game.pgn]);
  const [ply, setPly] = useState(0); // 0 = start position, k = after ply k
  const [peekState, setPeek] = useState<{ ply: number; on: boolean }>({ ply: 0, on: false });
  // A peek belongs to the move it was opened on (so a stale one never shows on another move),
  // and every move change closes it: coming back to the mistake shows the position after it.
  const peek = peekState.on && peekState.ply === ply;
  const onPeek = useCallback((on: boolean) => setPeek({ ply, on }), [ply]);

  const last = timeline ? timeline.plies.length : 0;
  // The one way to change the move (keys, buttons, move list, graph).
  const go = useCallback(
    (target: number) => {
      setPly(Math.max(0, Math.min(last, target)));
      setPeek({ ply: 0, on: false });
    },
    [last],
  );

  // ←/→ one move, Home/End to the ends, hold B to peek at the better move. Ignored while typing
  // in a field or with modifier keys (browser shortcuts).
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      if (step) go(ply + step);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(last);
      else if (e.key === "b" || e.key === "B") {
        if (!e.repeat) setPeek({ ply, on: true });
      } else return;
      e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "b" || e.key === "B") setPeek({ ply, on: false });
    };
    const blur = () => setPeek((p) => ({ ...p, on: false })); // a held B never "sticks"
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, [go, ply, last]);

  if (!timeline) {
    return <Notice title="Can't read this game">The game&apos;s move record (PGN) couldn&apos;t be replayed.</Notice>;
  }

  // Only used when they line up with the moves (they always should; the server checks counts).
  const classes = game.analysis.classifications?.length === last ? game.analysis.classifications : undefined;
  const evals = game.analysis.evals?.length === last && last > 0 ? game.analysis.evals : undefined;
  const move = ply > 0 ? timeline.plies[ply - 1] : undefined;
  const cls = ply > 0 ? classes?.[ply - 1] : undefined;
  const bestUci = ply > 0 ? game.analysis.best?.[ply - 1] : undefined;
  const betterSan = move && isError(cls) && bestUci && bestUci !== move.uci ? uciToSan(timeline.fens[ply - 1]!, bestUci) : null;

  // Peeking: the position before the move, with the better move (teal) and the move played
  // (muted rust). Otherwise: the position after the move, its squares tinted.
  const showingBefore = peek && betterSan !== null && move !== undefined;
  const fen = showingBefore ? timeline.fens[ply - 1]! : timeline.fens[ply]!;
  const arrows: BoardArrow[] =
    showingBefore && bestUci
      ? [
          { from: move.from, to: move.to, color: "rgba(217, 119, 43, 0.5)" },
          { from: bestUci.slice(0, 2), to: bestUci.slice(2, 4), color: HEX.best },
        ]
      : [];

  return (
    <div className="flex flex-col gap-6">
      <Header game={game} platform={platform} username={username} />
      {needsAnalysis && <AnalysingNotice analysis={analysis} live={live} finished={finishedHere} />}
      {game.analysis.status === "unanalysable" && (
        <p className="font-mono text-sm text-graphite/80">
          The engine couldn&apos;t replay this game&apos;s moves, so it has no analysis. You can still step through it.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[auto_minmax(0,1fr)]">
        {/* The board is capped by the viewport's height too, so on a short laptop screen the
            controls and the "Better was" line stay in view under it. */}
        <div className="flex w-full max-w-[min(34rem,calc(100svh-11rem))] flex-col gap-3 justify-self-center lg:w-[min(34rem,calc(100svh-11rem))]">
          <Board
            fen={fen}
            orientation={game.color}
            lastMove={move && !showingBefore ? { from: move.from, to: move.to, cls } : undefined}
            arrows={arrows}
          />
          <Controls ply={ply} last={last} go={go} />
          <div className="min-h-12">
            {move && isError(cls) && (
              <BetterMove
                san={move.san}
                glyph={GLYPH[cls]!}
                cls={cls}
                betterSan={betterSan}
                peek={showingBefore}
                onPeek={onPeek}
              />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          {evals && (
            <EvalGraph
              evals={evals}
              classes={classes}
              player={game.color}
              current={ply}
              onScrub={go}
              labelFor={(k) => {
                const p = timeline.plies[k - 1]!;
                const c = classes?.[k - 1];
                return `${Math.ceil(k / 2)}${k % 2 ? "." : "…"} ${p.san}${(c && GLYPH[c]) ?? ""}`;
              }}
            />
          )}
          <MoveList plies={timeline.plies} classes={classes} player={game.color} current={ply} onSelect={go} />
        </div>
      </div>
    </div>
  );
}

// What the engine is doing about this game while it isn't analysed yet. The board and moves
// work meanwhile.
function AnalysingNotice({ analysis, live, finished }: { analysis: AnalysisView; live?: LiveGame; finished: boolean }) {
  let text: React.ReactNode;
  let button: { label: string; onClick: () => void } | null = null;
  if (finished) text = "Analysis done, loading it…";
  else if (analysis.needsTap) {
    text = "This game isn't analysed yet. The engine runs on your device and uses its battery.";
    button = { label: "Analyse on this device", onClick: analysis.resume };
  } else if (analysis.paused) {
    text = "Analysis paused.";
    button = { label: "Resume", onClick: analysis.resume };
  } else if (analysis.state === "waiting") {
    text = "Another Blunderprint tab is using the engine. This game updates when it has been analysed.";
    button = { label: "Pause", onClick: analysis.pause };
  } else if (live) {
    text = (
      <>
        Analysing this game in your browser… move {Math.ceil(live.evaluated / 2)} of {Math.ceil(live.plies / 2)}
      </>
    );
    button = { label: "Pause", onClick: analysis.pause };
  } else if (analysis.state === "stopped" && analysis.error) {
    text = "The analysis stopped.";
    button = { label: "Retry", onClick: analysis.resume };
  } else if (Object.keys(analysis.live).length === 0) {
    // Nothing started yet in this tab: loading the engine and claiming.
    text = "Starting the engine…";
  } else {
    // Running, but another tab or visitor holds this game's claim: it will finish there.
    text = "Waiting for this game's analysis…";
  }

  return (
    <div className="flex flex-col gap-2 border-l-2 border-best/60 py-1 pl-4">
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-graphite" role="status" aria-live="polite">
        <span>{text}</span>
        {button && (
          <button type="button" className="btn-quiet text-xs" onClick={button.onClick}>
            {button.label}
          </button>
        )}
      </p>
      {live && !finished && (
        <div
          className="h-1 w-full max-w-md rounded-full bg-ink/5"
          style={{ backgroundImage: progressRibbon(live.evaluated, live.plies) }}
          aria-hidden
        />
      )}
      {analysis.error && <p className="text-sm text-blunder">{analysis.error}</p>}
    </div>
  );
}

function Controls({ ply, last, go }: { ply: number; last: number; go: (ply: number) => void }) {
  const buttons: [string, string, number][] = [
    ["⏮", "Start", 0],
    ["◀", "Previous move", ply - 1],
    ["▶", "Next move", ply + 1],
    ["⏭", "End", last],
  ];
  return (
    <div className="flex items-center gap-2 font-mono text-sm">
      {buttons.map(([icon, label, target]) => (
        <button
          key={label}
          type="button"
          className="btn-quiet px-3 py-1 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-ink"
          aria-label={label}
          title={`${label} (${label === "Start" ? "Home" : label === "End" ? "End" : label === "Next move" ? "→" : "←"})`}
          disabled={target < 0 || target > last || target === ply}
          onClick={() => go(target)}
        >
          {icon}
        </button>
      ))}
      <span className="ml-auto text-xs text-graphite/70 tabular-nums">
        {ply === 0 ? "start" : `move ${Math.ceil(ply / 2)}${ply % 2 ? "" : "…"}`} / {Math.ceil(last / 2)}
      </span>
    </div>
  );
}

const RESULT = { win: "Won", loss: "Lost", draw: "Drew" } as const;

function Header({ game, platform, username }: { game: GameDetail; platform: Platform; username: string }) {
  const tc = formatTimeControl(game.timeControl);
  const opening = game.opening?.name ?? game.opening?.eco;
  return (
    <header className="flex flex-col gap-2">
      <Link
        href={`/p/${platform}/${encodeURIComponent(username)}`}
        className="self-start rounded text-sm text-graphite/70 transition-colors hover:text-ink active:opacity-70"
      >
        ← {username} · {PLATFORM_NAMES[platform]}
      </Link>
      <h1 className="font-display text-3xl tracking-tight text-ink sm:text-4xl">
        {RESULT[game.result]} vs {game.opponentName ?? "Unknown"}
        {game.opponentRating != null && (
          <span className="ml-2 font-mono text-base text-graphite/70 tabular-nums">{game.opponentRating}</span>
        )}
      </h1>
      <p className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs text-graphite/80">
        <span>{game.color === "white" ? "White" : "Black"}</span>
        <span>{[game.speed, tc].filter(Boolean).join(" ")}</span>
        <time dateTime={game.playedAt}>{fullDate(game.playedAt)}</time>
        {opening && <span className="font-sans">{opening}</span>}
        {game.analysis.accuracy != null && (
          <span title="The plain average of this player's per-move accuracy (not Lichess's weighted game accuracy)">
            {game.analysis.accuracy.toFixed(1)} avg move accuracy
          </span>
        )}
      </p>
    </header>
  );
}

function NotFound({ platform, username }: { platform: Platform; username: string }) {
  return (
    <Notice title="Game not found">
      This game doesn&apos;t exist, or it isn&apos;t one of {username}&apos;s.{" "}
      <Link className="underline" href={`/p/${platform}/${encodeURIComponent(username)}`}>
        Back to {username}&apos;s games
      </Link>
    </Notice>
  );
}

function Notice({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: { label: string; onClick: () => void };
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
    </div>
  );
}
