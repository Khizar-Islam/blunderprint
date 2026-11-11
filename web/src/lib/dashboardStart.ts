import { ApiError, fetchPlayer, startImport, type ImportTrigger, type Platform, type Player } from "./api";
import { prefetchSummary } from "./summaryPrefetch";

// What the dashboard's first request settles on (components/PlayerDashboard.tsx).
export interface Start {
  player: Player | null;
  jobId: string | null; // the import to follow, if one is queued or running
  // A stored player's refresh was refused by a guard (the visitor's import limit, a full queue):
  // the dashboard still shows the stored games, with this note. Only set when a player exists.
  importRefused?: { code: string; message: string };
}

// The guards' refusals (backend agent/friendly.ts, Stage 6): a real answer, not a failure.
export const IMPORT_REFUSALS = ["limit_imports", "limit_new_players", "storage_full", "busy", "limit_requests"];
// A plain boolean (not a type guard): a guard's false branch would narrow an ApiError to never.
export const isImportRefusal = (err: unknown): boolean =>
  err instanceof ApiError && err.code !== undefined && IMPORT_REFUSALS.includes(err.code);

export interface StartDeps {
  fetchPlayer: typeof fetchPlayer;
  startImport: typeof startImport;
  prefetchSummary: (platform: Platform, username: string, query: string) => void;
}

const realDeps: StartDeps = { fetchPlayer, startImport, prefetchSummary };

// 1. The summary starts at once, in parallel (lib/summaryPrefetch.ts): it doesn't depend on the
//    two requests below. `summaryQuery` is the URL's filters as the patterns section will ask.
// 2. GET player → { player, activeJob }. As soon as it answers with a stored player, `onPlayer`
//    hands it to the dashboard, which renders the patterns and games then instead of waiting for
//    step 3 (the import check can't change what's stored yet; if it starts an import, the
//    dashboard follows it and refreshes when it finishes, as before).
// 3. With no active import, POST one: the API answers 202 with a job, or 200 { upToDate } when
//    the last import is under 6 h old (always, for a frozen demo player). Both are safe to
//    repeat, so the waking hook may retry this while Render wakes. A refusal by a guard (Stage 6)
//    for a STORED player isn't an error: their games are still there, so the dashboard shows them
//    with a note. For a new player it is thrown, and the dashboard shows the message.
export async function startDashboard(
  platform: Platform,
  username: string,
  summaryQuery: string,
  signal: AbortSignal,
  onPlayer: (player: Player) => void = () => {},
  deps: StartDeps = realDeps,
  // "auto" when the page loads, "user" after a click on Try again / Retry.
  trigger: ImportTrigger = "auto",
): Promise<Start> {
  deps.prefetchSummary(platform, username, summaryQuery);
  let found: Awaited<ReturnType<typeof fetchPlayer>> | null = null;
  try {
    found = await deps.fetchPlayer(platform, username, signal);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) throw err; // 404: never imported
  }
  if (found?.player && !signal.aborted) onPlayer(found.player);
  if (found?.activeJob) return { player: found.player, jobId: found.activeJob.id };
  let result: Awaited<ReturnType<typeof startImport>>;
  try {
    result = await deps.startImport(platform, username, signal, trigger);
  } catch (err) {
    if (found?.player && err instanceof ApiError && isImportRefusal(err)) {
      return { player: found.player, jobId: null, importRefused: { code: err.code!, message: err.message } };
    }
    throw err;
  }
  return { player: found?.player ?? null, jobId: result.kind === "job" ? result.jobId : null };
}
