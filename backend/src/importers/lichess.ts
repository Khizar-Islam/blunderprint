import type { Speed } from "../db/models/game.js";
import { countPlies, type ImportBatch, type Importer, type NormalizedGame } from "./normalize.js";
import type { PoliteClient } from "./politeFetch.js";

// Lichess API: https://lichess.org/api#tag/Games/operation/apiGamesUser
const API = "https://lichess.org/api";
const BATCH_SIZE = 50;

// Standard chess only (variants are separate perf types), and no ultrabullet:
// 15-second games say little about how someone plays.
const PERF_TYPES = "bullet,blitz,rapid,classical,correspondence";

const SPEED_MAP: Record<string, Speed> = {
  ultraBullet: "bullet",
  bullet: "bullet",
  blitz: "blitz",
  rapid: "rapid",
  classical: "classical",
  correspondence: "daily",
};

// Statuses of games that never really happened.
const SKIP_STATUSES = new Set(["created", "started", "aborted", "noStart"]);

interface LichessPlayer {
  user?: { name: string; id: string };
  rating?: number;
  aiLevel?: number;
}

export interface LichessGame {
  id: string;
  variant: string;
  speed: string;
  createdAt: number;
  lastMoveAt: number;
  status: string;
  players: { white: LichessPlayer; black: LichessPlayer };
  winner?: "white" | "black";
  initialFen?: string;
  moves?: string;
  pgn?: string;
  clock?: { initial: number; increment: number };
  daysPerTurn?: number;
  // Centiseconds left after each ply. Seen on real exports: one entry more than there are
  // plies; entry i is the clock after ply i + 1, so we keep the first `plies` entries.
  clocks?: number[];
  opening?: { eco: string; name: string; ply: number };
  // One entry per ply when Lichess analysed the game, from White's point of view.
  analysis?: { eval?: number; mate?: number }[];
}

export interface LichessCheckpoint {
  collected: number;
  // createdAt (ms) of the oldest game received so far: a resume asks for games until just before it.
  oldestCreatedAt?: number;
  newestCreatedAt?: number;
}

export function normalizeLichessGame(game: LichessGame, usernameLower: string): NormalizedGame | null {
  if (game.variant !== "standard" || game.initialFen || SKIP_STATUSES.has(game.status) || !game.pgn) return null;

  const color = game.players.white.user?.id === usernameLower ? "white" : game.players.black.user?.id === usernameLower ? "black" : null;
  if (!color) return null;
  const me = game.players[color];
  const opponent = game.players[color === "white" ? "black" : "white"];

  // The export's `moves` field is the game's SAN moves separated by spaces: counting them is
  // free, while replaying the PGN with chess.js costs ~25 ms a game (measured on 200 real games).
  const plies = game.moves !== undefined ? game.moves.split(" ").filter(Boolean).length : countPlies(game.pgn);
  if (plies === null || plies < 2) return null;

  // Only trust Lichess's evals when there's a usable one for every ply. Otherwise the game
  // goes to our own engine like any other.
  const analysis = game.analysis;
  const evals =
    analysis && analysis.length === plies && analysis.every((a) => a.eval !== undefined || a.mate !== undefined)
      ? analysis.map((a) => (a.mate !== undefined ? { mate: a.mate } : { cp: a.eval }))
      : undefined;

  return {
    sourceId: game.id,
    playedAt: new Date(game.lastMoveAt),
    color,
    result: game.winner ? (game.winner === color ? "win" : "loss") : "draw",
    termination: game.status,
    timeControl: game.clock
      ? `${game.clock.initial}+${game.clock.increment}`
      : game.daysPerTurn
        ? `1/${game.daysPerTurn * 86400}` // same shape as Chess.com daily
        : undefined,
    speed: SPEED_MAP[game.speed] ?? "blitz",
    playerRating: me.rating,
    opponentRating: opponent.rating,
    opponentName: opponent.user?.name ?? (opponent.aiLevel ? `Stockfish level ${opponent.aiLevel}` : "Anonymous"),
    pgn: game.pgn,
    plies,
    clocks: game.clocks && game.clocks.length >= plies ? game.clocks.slice(0, plies).map((cs) => cs / 100) : undefined,
    opening: game.opening ? { eco: game.opening.eco, name: game.opening.name, ply: game.opening.ply } : undefined,
    evals,
  };
}

