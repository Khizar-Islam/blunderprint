import { SPEEDS, type Speed } from "../db/models/game.js";
import {
  clocksFromPgn,
  countPliesFromText,
  pgnHeader,
  speedFromTimeControl,
  type Importer,
  type NormalizedGame,
  type PlayerProfile,
} from "./normalize.js";
import type { PoliteClient } from "./politeFetch.js";
import { logger } from "../lib/logger.js";

// Chess.com Published-Data API: https://www.chess.com/news/view/published-data-api
const API = "https://api.chess.com/pub/player";
const START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

// Result codes that mean a draw (the full table is in the API docs, "Game results codes").
const DRAW_CODES = new Set(["agreed", "repetition", "stalemate", "insufficient", "50move", "timevsinsufficient"]);

interface Side {
  username: string;
  rating?: number;
  result: string;
}

export interface ChessComGame {
  url: string;
  pgn?: string;
  time_control: string;
  end_time: number; // unix seconds
  rules: string;
  time_class?: string;
  initial_setup?: string;
  white: Side;
  black: Side;
}

export interface ChessComCheckpoint {
  monthsDone: string[]; // "YYYY/MM"
  collected: number;
  newestGameAt?: number; // ms
}

// The checks that cost nothing: standard chess from the normal start position, with a PGN,
// played by this user. Returns the user's color, or null to skip the game.
function cheapCheck(game: ChessComGame, usernameLower: string): "white" | "black" | null {
  if (game.rules !== "chess" || !game.pgn) return null;
  if (game.initial_setup && game.initial_setup !== START_FEN) return null;
  if (pgnHeader(game.pgn, "SetUp") === "1") return null;
  if (game.white.username.toLowerCase() === usernameLower) return "white";
  if (game.black.username.toLowerCase() === usernameLower) return "black";
  return null;
}

// Lets timers (lease renewal, SSE heartbeats) and requests (/api/health) run between games.
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
// Yield once this much time has passed, not every N games: the cost per game differs ~15×
// between a laptop and Render's free CPU, so a game count can't promise a bounded pause.
const YIELD_AFTER_MS = 50;

// Returns null for games we don't keep: variants, custom start positions, aborted games,
// or movetext that doesn't parse. plyCounter is injectable so tests can count the calls and
// make them slow.
export function normalizeChessComGame(
  game: ChessComGame,
  usernameLower: string,
  plyCounter: (pgn: string) => number | null = countPliesFromText,
): NormalizedGame | null {
  const color = cheapCheck(game, usernameLower);
  if (!color || !game.pgn) return null;
  const me = color === "white" ? game.white : game.black;
  const opponent = color === "white" ? game.black : game.white;

  const sourceId = game.url.match(/\/game\/(.+)$/)?.[1];
  if (!sourceId) return null;
  const plies = plyCounter(game.pgn);
  if (plies === null || plies < 2) return null;

  const result = me.result === "win" ? "win" : DRAW_CODES.has(me.result) ? "draw" : "loss";
  const ecoUrl = pgnHeader(game.pgn, "ECOUrl");

  return {
    sourceId,
    playedAt: new Date(game.end_time * 1000),
    color,
    result,
    // The loser's code says how it ended ("resigned", "timeout"); for a draw both sides have it.
    termination: result === "win" ? opponent.result : me.result,
    timeControl: game.time_control,
    speed: SPEEDS.includes(game.time_class as Speed) ? (game.time_class as Speed) : speedFromTimeControl(game.time_control),
    playerRating: me.rating,
    opponentRating: opponent.rating,
    opponentName: opponent.username,
    pgn: game.pgn,
    plies,
    clocks: clocksFromPgn(game.pgn, plies),
    opening: {
      eco: pgnHeader(game.pgn, "ECO"),
      name: openingNameFromEcoUrl(ecoUrl),
    },
  };
}

// ".../openings/Sicilian-Defense-Open-2...Nc6" → "Sicilian Defense Open 2...Nc6".
// Chess.com sends ".../openings/Undefined" when the game has no named opening (seen on 17
// stored games, all ECO A00): that's no name, not an opening called "Undefined".
export function openingNameFromEcoUrl(ecoUrl: string | undefined): string | undefined {
  if (!ecoUrl) return undefined;
  let last = ecoUrl.split("/").pop() ?? "";
  try {
    last = decodeURIComponent(last);
  } catch {
    // a malformed %-escape: keep the raw text rather than failing the whole game
  }
  const name = last.replace(/-/g, " ").trim();
  return name && name.toLowerCase() !== "undefined" ? name : undefined;
}

