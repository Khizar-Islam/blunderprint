import { Chess } from "chess.js";
import type { Color, Result, Speed } from "../db/models/game.js";

// A game as both importers hand it to the import job, already from the player's point of view.
export interface NormalizedGame {
  sourceId: string;
  playedAt: Date;
  color: Color;
  result: Result;
  termination?: string;
  timeControl?: string;
  speed: Speed;
  playerRating?: number;
  opponentRating?: number;
  opponentName?: string;
  pgn: string;
  plies: number;
  clocks?: number[];
  opening?: { eco?: string; name?: string; ply?: number };
  // Only set when the platform already analysed the game (Lichess): stored as "imported".
  evals?: { cp?: number; mate?: number }[];
}

export interface PlayerProfile {
  username: string; // display case
  ratings: { blitz?: number; rapid?: number; bullet?: number };
  avatarUrl?: string;
  country?: string;
}

export interface ImportBatch<C> {
  games: NormalizedGame[];
  checkpoint: C;
  // Chess.com only: the month just fetched and its ETag, for the next re-import.
  month?: { key: string; etag?: string };
}

export interface ImportGamesInput {
  username: string;
  maxGames: number;
  signal: AbortSignal;
  // From the player document: what earlier imports already fetched.
  known: { newestGameAt?: Date; monthEtags: Record<string, string> };
  // From the job, when it's resuming after a crash or restart.
  checkpoint?: unknown;
  // Called after each chunk (a Chess.com month, 50 Lichess games). The handler stores the
  // games, then the checkpoint, so a resume never skips games it didn't store.
  onBatch(batch: ImportBatch<unknown>): Promise<void>;
}

export interface Importer {
  // null when the user doesn't exist (or the account is closed).
  fetchProfile(username: string, signal: AbortSignal): Promise<PlayerProfile | null>;
  // Returns the newest game time seen, for the next re-import.
  importGames(input: ImportGamesInput): Promise<{ newestGameAt?: Date }>;
}

// Counts the plies by replaying the PGN with chess.js. Returns null when it doesn't replay:
// the game review and the engine both need a PGN that does, so such a game is skipped.
export function countPlies(pgn: string): number | null {
  try {
    const chess = new Chess();
    chess.loadPgn(pgn);
    return chess.history().length;
  } catch {
    return null;
  }
}

// Lichess's speed buckets, from estimated duration = initial + 40 × increment (seconds).
// Used when Chess.com doesn't say time_class. Source: lichess-org/scalachess, Speed.scala
// (ranges: bullet 30–179, blitz 180–479, rapid 480–1499) and Clock.estimateTotalSeconds.
// Ultrabullet (< 30 s) is folded into bullet, as our speed list has no ultrabullet.
export function speedFromTimeControl(timeControl: string): Speed {
  if (timeControl.includes("/")) return "daily"; // Chess.com daily, e.g. "1/259200"
  const [initial, increment = "0"] = timeControl.split("+");
  const estimate = Number(initial) + 40 * Number(increment);
  if (!Number.isFinite(estimate)) return "blitz";
  if (estimate < 180) return "bullet";
  if (estimate < 480) return "blitz";
  if (estimate < 1500) return "rapid";
  return "classical";
}

// "h:mm:ss" or "h:mm:ss.s" from a [%clk ...] comment, in seconds.
function parseClock(value: string): number {
  const [h, m, s] = value.split(":").map(Number);
  return Math.round((h * 3600 + m * 60 + s) * 10) / 10;
}

// Chess.com puts the clock after every move as {[%clk 0:02:59.9]}. One per ply, in order.
// Returns undefined unless every ply has one, so clocks[i] always lines up with ply i.
export function clocksFromPgn(pgn: string, plies: number): number[] | undefined {
  const clocks = [...pgn.matchAll(/\[%clk (\d+:\d{1,2}:\d{1,2}(?:\.\d+)?)\]/g)].map((m) => parseClock(m[1]));
  return clocks.length === plies ? clocks : undefined;
}

export function pgnHeader(pgn: string, name: string): string | undefined {
  const match = pgn.match(new RegExp(`^\\[${name} "([^"]*)"\\]`, "m"));
  return match?.[1];
}