export function createLichessImporter(client: PoliteClient): Importer {
  const name = (username: string) => encodeURIComponent(username.toLowerCase());

  return {
    async fetchProfile(username, signal) {
      const res = await client.getJson<{
        username: string;
        disabled?: boolean;
        perfs?: Record<string, { rating?: number } | undefined>;
        profile?: { flag?: string };
      }>(`${API}/user/${name(username)}`, { signal });
      if (res.status === 404 || !res.data || res.data.disabled) return null;
      const perfs = res.data.perfs ?? {};
      return {
        username: res.data.username,
        ratings: { blitz: perfs.blitz?.rating, rapid: perfs.rapid?.rating, bullet: perfs.bullet?.rating },
        country: res.data.profile?.flag,
      };
    },

    async importGames({ username, maxGames, signal, known, checkpoint, onBatch }) {
      const usernameLower = username.toLowerCase();
      const state: LichessCheckpoint = (checkpoint as LichessCheckpoint | undefined) ?? { collected: 0 };
      if (state.collected >= maxGames) return { newestGameAt: toDate(state.newestCreatedAt) };

      const params = new URLSearchParams({
        max: String(maxGames - state.collected),
        sort: "dateDesc",
        perfType: PERF_TYPES,
        clocks: "true",
        evals: "true",
        opening: "true",
        pgnInJson: "true",
      });
      // Re-import: only games since the newest one we have. Getting that one game again is
      // harmless (the upsert overwrites it), and missing a game would not be.
      if (known.newestGameAt) params.set("since", String(known.newestGameAt.getTime()));
      // Resume: only games older than the oldest one we already received.
      if (state.oldestCreatedAt) params.set("until", String(state.oldestCreatedAt - 1));

      // Batches are stored in the background, in order, while the stream keeps flowing.
      // Awaiting each DB write inside the stream stalled it: a 50-game batch is ~400 KB and on a
      // slow upload took longer than the stream's idle timeout. At most maxGames games are ever
      // waiting in memory, so there's no need for backpressure.
      let batch: NormalizedGame[] = [];
      let writes: Promise<void> = Promise.resolve();
      let writeError: unknown;
      const flush = () => {
        const out: ImportBatch<LichessCheckpoint> = { games: batch, checkpoint: { ...state } };
        batch = [];
        writes = writes.then(() => (writeError ? undefined : onBatch(out))).catch((err) => void (writeError ??= err));
      };

      try {
        const status = await client.streamLines(
          `${API}/games/user/${name(username)}?${params}`,
          (line) => {
            if (writeError) throw writeError; // stop reading once storing has failed
            const game = JSON.parse(line) as LichessGame;
            state.oldestCreatedAt = Math.min(state.oldestCreatedAt ?? Infinity, game.createdAt);
            state.newestCreatedAt = Math.max(state.newestCreatedAt ?? 0, game.createdAt);
            const normalized = normalizeLichessGame(game, usernameLower);
            if (normalized) {
              batch.push(normalized);
              state.collected++;
            }
            if (batch.length >= BATCH_SIZE) flush();
          },
          { signal, headers: { Accept: "application/x-ndjson" } },
        );
        if (status !== 404 && batch.length > 0) flush();
      } finally {
        // Never leave writes running behind the job's back, even when the stream failed.
        await writes;
      }
      if (writeError) throw writeError;

      return { newestGameAt: toDate(state.newestCreatedAt) };
    },
  };
}

const toDate = (ms?: number) => (ms ? new Date(ms) : undefined);