// Archive URLs end in /YYYY/MM.
const monthKeyOf = (archiveUrl: string) => archiveUrl.slice(-7);
const monthKeyOfDate = (d: Date) => `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

export function createChessComImporter(
  client: PoliteClient,
  { plyCounter = countPliesFromText }: { plyCounter?: (pgn: string) => number | null } = {},
): Importer {
  const playerUrl = (username: string) => `${API}/${encodeURIComponent(username.toLowerCase())}`;

  return {
    async fetchProfile(username, signal) {
      const profile = await client.getJson<{ username: string; avatar?: string; country?: string }>(playerUrl(username), { signal });
      if (profile.status === 404 || !profile.data) return null;
      const stats = await client.getJson<Record<string, { last?: { rating?: number } } | undefined>>(
        `${playerUrl(username)}/stats`,
        { signal },
      );
      const rating = (key: string) => stats.data?.[key]?.last?.rating;
      const result: PlayerProfile = {
        username: profile.data.username,
        ratings: { blitz: rating("chess_blitz"), rapid: rating("chess_rapid"), bullet: rating("chess_bullet") },
        avatarUrl: profile.data.avatar,
        // "https://api.chess.com/pub/country/US" → "US"
        country: profile.data.country?.split("/").pop(),
      };
      return result;
    },

    async importGames({ username, maxGames, signal, known, checkpoint, onBatch }) {
      const usernameLower = username.toLowerCase();
      const state: ChessComCheckpoint = (checkpoint as ChessComCheckpoint | undefined) ?? { monthsDone: [], collected: 0 };
      const done = new Set(state.monthsDone);

      const archives = await client.getJson<{ archives: string[] }>(`${playerUrl(username)}/games/archives`, { signal });
      // Oldest first in the API; we want the newest games, so walk it backwards.
      const months = [...(archives.data?.archives ?? [])].reverse();
      // On a re-import, months before the newest stored game's month are already complete.
      const stopBefore = known.newestGameAt ? monthKeyOfDate(known.newestGameAt) : undefined;

      for (const url of months) {
        if (state.collected >= maxGames) break;
        const key = monthKeyOf(url);
        if (stopBefore && key < stopBefore) break;
        if (done.has(key)) continue;

        const etag = known.monthEtags[key];
        const fetchStart = Date.now();
        const res = await client.getJson<{ games: ChessComGame[] }>(url, {
          signal,
          headers: etag ? { "If-None-Match": etag } : {},
        });
        const fetchMs = Date.now() - fetchStart;
        const normalizeStart = Date.now();
        // 304: nothing changed in this month since we last fetched it.
        // A busy month has 1,000+ games. Cheap checks first, newest first, and normalize only
        // until we have the games we still need; a game that's rejected just means we take the
        // next one. Plies are counted from the PGN text (~0.03 ms a game), not by replaying it
        // with chess.js (~8 ms on a laptop, ~110–160 ms on Render's free CPU, which blocked
        // /api/health for seconds). The time-based yield is a safety net on top: blocking the
        // event loop would stall /api/health and SSE, and stop our own lease renewal.
        const candidates = (res.data?.games ?? [])
          .filter((g) => cheapCheck(g, usernameLower) !== null)
          .sort((a, b) => b.end_time - a.end_time);
        const needed = maxGames - state.collected;
        const games: NormalizedGame[] = [];
        let sliceStart = performance.now();
        for (let i = 0; i < candidates.length && games.length < needed; i++) {
          if (performance.now() - sliceStart >= YIELD_AFTER_MS) {
            await yieldToEventLoop();
            sliceStart = performance.now();
          }
          const game = normalizeChessComGame(candidates[i], usernameLower, plyCounter);
          if (game) games.push(game);
        }
        // Timings for the README and for comparing Render's CPU with a laptop's.
        logger.info("Chess.com month", {
          month: key,
          status: res.status,
          monthGames: res.data?.games.length ?? 0,
          candidates: candidates.length,
          kept: games.length,
          fetchMs,
          normalizeMs: Date.now() - normalizeStart,
        });

        done.add(key);
        state.monthsDone = [...done];
        state.collected += games.length;
        if (games[0]) state.newestGameAt = Math.max(state.newestGameAt ?? 0, games[0].playedAt.getTime());
        await onBatch({ games, checkpoint: { ...state }, month: { key, etag: res.etag } });
      }

      return { newestGameAt: state.newestGameAt ? new Date(state.newestGameAt) : undefined };
    },
  };
}
