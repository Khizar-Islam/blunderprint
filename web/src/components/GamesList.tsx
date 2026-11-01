"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { memo, useState } from "react";
import type { LiveGame } from "@/engine/useAnalysis";
import type { GameRow, Platform } from "@/lib/api";
import { formatTimeControl, fullDate, relativeTime } from "@/lib/format";
import { classifiedRibbon, progressRibbon } from "@/lib/ribbon";

const STAGGER_S = 0.03; // between rows of one batch
const MAX_STAGGERED = 20; // later rows of a big batch share the last delay, so none waits long

export function GamesList({
  games,
  live = {},
  platform,
  username,
}: {
  games: GameRow[];
  live?: Record<string, LiveGame>;
  platform: Platform;
  username: string;
}) {
  const base = `/p/${platform}/${encodeURIComponent(username)}/game/`;
  // Which rows are new since the last list, and their order among the new ones: only those
  // reveal, staggered. React's "adjust state while rendering" pattern (no effect, no extra
  // render pass): when the games prop changes, recompute before rendering the rows.
  const [previous, setPrevious] = useState<GameRow[]>([]);
  const [newOrder, setNewOrder] = useState<Map<string, number>>(new Map());
  if (games !== previous) {
    const seen = new Set(previous.map((g) => g.id));
    const order = new Map<string, number>();
    for (const g of games) if (!seen.has(g.id)) order.set(g.id, order.size);
    setPrevious(games);
    setNewOrder(order);
  }

  if (games.length === 0) return null;
  return (
    <ol className="flex flex-col border-t border-ink/10" aria-label="Games, newest first">
      {games.map((game) => (
        <Row
          key={game.id}
          game={game}
          live={live[game.id]}
          href={base + game.id}
          delay={Math.min(newOrder.get(game.id) ?? 0, MAX_STAGGERED) * STAGGER_S}
        />
      ))}
    </ol>
  );
}

const RESULT_LABEL = { win: "Win", loss: "Loss", draw: "Draw" } as const;

// W/L/D in ink and graphite only: the classification colours are kept for move classifications.
function ResultMark({ result }: { result: GameRow["result"] }) {
  const style =
    result === "win"
      ? "bg-ink text-bone"
      : result === "loss"
        ? "border border-ink text-ink"
        : "border border-graphite/40 text-graphite";
  return (
    <span
      className={`inline-flex size-6 shrink-0 items-center justify-center rounded-sm font-mono text-xs ${style}`}
      aria-label={RESULT_LABEL[result]}
      title={RESULT_LABEL[result]}
    >
      {result === "win" ? "W" : result === "loss" ? "L" : "½"}
    </span>
  );
}

// A tiny square in the colour the player had.
function ColorChip({ color }: { color: GameRow["color"] }) {
  return (
    <span
      className={`inline-block size-2.5 shrink-0 rounded-[2px] border border-ink/60 ${color === "white" ? "bg-bone" : "bg-ink"}`}
      aria-label={`Played ${color === "white" ? "White" : "Black"}`}
      title={`Played ${color === "white" ? "White" : "Black"}`}
    />
  );
}

// The ribbon under a row, from the freshest source: this tab's live analysis, else what the
// list says is stored. Pending games get an empty track, so a row's height never jumps.
function Ribbon({ game, live }: { game: GameRow; live?: LiveGame }) {
  const stored = game.analysis;
  const classes = live?.classifications ?? stored?.classifications;
  let background = "none";
  let label = "Not analysed yet";
  if (live?.unanalysable || (!live && stored?.status === "unanalysable")) {
    label = "Couldn't analyse this game";
  } else if (classes?.length) {
    background = classifiedRibbon(classes, game.color);
    label = "Analysed";
  } else if (live) {
    background = progressRibbon(live.evaluated, live.plies);
    label = `Analysing: move ${Math.ceil(live.evaluated / 2)} of ${Math.ceil(live.plies / 2)}`;
  }
  return (
    <div
      className="mt-2 h-1 w-full rounded-full bg-ink/5"
      style={{ backgroundImage: background }}
      role="img"
      aria-label={label}
      title={label}
    />
  );
}

// memo: while the engine runs, `live` changes ~10 times a second for one or two games; only
// those rows re-render.
const Row = memo(function Row({
  game,
  live,
  href,
  delay,
}: {
  game: GameRow;
  live?: LiveGame;
  href: string;
  delay: number;
}) {
  const tc = formatTimeControl(game.timeControl);
  const speed = [game.speed, tc].filter(Boolean).join(" ");
  const opening = game.opening?.name ?? game.opening?.eco;

  return (
    // `initial` only applies when a row mounts, so rows already on screen never re-animate.
    <motion.li
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25, ease: "easeOut", delay }}
      className="border-b border-ink/10"
    >
      {/* The whole row opens the game review. prefetch off: Next would prefetch every row that
          scrolls into view (up to 200), and the review page loads its data in the browser anyway. */}
      <Link
        href={href}
        prefetch={false}
        className="block px-1 py-2.5 transition-colors hover:bg-square-light/40 active:bg-square-light/70 sm:px-2"
      >
        {/* Mobile: two lines. sm and up: one grid row. */}
        <div className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-0.5 sm:grid-cols-[auto_minmax(0,1.7fr)_4.5rem_minmax(0,1.3fr)_6rem]">
          <span className="row-span-2 flex items-center gap-2 sm:row-span-1">
            <ResultMark result={game.result} />
            <ColorChip color={game.color} />
          </span>

          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-ink">{game.opponentName ?? "Unknown"}</span>
            {game.opponentRating != null && (
              <span className="shrink-0 font-mono text-xs text-graphite/80 tabular-nums">{game.opponentRating}</span>
            )}
            {game.playerRating != null && (
              <span className="hidden shrink-0 font-mono text-xs whitespace-nowrap text-graphite/50 tabular-nums lg:inline">
                you {game.playerRating}
              </span>
            )}
          </span>

          <time
            dateTime={game.playedAt}
            title={fullDate(game.playedAt)}
            className="text-right font-mono text-xs text-graphite/70 sm:order-last"
          >
            {relativeTime(game.playedAt)}
          </time>

          <span className="col-start-2 col-end-4 flex min-w-0 gap-2 text-xs text-graphite/80 sm:contents">
            <span className="shrink-0 font-mono sm:text-xs">{speed}</span>
            <span className="truncate sm:text-sm" title={opening}>
              <span className="sm:hidden">· </span>
              {opening ?? "—"}
            </span>
          </span>
        </div>
        <Ribbon game={game} live={live} />
      </Link>
    </motion.li>
  );
});
