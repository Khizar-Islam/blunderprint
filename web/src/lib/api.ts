// NEXT_PUBLIC_ variables are inlined into the browser bundle at build time.
// Strip a trailing slash so `${API_URL}/api/...` never has a double slash.
export const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

export const PLATFORMS = ["chesscom", "lichess"] as const;
export type Platform = (typeof PLATFORMS)[number];
export const PLATFORM_NAMES: Record<Platform, string> = { chesscom: "Chess.com", lichess: "Lichess" };
export const isPlatform = (value: string): value is Platform => (PLATFORMS as readonly string[]).includes(value);

// The same rules as the API's USERNAME_RULES (backend/src/routes/players.ts). Checking here
// only saves a request for an obvious typo; the API still decides.
const USERNAME_RULES: Record<Platform, RegExp> = {
  chesscom: /^[A-Za-z0-9_-]{3,25}$/,
  lichess: /^[A-Za-z0-9_-]{2,30}$/,
};
export const isValidUsername = (platform: Platform, username: string) => USERNAME_RULES[platform].test(username);

export interface Health {
  ok: boolean;
  db: boolean;
  queueDepth: number;
  version: string;
}

export interface Player {
  id: string;
  platform: Platform;
  username: string; // display case, from the platform
  profile?: { ratings?: { blitz?: number; rapid?: number; bullet?: number }; avatarUrl?: string; country?: string };
  importState: "idle" | "importing" | "ready" | "failed";
  lastImportedAt?: string;
  gamesCount: number;
  analysedCount: number;
}

// What GET /api/jobs/:id/stream sends in every event (backend/src/jobs/events.ts toPublicJob).
export interface PublicJob {
  id: string;
  type: string;
  status: "queued" | "running" | "done" | "failed";
  rev: number;
  attempts: number;
  maxAttempts: number;
  progress: { done: number; total?: number; message?: string };
  runAfter?: string;
  error?: { code: string; message: string };
}

export type Speed = "bullet" | "blitz" | "rapid" | "classical" | "daily";

// One row of GET /api/players/:platform/:username/games (the list projection: no PGN or evals).
export interface GameRow {
  id: string;
  sourceId: string;
  platform: Platform;
  playedAt: string;
  color: "white" | "black";
  result: "win" | "loss" | "draw";
  termination?: string;
  timeControl?: string;
  speed: Speed;
  playerRating?: number;
  opponentRating?: number;
  opponentName?: string;
  plies: number;
  opening?: { eco?: string; name?: string };
}

export interface GamesPage {
  games: GameRow[];
  nextCursor: string | null;
}

// A non-2xx answer from the API. `status` 0 means the request never got an answer (network
// error, CORS, or a server that is still waking up).
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// Every error body from the API is { error: "<safe message>" } (backend errorHandler).
async function getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch (err) {
    if (init.signal?.aborted) throw err; // let callers tell "cancelled" from "failed"
    throw new ApiError(0, "Can't reach the API");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, body?.error ?? `The API returned ${res.status}`);
  }
  return (await res.json()) as T;
}

const playerPath = (platform: Platform, username: string) =>
  `/api/players/${platform}/${encodeURIComponent(username)}`;

export function fetchHealth(signal: AbortSignal): Promise<Health> {
  return getJson<Health>("/api/health", { signal });
}

// player is null while a first import is still queued (the job creates the player once the
// platform confirms they exist). A 404 means: no player and no import.
export function fetchPlayer(platform: Platform, username: string, signal: AbortSignal) {
  return getJson<{ player: Player | null; activeJob: PublicJob | null }>(playerPath(platform, username), { signal });
}

export type StartImportResult = { kind: "job"; jobId: string } | { kind: "upToDate" };

// Retrying this call is safe: the route is idempotent. While an import for this player is
// queued or running, it returns that same job (a unique index on the job key guarantees one),
// so a double-click, a reload or a retry after a timeout never starts a second import.
export async function startImport(platform: Platform, username: string, signal: AbortSignal): Promise<StartImportResult> {
  const body = await getJson<{ jobId?: string; upToDate?: boolean }>(`${playerPath(platform, username)}/import`, {
    method: "POST",
    signal,
  });
  if (body.jobId) return { kind: "job", jobId: body.jobId };
  return { kind: "upToDate" };
}

export function fetchGames(platform: Platform, username: string, cursor: string | null, signal: AbortSignal) {
  const query = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
  return getJson<GamesPage>(`${playerPath(platform, username)}/games?${query}`, { signal });
}

export const jobStreamUrl = (jobId: string) => `${API_URL}/api/jobs/${encodeURIComponent(jobId)}/stream`;
