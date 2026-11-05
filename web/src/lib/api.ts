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
  // The list leaves out the evals (backend LIST_PROJECTION); classifications are enough for
  // the row's ribbon.
  analysis?: {
    status: "pending" | "claimed" | "done" | "imported" | "unanalysable";
    classifications?: MoveClass[];
    accuracy?: number;
  };
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
    // A machine-readable reason when the API sends one ({ error, code }), e.g. the coach's
    // "not_enough_games" or "ai_budget_exhausted" (backend agent/friendly.ts).
    readonly code?: string,
  ) {
    super(message);
  }
}

// Every error body from the API is { error: "<safe message>" }, plus a `code` on the coach
// routes (backend errorHandler, agent/friendly.ts).
async function getJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { cache: "no-store", ...init });
  } catch (err) {
    if (init.signal?.aborted) throw err; // let callers tell "cancelled" from "failed"
    throw new ApiError(0, "Can't reach the API");
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string; code?: string } | null;
    throw new ApiError(res.status, body?.error ?? `The API returned ${res.status}`, body?.code);
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

// GET /api/games/:id: one game with PGN, clocks and the full analysis (backend routes/games.ts).
export interface GameDetail extends Omit<GameRow, "analysis"> {
  pgn: string;
  clocks?: number[];
  analysis: {
    status: "pending" | "claimed" | "done" | "imported" | "unanalysable";
    evals?: { cp?: number; mate?: number }[]; // per ply, White's view
    best?: (string | null)[]; // engine's move before each ply (imported Lichess: judged plies only)
    classifications?: MoveClass[];
    accuracy?: number;
    error?: { code: string; atPly?: number };
  };
}

export function fetchGame(id: string, signal: AbortSignal) {
  return getJson<{ game: GameDetail; player: { platform: Platform; username: string } | null }>(
    `/api/games/${encodeURIComponent(id)}`,
    { signal },
  );
}

export const jobStreamUrl = (jobId: string) => `${API_URL}/api/jobs/${encodeURIComponent(jobId)}/stream`;

// ── Browser engine analysis (backend/src/routes/analysis.ts) ─────────────────────────────

export type MoveClass = "best" | "good" | "inaccuracy" | "mistake" | "blunder";

export interface AnalysisClaim {
  claimId: string; // the lease: only this token may post these games' results
  expiresAt: string;
  engine: string;
  games: { id: string; pgn: string; plies: number; color: "white" | "black" }[];
}

const postJson = <T>(path: string, body: unknown, init: RequestInit = {}) =>
  getJson<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...init,
  });

// Leases up to 3 of the player's unanalysed games (newest first, `prefer` first) to this tab.
export function claimAnalysis(platform: Platform, username: string, prefer?: string, signal?: AbortSignal) {
  return postJson<AnalysisClaim>("/api/analysis/claim", { platform, username, prefer }, { signal });
}

// One game's result. 409 = the lease is gone (another tab reclaimed the game): drop it.
// No abort signal on purpose: a finished analysis is worth saving even while pausing.
// keepalive: the browser finishes the request even if the tab closes meanwhile (allowed for
// bodies up to 64 KB; a result is at most ~20 KB, see MAX_PLIES in the route).
export function postAnalysisResult(claimId: string, result: object) {
  return postJson<{ ok: true; alreadyDone?: boolean; classifications?: MoveClass[]; accuracy?: number }>(
    "/api/analysis/results",
    { claimId, ...result },
    { keepalive: true },
  );
}

// Hands unfinished games back so the next tab can take them at once instead of waiting out
// the 10-minute lease. `beacon` is for a closing page: navigator.sendBeacon still delivers
// after the page is gone, but only as a "simple" request (text/plain body, no preflight), so
// the route parses the JSON itself. Best effort either way: an expired lease frees them too.
export function releaseAnalysis(claimId: string, gameIds: string[], { beacon = false } = {}): void {
  if (gameIds.length === 0) return;
  const url = `${API_URL}/api/analysis/release`;
  const body = JSON.stringify({ claimId, gameIds });
  if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon?.(url, new Blob([body], { type: "text/plain" }))) {
    return;
  }
  // keepalive lets the request finish even if the page navigates away meanwhile.
  fetch(url, { method: "POST", headers: { "Content-Type": "text/plain" }, body, keepalive: true }).catch(() => {});
}

// ── Patterns summary (backend/src/stats/summary.ts, SUMMARY_VERSION 2) ───────────────────

export type ErrorKind = "inaccuracy" | "mistake" | "blunder";
export type KindCounts = Record<ErrorKind, number>;

export interface Rate extends KindCounts {
  total: number;
  moves: number; // the player's moves in the bucket: the per-100 denominator
  perGame: number | null;
  per100: number | null;
}

export type SquareCount = KindCounts & { square: string; total: number };

export interface Summary {
  version: number;
  generatedAt: string;
  filters: { color?: "white" | "black"; speed?: Speed; from?: string; to?: string };
  totals: {
    games: number; // every game in the filter, analysed or not
    analysed: number; // games with features: the base of every rate
    moves: number;
    mistakes: KindCounts & { total: number };
    firstPlayedAt: string | null;
    lastPlayedAt: string | null;
  };
  openings: {
    eco: string | null;
    name: string | null;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    score: number; // 0–100
    analysed: number;
    mistakesPerGame: number | null;
  }[];
  byPhase: ({ phase: "opening" | "middlegame" | "endgame" } & Rate)[];
  bySpeed: ({ speed: Speed; games: number } & Rate)[];
  byClock: ({ bucket: "over50" | "from25to50" | "from10to25" | "under10" } & Rate)[];
  byMoveNumber: ({ bucket: string } & Rate)[];
  // All 64 squares per colour the player had, a1, b1 … h8, on the real board.
  squares: Record<"white" | "black", SquareCount[]>;
  // One per analysed game, newest first. classes: one letter per ply, both sides
  // (b best, g good, i inaccuracy, m mistake, x blunder).
  ribbons: { gameId: string; playedAt: string; color: "white" | "black"; result: "win" | "loss" | "draw"; speed: Speed; classes: string }[];
}

// extracting: some analysed games have no features yet, so the numbers will still change.
export interface SummaryResponse {
  summary: Summary;
  cached: boolean;
  extracting: boolean;
}

// `query` is the API query string (lib/filters.ts apiQuery), "" for the unfiltered summary.
export function fetchSummary(platform: Platform, username: string, query: string, signal: AbortSignal) {
  return getJson<SummaryResponse>(`${playerPath(platform, username)}/summary${query ? `?${query}` : ""}`, { signal });
}

// ---- The coach (backend routes/coach.ts, routes/runs.ts) ------------------------------------

export type CoachMeasure = "per100Moves" | "inaccuracyPer100" | "mistakePer100" | "blunderPer100" | "errorsPerGame" | "scorePct";

// The pattern's statistic, copied by the verifier from the code-found candidate.
export interface CoachStat {
  measure: CoachMeasure;
  value: number;
  unit: "per100" | "perGame" | "percent";
  baseline: number; // the player's own overall figure for the same measure
  direction: "higherIsWorse" | "lowerIsWorse";
  gapPct: number;
  games: number;
  moves?: number;
  errors?: number;
}

// The situation of one evidence position, computed by code (not written by the model).
export interface EvidenceFacts {
  speed: string | null;
  phase: string | null;
  clockBucket: string | null;
  clockLeftSeconds: number | null;
  opening: { eco: string; name: string | null } | null;
}

export interface CoachEvidence {
  gameId: string;
  ply: number;
  moveNumber: number;
  kind: ErrorKind;
  played: string;
  betterMove: string | null;
  playedUci: string | null;
  betterUci: string | null;
  winPctLost: number;
  fen: string; // the position BEFORE the move (4-field FEN)
  color: "white" | "black" | null;
  facts: EvidenceFacts;
  // The whole game's classifications, one letter per ply (b/g/i/m/x); null in reports saved
  // before the lens existed.
  ribbon?: string | null;
}

export interface CoachPattern {
  candidateId: string;
  title: string;
  explanation: string;
  drill: string;
  stat: CoachStat;
  evidence: CoachEvidence[];
}

export interface CoachReport {
  id: string;
  runId: string | null;
  generatedAt: string;
  model: string; // the model asked for
  answeredBy: string; // the model that wrote it (the fallback if the run switched)
  promptVersion: number;
  analysedGames: number;
  patterns: CoachPattern[];
  noPatternsMessage?: string;
}

// GET /api/players/:platform/:username/report
export interface CoachInfo {
  report: CoachReport | null;
  stale: boolean;
  staleReason: "new_games" | "new_version" | null;
  newGames: number;
  eligibility: { analysed: number; needed: number; ok: boolean };
  activeRun: { runId: string; status: string } | null;
  ai: { enabled: boolean; budgetLeft: number; canStart: boolean };
}

export type TraceKind = "model" | "tool" | "verify" | "repair" | "retry" | "switch";

// One line of the agent trace (backend agent/loop.ts TraceStep).
export interface TraceStep {
  n: number;
  kind: TraceKind;
  label: string;
  detail: string;
  ms: number;
  tokens?: number;
}

// What the run stream sends (backend agent/runs.ts toPublicRun).
export interface PublicRun {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  rev: number;
  attempt: number;
  model: string;
  steps: TraceStep[];
  usage?: { calls: number; totalTokens: number };
  error?: { code: string; message: string };
  report?: CoachReport;
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
}

export function fetchCoachInfo(platform: Platform, username: string, signal: AbortSignal) {
  return getJson<CoachInfo>(`${playerPath(platform, username)}/report`, { signal });
}

export type StartReportResult = { kind: "run"; runId: string } | { kind: "cached"; report: CoachReport };

// POST: 202 { runId } (a new run, or the one already going) or 200 { report, cached }. The
// refusals (409 not_enough_games, 503 ai_disabled, 429 ai_budget_exhausted) arrive as
// ApiError with their code and friendly message.
export async function startReport(platform: Platform, username: string, signal?: AbortSignal): Promise<StartReportResult> {
  const body = await getJson<{ runId?: string; report?: CoachReport }>(`${playerPath(platform, username)}/report`, { method: "POST", signal });
  if (body.runId) return { kind: "run", runId: body.runId };
  return { kind: "cached", report: body.report! };
}

export const runStreamUrl = (runId: string) => `${API_URL}/api/runs/${encodeURIComponent(runId)}/stream`;

// A finished run's trace, for "How this report was made". The run stream always starts with a
// snapshot (for a finished run it's the only event), so we read up to that one message and
// stop. null when the run has expired (14-day TTL) or isn't finished.
export async function fetchFinishedRun(runId: string, signal: AbortSignal): Promise<PublicRun | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, 10_000);
  try {
    let res: Response;
    try {
      res = await fetch(runStreamUrl(runId), { signal: controller.signal, cache: "no-store" });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new ApiError(0, "Can't reach the API");
    }
    if (res.status === 404) return null;
    if (!res.ok || !res.body) throw new ApiError(res.status, `The API returned ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      // SSE messages end with a blank line, so every part before the last "\n\n" is complete.
      const complete = buffer.split("\n\n").slice(0, -1);
      const snapshot = complete.find((block) => block.includes("event: snapshot"));
      const data = snapshot?.split("\n").find((line) => line.startsWith("data: "));
      if (data) {
        const run = JSON.parse(data.slice(6)) as PublicRun;
        return run.status === "done" || run.status === "failed" ? run : null;
      }
      if (done) return null;
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    controller.abort(); // stop reading the stream (a finished run's has already ended)
  }
}
